const Parser = require('rss-parser');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const http = require('http');

// ========== الإعدادات ==========
const BOT_TOKEN = process.env.BOT_TOKEN || '8980684818:AAF-s0ad8H83DIr-0-WexPyRJ4ssO8fa-e0';
const CHANNEL_ID = process.env.CHANNEL_ID || '@EGIIIU';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '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';
const GITHUB_OWNER = 'ik3iii';
const GITHUB_REPO = 'My-web';
const GITHUB_FILE_PATH = 'news_fingerprints.json';

const PORT = process.env.PORT || 3000;

// ========== نسخ Nitter الموثوقة (قد تتغير، اختبر أياً منها) ==========
const NITTER_INSTANCES = [
  'https://nitter.privacydev.net',
  'https://nitter.it',
  'https://nitter.poast.org',
  'https://nitter.net',  // الأصلي قد يكون محظورًا
];

// ========== حسابات X العراقية ==========
const X_USERS = [
  'INA_Iraq',
  'ShafaqNews',
  'alsumaria_news',
  'Rudaw_arabic',
  'BaghdadToday_',
  'AlforatNews',
  'aletejahtv',
  'INA__iraq',
];

// ========== بناء روابط RSS ديناميكيًا ==========
function buildRssUrls() {
  const urls = [];
  for (const instance of NITTER_INSTANCES) {
    for (const user of X_USERS) {
      urls.push(`${instance}/${user}/rss`);
    }
  }
  return urls;
}

let RSS_SOURCES = buildRssUrls();

const FETCH_INTERVAL_MINUTES = 5;
const SEND_DELAY_MS = { min: 2000, max: 5000 };
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TelegramNewsBot/1.0)' }
});

const sentFingerprints = new Set();
let githubFileSha = null;
let saveTimeout = null;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = () => sleep(Math.floor(Math.random() * (SEND_DELAY_MS.max - SEND_DELAY_MS.min + 1)) + SEND_DELAY_MS.min);

const agent = new https.Agent({ keepAlive: true, family: 4 });
const telegramAxios = axios.create({ timeout: 20000, httpsAgent: agent });
const githubAxios = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'IQ-News-Bot'
  },
  timeout: 12000
});

// ========== دوال GitHub (محسّنة) ==========
async function loadFingerprints() {
  try {
    const res = await githubAxios.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`);
    githubFileSha = res.data.sha;
    const raw = Buffer.from(res.data.content, 'base64').toString('utf-8').trim();
    let arr = [];
    if (raw) {
      try { arr = JSON.parse(raw); } catch { console.warn('[GITHUB] JSON تالف، إعادة إنشاء.'); await createEmptyFile(); return; }
    }
    if (Array.isArray(arr)) {
      arr.forEach(fp => sentFingerprints.add(fp));
      console.log(`[GITHUB] تم تحميل ${arr.length} بصمة.`);
    }
  } catch (err) {
    if (err.response?.status === 404) {
      await createEmptyFile();
    } else {
      console.error('[GITHUB] فشل التحميل:', err.message);
    }
  }
}

async function createEmptyFile() {
  const content = Buffer.from('[]').toString('base64');
  const res = await githubAxios.put(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`, {
    message: 'Initialize news_fingerprints.json',
    content
  });
  githubFileSha = res.data.content.sha;
  console.log('[GITHUB] تم إنشاء ملف بصمات.');
}

