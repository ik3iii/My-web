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

// ========== مصادر جديدة من X عبر Nitter RSS (عراقية) ==========
const RSS_SOURCES = [
  // وكالة الأنباء العراقية
  'https://nitter.net/INA_Iraq/rss',
  // شفق نيوز
  'https://nitter.net/ShafaqNews/rss',
  // السومرية نيوز
  'https://nitter.net/alsumaria_news/rss',
  // روداوو
  'https://nitter.net/Rudaw_arabic/rss',
  // بغداد اليوم
  'https://nitter.net/BaghdadToday_/rss',
  // الفرات نيوز
  'https://nitter.net/AlforatNews/rss',
  // الاتجاه
  'https://nitter.net/aletejahtv/rss',
  // واع (بديل)
  'https://nitter.net/INA__iraq/rss',
];

// إذا أردت إضافة أي حساب X آخر، فقط أضف رابطه بهذا الشكل:
// 'https://nitter.net/اسم_المستخدم/rss'

const FETCH_INTERVAL_MINUTES = 5;
const SEND_DELAY_MS = { min: 2000, max: 5000 };
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TelegramNewsBot/1.0)' }
});

const sentFingerprints = new Set();
let pendingSaveCount = 0;
let githubFileSha = null;

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

// ========== دوال GitHub ==========
async function loadFingerprints() {
  try {
    const res = await githubAxios.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`);
    githubFileSha = res.data.sha;
    const raw = Buffer.from(res.data.content, 'base64').toString('utf-8').trim();
    let arr = [];
    if (raw) {
      try { arr = JSON.parse(raw); } catch { console.warn('[GITHUB] JSON تالف.'); }
    }
    if (Array.isArray(arr)) {
      arr.forEach(fp => sentFingerprints.add(fp));
      console.log(`[GITHUB] تم تحميل ${arr.length} بصمة.`);
    }
  } catch (err) {
    if (err.response?.status === 404) {
      console.log('[GITHUB] الملف غير موجود، إنشاء...');
      await createEmptyFile().catch(() => {});
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
  console.log('[GITHUB] تم إنشاء الملف.');
}

async function saveFingerprints() {
  if (!githubFileSha || sentFingerprints.size === 0) return;
  try {
    const arr = Array.from(sentFingerprints);
    const content = Buffer.from(JSON.stringify(arr)).toString('base64');
    const res = await githubAxios.put(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`, {
      message: `تحديث ${new Date().toISOString()}`,
      content,
      sha: githubFileSha
    });
    githubFileSha = res.data.content.sha;
    pendingSaveCount = 0;
    console.log(`[GITHUB] حفظ ${arr.length} بصمة.`);
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

// ========== دوال RSS ==========
async function fetchFeed(url) {
  try {
    const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'text' });
    return await parser.parseString(res.data.replace(/^\uFEFF/, ''));
  } catch {}
  try {
    return await parser.parseURL(url);
  } catch {}
  throw new Error('فشل كل المحاولات');
}

function extractImage(item) {
  // Nitter لا يضع صورًا مباشرة، لذا نبحث في المحتوى
  if (item.enclosure?.url) return item.enclosure.url;
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
  if (sentFingerprints.has(fp)) return;

  // عنوان Nitter يكون غالبًا: "INA_Iraq: نص التغريدة"
  let title = item.title || 'خبر';
  // إزالة اسم المستخدم من البداية إن وجد
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
    return;
  }

  sentFingerprints.add(fp);
  pendingSaveCount++;
  if (pendingSaveCount >= 10) await saveFingerprints().catch(() => {});
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

async function start() {
  console.log('🚀 تشغيل البوت (X عبر Nitter RSS)');
  await loadFingerprints().catch(() => {});
  while (true) {
    await mainCycle().catch(err => console.error('[دورة فاشلة]', err.message));
    console.log(`انتظار ${FETCH_INTERVAL_MINUTES} دقائق...`);
    await sleep(FETCH_INTERVAL_MINUTES * 60000);
  }
}

process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));
process.on('unhandledRejection', (reason) => console.error('[REJECTION]', reason));

start();
