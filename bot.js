const Parser = require('rss-parser');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ========== الإعدادات ==========
const BOT_TOKEN = '8980684818:AAF-s0ad8H83DIr-0-WexPyRJ4ssO8fa-e0';
const CHANNEL_ID = '@EGIIIU';
const GITHUB_TOKEN = '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';
const GITHUB_OWNER = 'ik3iii';
const GITHUB_REPO = 'My-web';
const GITHUB_FILE = 'news_fingerprints.json';
const LOCAL_DB = path.join(__dirname, 'sent_fingerprints.json'); // تخزين محلي

const PORT = process.env.PORT || 3000;
const FETCH_INTERVAL = 5 * 60 * 1000; // 5 دقائق
const SEND_DELAY = { min: 2000, max: 5000 };
const MAX_RETRIES = 3;

// ========== مصادر RSS عراقية (موثوقة) ==========
const RSS_SOURCES = [
  'https://baghdadtoday.news/rss.xml',
  'https://shafaq.com/ar/rss.xml',
  'https://www.rudaw.net/rss.aspx?type=news',
  'https://www.alsumaria.tv/rss/iraq-news',
  'https://www.ninanews.com/Website/News/rss',
  'https://www.almaalomah.me/feed',
  // يمكن إضافة Nitter لاحقًا بسهولة
];

// ========== أدوات ==========
const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
const sentFingerprints = new Set();

// ---- دوال الملفات المحلية ----
function loadLocalDB() {
  try {
    if (fs.existsSync(LOCAL_DB)) {
      const data = fs.readFileSync(LOCAL_DB, 'utf-8');
      const arr = JSON.parse(data);
      if (Array.isArray(arr)) {
        arr.forEach(fp => sentFingerprints.add(fp));
        console.log(`[محلي] تم تحميل ${arr.length} بصمة.`);
        return true;
      }
    }
  } catch (e) {
    console.error('[محلي] خطأ في قراءة الملف المحلي:', e.message);
  }
  return false;
}

function saveLocalDB() {
  try {
    const arr = Array.from(sentFingerprints);
    fs.writeFileSync(LOCAL_DB, JSON.stringify(arr), 'utf-8');
    console.log(`[محلي] حفظ ${arr.length} بصمة.`);
  } catch (e) {
    console.error('[محلي] فشل حفظ الملف:', e.message);
  }
}

// ---- دوال GitHub ----
const githubApi = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'IQNewsBot'
  },
  timeout: 15000
});

let githubSha = null;

async function syncFromGitHub() {
  try {
    const res = await githubApi.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`);
    githubSha = res.data.sha;
    const raw = Buffer.from(res.data.content, 'base64').toString('utf-8').trim();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      arr.forEach(fp => sentFingerprints.add(fp));
      console.log(`[GitHub] تم تحميل ${arr.length} بصمة.`);
      // دمج مع المحلي وحفظه
      saveLocalDB();
    }
  } catch (e) {
    if (e.response?.status === 404) {
      // الملف غير موجود، سننشئه لاحقًا
      console.log('[GitHub] ملف البصمات غير موجود بعد.');
    } else {
      console.error('[GitHub] فشل التحميل:', e.message);
    }
  }
}

async function pushToGitHub() {
  const arr = Array.from(sentFingerprints);
  const content = Buffer.from(JSON.stringify(arr)).toString('base64');
  const body = {
    message: `تحديث البصمات - ${new Date().toISOString()}`,
    content,
  };
  if (githubSha) body.sha = githubSha;

  try {
    const res = await githubApi.put(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`, body);
    githubSha = res.data.content.sha;
    console.log(`[GitHub] تم رفع ${arr.length} بصمة.`);
  } catch (e) {
    console.error('[GitHub] فشل الرفع:', e.message);
    // إذا كان الخطأ 409 (تضارب SHA) نعيد تحميل sha ثم نحاول لاحقًا
    if (e.response?.status === 409) {
      try {
        const res = await githubApi.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`);
        githubSha = res.data.sha;
      } catch {}
    }
  }
}

// ---- دوال تيليجرام ----
const telegram = axios.create({
  baseURL: `https://api.telegram.org/bot${BOT_TOKEN}`,
  timeout: 20000,
});

async function sendToTelegram(method, params) {
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await telegram.post(`/${method}`, params);
      if (res.data.ok) return res.data;
      throw new Error(res.data.description || 'خطأ');
    } catch (e) {
      console.error(`[TG] ${method} محاولة ${i}: ${e.message}`);
      if (i < MAX_RETRIES) await sleep(3000);
    }
  }
  throw new Error('فشل الاتصال بتليجرام');
}