async function saveFingerprints() {
  if (!githubFileSha) {
    await loadFingerprints().catch(() => {});
    if (!githubFileSha) return;
  }
  try {
    const arr = Array.from(sentFingerprints);
    const content = Buffer.from(JSON.stringify(arr)).toString('base64');
    const res = await githubAxios.put(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`, {
      message: `تحديث البصمات - ${new Date().toISOString()}`,
      content,
      sha: githubFileSha
    });
    githubFileSha = res.data.content.sha;
    console.log(`[GITHUB] تم حفظ ${arr.length} بصمة.`);
  } catch (err) {
    console.error('[GITHUB] فشل الحفظ:', err.message);
    if (err.response?.status === 409) await loadFingerprints().catch(() => {});
  }
}

// ========== دوال Telegram ==========
async function callTelegram(method, params) {
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await telegramAxios.post(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, params);
      if (res.data?.ok) return res.data;
      throw new Error(res.data.description || 'خطأ');
    } catch (err) {
      console.error(`[TG] ${method} محاولة ${i}: ${err.message}`);
      if (i < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error('فشل الاتصال بتليجرام');
}

async function sendMessage(text, options = {}) {
  return callTelegram('sendMessage', {
    chat_id: CHANNEL_ID,
    text,
    parse_mode: options.parse_mode || 'Markdown',
    disable_web_page_preview: true
  });
}

async function sendPhoto(photoUrl, caption, options = {}) {
  return callTelegram('sendPhoto', {
    chat_id: CHANNEL_ID,
    photo: photoUrl,
    caption,
    parse_mode: options.parse_mode || 'Markdown'
  });
}

// ========== جلب RSS مع تجربة عدة نسخ ==========
async function fetchFeed(url) {
  // url مثل: https://nitter.instance/USER/rss
  try {
    const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'text' });
    return await parser.parseString(res.data.replace(/^\uFEFF/, ''));
  } catch (e1) {
    // نجرب parseURL مباشرة
    try {
      return await parser.parseURL(url);
    } catch (e2) {
      throw new Error(`فشل جلب ${url}`);
    }
  }
}

function extractImage(item) {
  const html = item['content:encoded'] || item.content || item.summary || '';
  const img = html.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp|gif))["']/i);
  if (img) return img[1];
  const url = html.match(/(https?:\/\/[^\s<>"]+\.(?:jpg|jpeg|png|webp|gif))/i);
  return url ? url[1] : null;
}

const hasBayyan = (item) => /بيان/.test((item.title || '') + ' ' + (item.contentSnippet || ''));

function getFingerprint(item) {
  const title = (item.title || '').trim();
  const desc = (item.contentSnippet || item.summary || item.content || '').replace(/<[^>]+>/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').substring(0, 60);
  return crypto.createHash('sha256').update(title + '|' + desc).digest('hex');
}

// معالجة خبر واحد
async function processItem(item) {
  const fp = getFingerprint(item);
  if (sentFingerprints.has(fp)) {
    console.log(`[SKIP DUPLICATE] ${item.title}`);
    return;
  }

  let title = (item.title || 'خبر').replace(/^[A-Za-z0-9_]+:\s*/, '');
  const emoji = ['🇮🇶','🔥','🚨','📌','⚡','🔴','📰','🌍'][Math.floor(Math.random()*8)];
  let caption = `${emoji} *${title}*`;
  if (hasBayyan(item) && item.link) caption += `\n\n[🔗 التفاصيل](${item.link})`;
  const img = extractImage(item);

  try {
    if (img) await sendPhoto(img, caption, { parse_mode: 'Markdown' });
    else await sendMessage(caption, { parse_mode: 'Markdown' });
    console.log(`[SENT] ${title}`);
  } catch (err) {
    console.error(`[SKIP] ${title}:`, err.message);
    return;
  }

  sentFingerprints.add(fp);
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => saveFingerprints().catch(() => {}), 5000);
}

// معالجة مصدر واحد (يجمع كل الأخبار منه)
async function processSource(url) {
  try {
    const feed = await fetchFeed(url);
    if (!feed?.items?.length) return;
    console.log(`[FETCH] ${url} - ${feed.items.length} خبر`);
    for (const item of feed.items) {
      await processItem(item).catch(() => {});
      await randomDelay();
    }
  } catch (err) {
    // لن نطبع خطأ لكل محاولة، فقط إذا فشلت كل النسخ لمستخدم معين سنرى
  }
}

// الدورة الرئيسية
async function mainCycle() {
  console.log(`\n=== دورة ${new Date().toISOString()} ===`);
  // نعيد بناء الروابط كل دورة تحسبًا لتغيير النسخ
  RSS_SOURCES = buildRssUrls();
  let totalFetched = 0;
  for (const src of RSS_SOURCES) {
    // نمرر كل رابط (نسخة/مستخدم) ونحاول
    try {
      const feed = await fetchFeed(src);
      if (feed?.items?.length) {
        console.log(`[FETCH] ${src} - ${feed.items.length} خبر`);
        for (const item of feed.items) {
          await processItem(item).catch(() => {});
          await randomDelay();
        }
        totalFetched += feed.items.length;
      }
    } catch {}
    await sleep(500); // استراحة قصيرة بين المحاولات
  }
  console.log(`[INFO] إجمالي الأخبار المجلوبة في هذه الدورة: ${totalFetched}`);
  console.log('=== انتهت الدورة ===\n');
}

// خادم HTTP
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(PORT, () => console.log(`🌐 خادم على ${PORT}`));

// بدء التشغيل
async function start() {
  console.log('🚀 بوت X مع نسخ Nitter متعددة');
  await loadFingerprints().catch(() => {});

  // دورة فورية أولى
  await mainCycle();

  // جدولة
  setInterval(async () => {
    await mainCycle();
  }, FETCH_INTERVAL_MINUTES * 60000);

  // حفظ احتياطي كل 3 دقائق
  setInterval(async () => {
    if (sentFingerprints.size > 0) await saveFingerprints().catch(() => {});
  }, 3 * 60000);
}

process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));
process.on('unhandledRejection', (reason) => console.error('[REJECTION]', reason));

start();});

// ========== ذاكرة البصمات (سيتم ملؤها من GitHub) ==========
const sentFingerprints = new Set();
let githubFileSha = null;
let saveTimeout = null; // لحفظ دوري

// أدوات مساعدة
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = () => sleep(Math.floor(Math.random() * (SEND_DELAY_MS.max - SEND_DELAY_MS.min + 1)) + SEND_DELAY_MS.min);

// ========== إعداد اتصال محسّن ==========
const agent = new https.Agent({ keepAlive: true, family: 4 });
const telegramAxios = axios.create({ timeout: 20000, httpsAgent: agent });
const githubAxios = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'IQ-News-Bot'
  },
  timeout: 12000
});

// ========== دوال GitHub (محسّنة) ==========
async function loadFingerprints() {
  try {
    const res = await githubAxios.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`);
    githubFileSha = res.data.sha;
    const raw = Buffer.from(res.data.content, 'base64').toString('utf-8').trim();
    let arr = [];
    if (raw) {
      try {
        arr = JSON.parse(raw);
      } catch {
        console.warn('[GITHUB] ملف JSON تالف، سيتم إعادة إنشائه.');
        await createEmptyFile();
        return;
      }
    }
    if (Array.isArray(arr)) {
      arr.forEach(fp => sentFingerprints.add(fp));
      console.log(`[GITHUB] تم تحميل ${arr.length} بصمة.`);
    }
  } catch (err) {
    if (err.response?.status === 404) {
      console.log('[GITHUB] الملف غير موجود، إنشاء جديد...');
      await createEmptyFile();
    } else {
      console.error('[GITHUB] فشل التحميل (سنبدأ بذاكرة فارغة):', err.message);
      // لا نتوقف، نبدأ بذاكرة فارغة
    }
  }
}

async function createEmptyFile() {
  const content = Buffer.from('[]').toString('base64');
  const res = await githubAxios.put(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`, {
    message: 'Initialize news_fingerprints.json',
    content
  });
  githubFileSha = res.data.content.sha;
  console.log('[GITHUB] تم إنشاء ملف بصمات جديد.');
}

async function saveFingerprints() {
  if (!githubFileSha) {
    // إذا لم يكن لدينا SHA، نحاول تحميله أولاً
    await loadFingerprints().catch(() => {});
    if (!githubFileSha) return;
  }
  try {
    const arr = Array.from(sentFingerprints);
    const content = Buffer.from(JSON.stringify(arr)).toString('base64');
    const res = await githubAxios.put(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`, {
      message: `تحديث البصمات - ${new Date().toISOString()}`,
      content,
      sha: githubFileSha
    });
    githubFileSha = res.data.content.sha;
    console.log(`[GITHUB] تم حفظ ${arr.length} بصمة.`);
  } catch (err) {
    console.error('[GITHUB] فشل الحفظ:', err.message);
    if (err.response?.status === 409) {
      // تضارب في SHA، نعيد تحميل الملف ثم نحاول الحفظ لاحقًا
      await loadFingerprints().catch(() => {});
    }
  }
}

// ========== دوال Telegram ==========
async function callTelegram(method, params) {
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await telegramAxios.post(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, params);
      if (res.data?.ok) return res.data;
      throw new Error(res.data.description || 'خطأ');
    } catch (err) {
      console.error(`[TG] ${method} محاولة ${i}: ${err.message}`);
      if (i < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error('فشل الاتصال بتليجرام');
}

async function sendMessage(text, options = {}) {
  return callTelegram('sendMessage', {
    chat_id: CHANNEL_ID,
    text,
    parse_mode: options.parse_mode || 'Markdown',
    disable_web_page_preview: true
  });
}

async function sendPhoto(photoUrl, caption, options = {}) {
  return callTelegram('sendPhoto', {
    chat_id: CHANNEL_ID,
    photo: photoUrl,
    caption,
    parse_mode: options.parse_mode || 'Markdown'
  });
}

// ========== دوال RSS (خاصة بـ Nitter) ==========
async function fetchFeed(url) {
  try {
    const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'text' });
    return await parser.parseString(res.data.replace(/^\uFEFF/, ''));
  } catch {}
  try {
    return await parser.parseURL(url);
  } catch {}
  throw new Error('فشل جلب الخلاصة');
}