async function sendMessage(text) {
  return sendToTelegram('sendMessage', {
    chat_id: CHANNEL_ID,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
}

async function sendPhoto(url, caption) {
  return sendToTelegram('sendPhoto', {
    chat_id: CHANNEL_ID,
    photo: url,
    caption,
    parse_mode: 'Markdown'
  });
}

// ---- دوال RSS ----
async function fetchFeed(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'text',
      responseEncoding: 'utf-8'
    });
    return await parser.parseString(res.data.replace(/^\uFEFF/, ''));
  } catch {}
  try {
    return await parser.parseURL(url);
  } catch {}
  throw new Error('فشل جلب الخلاصة');
}

function extractImage(item) {
  if (item.enclosure?.url) return item.enclosure.url;
  if (item['media:content']?.url) return item['media:content'].url;
  if (Array.isArray(item['media:content']) && item['media:content'][0]?.url) return item['media:content'][0].url;
  if (item['media:thumbnail']?.url) return item['media:thumbnail'].url;
  const html = item['content:encoded'] || item.content || item.summary || '';
  const img = html.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp|gif))["']/i);
  if (img) return img[1];
  const url = html.match(/(https?:\/\/[^\s<>"]+\.(?:jpg|jpeg|png|webp|gif))/i);
  return url ? url[1] : null;
}

function hasBayyan(item) {
  return /بيان/.test((item.title || '') + ' ' + (item.contentSnippet || ''));
}

function getFingerprint(item) {
  const title = (item.title || '').trim();
  const desc = (item.contentSnippet || item.summary || item.content || '')
    .replace(/<[^>]+>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 60);
  return crypto.createHash('sha256').update(title + '|' + desc).digest('hex');
}

// ---- معالجة خبر واحد ----
async function processItem(item) {
  const fp = getFingerprint(item);
  if (sentFingerprints.has(fp)) return; // تخطي المكرر

  let title = (item.title || 'خبر').trim();
  const emoji = ['🇮🇶','🔥','🚨','📌','⚡','🔴','📰','🌍'][Math.floor(Math.random()*8)];
  let caption = `${emoji} *${title}*`;
  if (hasBayyan(item) && item.link) {
    caption += `\n\n[🔗 التفاصيل](${item.link})`;
  }
  const img = extractImage(item);

  try {
    if (img) await sendPhoto(img, caption);
    else await sendMessage(caption);
    console.log(`[SENT] ${title}`);
  } catch (e) {
    console.error(`[SKIP] ${title}:`, e.message);
    return; // لا نخزن البصمة إذا فشل الإرسال
  }

  // أضف البصمة واحفظ محليًا فوريًا
  sentFingerprints.add(fp);
  saveLocalDB(); // حفظ فوري لمنع الفقد
}

// ---- معالجة مصدر RSS ----
async function processSource(url) {
  try {
    const feed = await fetchFeed(url);
    if (!feed?.items?.length) return;
    console.log(`[RSS] ${url} → ${feed.items.length} خبر`);
    for (const item of feed.items) {
      await processItem(item);
      await sleep(randomBetween(SEND_DELAY.min, SEND_DELAY.max));
    }
  } catch (e) {
    console.error(`[RSS] فشل ${url}:`, e.message);
  }
}

// ---- دورة الأخبار الرئيسية ----
async function newsCycle() {
  console.log(`\n=== دورة ${new Date().toLocaleString()} ===`);
  for (const src of RSS_SOURCES) {
    await processSource(src);
    await sleep(1000);
  }
  console.log('=== انتهت الدورة ===\n');
}

// ---- أدوات مساعدة ----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ---- خادم HTTP (للاستضافة) ----
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(PORT, () => console.log(`🌐 خادم على ${PORT}`));

// ---- التشغيل الرئيسي ----
async function main() {
  console.log('🚀 بدء تشغيل بوت الأخبار العراقية');

  // 1. تحميل البيانات المحلية
  const localLoaded = loadLocalDB();

  // 2. مزامنة من GitHub (إن لم تكن محلية)
  if (!localLoaded) {
    await syncFromGitHub();
  } else {
    // تحديث GitHub بما لدينا محليًا (رفع أولي)
    pushToGitHub();
  }

  // 3. بدء دورة جلب الأخبار
  newsCycle();

  // 4. جدولة الدورة
  setInterval(newsCycle, FETCH_INTERVAL);

  // 5. مزامنة دورية مع GitHub (كل 10 دقائق)
  setInterval(pushToGitHub, 10 * 60 * 1000);
}

// ---- معالجة الأخطاء العامة ----
process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));
process.on('unhandledRejection', (reason) => console.error('[REJECTION]', reason));

main();