function extractImage(item) {
  const html = item['content:encoded'] || item.content || item.summary || '';
  const img = html.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp|gif))["']/i);
  if (img) return img[1];
  const url = html.match(/(https?:\/\/[^\s<>"]+\.(?:jpg|jpeg|png|webp|gif))/i);
  return url ? url[1] : null;
}

const hasBayyan = (item) => /بيان/.test((item.title || '') + ' ' + (item.contentSnippet || ''));

function getFingerprint(item) {
  const title = (item.title || '').trim();
  const desc = (item.contentSnippet || item.summary || item.content || '').replace(/<[^>]+>/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').substring(0, 60);
  return crypto.createHash('sha256').update(title + '|' + desc).digest('hex');
}

async function processItem(item) {
  const fp = getFingerprint(item);
  if (sentFingerprints.has(fp)) {
    console.log(`[SKIP DUPLICATE] ${item.title}`);
    return;
  }

  let title = item.title || 'خبر';
  // Nitter يصيغ العنوان كـ "username: النص"، نزيل اسم المستخدم
  title = title.replace(/^[A-Za-z0-9_]+:\s*/, '');

  const emoji = ['🇮🇶','🔥','🚨','📌','⚡','🔴','📰','🌍'][Math.floor(Math.random()*8)];
  let caption = `${emoji} *${title}*`;
  if (hasBayyan(item) && item.link) caption += `\n\n[🔗 التفاصيل](${item.link})`;
  const img = extractImage(item);

  try {
    if (img) await sendPhoto(img, caption, { parse_mode: 'Markdown' });
    else await sendMessage(caption, { parse_mode: 'Markdown' });
    console.log(`[SENT] ${title}`);
  } catch (err) {
    console.error(`[SKIP] ${title}:`, err.message);
    return; // لا نضيف البصمة إذا فشل الإرسال
  }

  // أضف البصمة واحفظ فورًا
  sentFingerprints.add(fp);
  // حفظ فوري بعد كل خبر جديد (مع تأخير بسيط لتجميع عدة أخبار)
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveFingerprints().catch(() => {});
  }, 5000); // حفظ بعد 5 ثوانٍ من آخر خبر
}

async function processSource(url) {
  try {
    const feed = await fetchFeed(url);
    if (!feed?.items?.length) return;
    console.log(`[FETCH] ${url} - ${feed.items.length} خبر`);
    for (const item of feed.items) {
      await processItem(item).catch(() => {});
      await randomDelay();
    }
  } catch (err) {
    console.error(`[RSS ERROR] ${url}:`, err.message);
  }
}

async function mainCycle() {
  console.log(`\n=== دورة ${new Date().toISOString()} ===`);
  for (const src of RSS_SOURCES) {
    await processSource(src).catch(() => {});
    await sleep(1000);
  }
  console.log('=== انتهت الدورة ===\n');
}

// خادم HTTP
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(PORT, () => console.log(`🌐 خادم على ${PORT}`));

// ========== بدء التشغيل ==========
async function start() {
  console.log('🚀 تشغيل بوت أخبار X (Nitter RSS)');
  
  // تحميل البصمات من GitHub
  await loadFingerprints().catch(() => {});

  // تشغيل الدورة الأولى
  await mainCycle().catch(err => console.error('[دورة فاشلة]', err.message));

  // جدولة الدورات
  setInterval(async () => {
    await mainCycle().catch(err => console.error('[دورة فاشلة]', err.message));
  }, FETCH_INTERVAL_MINUTES * 60000);

  // حفظ دوري احتياطي كل 3 دقائق
  setInterval(async () => {
    if (sentFingerprints.size > 0) {
      await saveFingerprints().catch(() => {});
    }
  }, 3 * 60000);
}

process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));
process.on('unhandledRejection', (reason) => console.error('[REJECTION]', reason));

start();
