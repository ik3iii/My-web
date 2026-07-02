require('dotenv').config();
const { Telegraf } = require('telegraf');
const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');
const OpenAI = require('openai');
const Database = require('better-sqlite3');

// ---------- الإعدادات ----------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_USER_ID);
const CHANNEL = '@EGIIIU';
const NITTER_ACCOUNTS = process.env.NITTER_ACCOUNTS.split(',').map(s => s.trim());
const FETCH_INTERVAL = 60_000; // كل دقيقة داخل النشاط
const ACTIVE_DURATION = 15 * 60_000;  // 15 دقيقة
const REST_DURATION = 3 * 60_000;    // 3 دقائق
const MAX_NEWS_AGE_MINUTES = 30;     // ← 30 دقيقة (وليس 30 ساعة)

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// DeepSeek
const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

// ---------- قاعدة البيانات ----------
const db = new Database('news_bot.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS published (
    hash TEXT PRIMARY KEY,
    title TEXT,
    link TEXT,
    pub_date TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS last_pub_date (
    account TEXT PRIMARY KEY,
    last_date TEXT
  );
`);

const insertHash = db.prepare('INSERT OR IGNORE INTO published (hash, title, link, pub_date) VALUES (?, ?, ?, ?)');
const isHashExist = db.prepare('SELECT 1 FROM published WHERE hash = ?').pluck();
const getLastDate = db.prepare('SELECT last_date FROM last_pub_date WHERE account = ?').pluck();
const setLastDate = db.prepare('INSERT OR REPLACE INTO last_pub_date (account, last_date) VALUES (?, ?)');

// ---------- سجل ----------
const logLines = [];
function log(msg) {
  const time = new Date().toISOString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 100) logLines.shift();
}

// ---------- AI صياغة وتصنيف ----------
async function summarizeAndClassify(item) {
  const title = item.title || '';
  const desc = item.contentSnippet || item.content || '';
  const fullText = `العنوان: ${title}\nالمحتوى: ${desc}`;

  try {
    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `أنت محرر أخبار عراقي. مهمتك:
1. صغ الخبر في جملة أو جملتين موجزتين بالعربية، مناسبة للنشر في قناة تيليجرام.
2. ابدأ الخبر بإيموجي مناسب.
3. إذا كان النص ليس خبرًا سياسيًا أو أمنيًا أو اقتصاديًا أو عاجلًا عن العراق، اكتب "غير_خبر" فقط.
لا تقدم أي تعليق خارج التنسيق المطلوب.`
        },
        { role: 'user', content: fullText }
      ],
      max_tokens: 200,
      temperature: 0.3,
    });

    const result = response.choices[0]?.message?.content?.trim() || '';
    if (result === 'غير_خبر') {
      return { relevant: false, formatted: null };
    }
    return { relevant: true, formatted: result };
  } catch (err) {
    log(`❌ AI error: ${err.message}`);
    return { relevant: false, formatted: null };
  }
}

// ---------- استخراج الوسائط ----------
function getMedia(item) {
  if (item.enclosure && item.enclosure.url) {
    const type = item.enclosure.type || '';
    if (type.startsWith('image/')) return { type: 'photo', url: item.enclosure.url };
    if (type.startsWith('video/')) return { type: 'video', url: item.enclosure.url };
  }
  if (item['media:content'] && item['media:content'].$) {
    const url = item['media:content'].$.url;
    const type = item['media:content'].$.type || '';
    if (type.startsWith('video/')) return { type: 'video', url };
    return { type: 'photo', url };
  }
  return null;
}

// ---------- معالجة الأخبار ----------
const rssParser = new Parser({
  customFields: { item: ['media:content', 'enclosure'] }
});

const bot = new Telegraf(BOT_TOKEN);

async function processAccounts() {
  const now = Date.now();

  for (const account of NITTER_ACCOUNTS) {
    let items;
    try {
      items = await rssParser.parseURL(`https://nitter.net/${account}/rss`);
      items = items.items || [];
    } catch (e) {
      log(`❌ فشل جلب RSS من ${account}: ${e.message}`);
      continue;
    }

    // الأحدث أولاً
    items.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

    const lastDateStr = getLastDate.get(account);
    let newLatestDate = lastDateStr ? new Date(lastDateStr) : null;

    for (const item of items) {
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      if (!pubDate || isNaN(pubDate.getTime())) continue;

      // تجاهل إذا كان الخبر أقدم من 30 دقيقة
      const ageMs = now - pubDate.getTime();
      if (ageMs > MAX_NEWS_AGE_MINUTES * 60 * 1000) {
        continue;
      }

      // تجاهل أقدم من آخر تاريخ معالج
      if (lastDateStr && pubDate <= new Date(lastDateStr)) {
        continue;
      }

      const title = item.title || '';
      const desc = item.contentSnippet || item.content || '';
      const hash = require('crypto').createHash('sha256').update(title + desc.substring(0, 60)).digest('hex');

      if (isHashExist.get(hash)) continue;

      const { relevant, formatted } = await summarizeAndClassify(item);
      if (!relevant) {
        log(`🚫 تجاهل (غير إخباري): ${title.substring(0, 60)}`);
        continue;
      }

      const link = item.link;
      let caption = formatted;
      if (link) caption += `\n\n🔗 التفاصيل: ${link}`;

      const media = getMedia(item);

      try {
        if (media && media.type === 'video') {
          await bot.telegram.sendVideo(CHANNEL, media.url, { caption, parse_mode: 'HTML' });
        } else if (media && media.type === 'photo') {
          await bot.telegram.sendPhoto(CHANNEL, media.url, { caption, parse_mode: 'HTML' });
        } else {
          await bot.telegram.sendMessage(CHANNEL, caption, { parse_mode: 'HTML', disable_web_page_preview: true });
        }

        insertHash.run(hash, title, link, item.pubDate);
        log(`✅ نشر: ${formatted.substring(0, 60)}`);

        if (!newLatestDate || pubDate > newLatestDate) {
          newLatestDate = pubDate;
        }

        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        log(`❌ فشل إرسال "${title}": ${e.message}`);
      }
    }

    if (newLatestDate && (!lastDateStr || newLatestDate > new Date(lastDateStr))) {
      setLastDate.run(account, newLatestDate.toISOString());
    }
  }
}

// ---------- دورة العمل ----------
let timer, activeTimeout, restTimeout;

function startCycle() {
  clearInterval(timer);
  clearTimeout(activeTimeout);
  clearTimeout(restTimeout);

  log('🟢 بدء نافذة نشاط 15 دقيقة');
  processAccounts();
  timer = setInterval(() => {
    log('🔄 جلب دوري...');
    processAccounts().catch(e => log('خطأ: ' + e));
  }, FETCH_INTERVAL);

  activeTimeout = setTimeout(() => {
    log('🔴 نهاية النشاط، راحة 3 دقائق');
    clearInterval(timer);
    timer = null;
    restTimeout = setTimeout(startCycle, REST_DURATION);
  }, ACTIVE_DURATION);
}

// ---------- لوحة التحكم ----------
let expectingCodeUpdate = false;

bot.on('document', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID || !expectingCodeUpdate) return;
  const file = ctx.message.document;
  if (!file.file_name?.endsWith('.js')) return ctx.reply('❌ يجب أن يكون الملف .js');
  try {
    const url = await bot.telegram.getFileLink(file.file_id);
    const res = await axios.get(url.href, { responseType: 'arraybuffer' });
    fs.writeFileSync(__filename, Buffer.from(res.data));
    ctx.reply('✅ تم تحديث الكود. إعادة التشغيل...');
    log('🔄 إعادة تشغيل بعد تحديث الكود');
    clearInterval(timer);
    clearTimeout(activeTimeout);
    clearTimeout(restTimeout);
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    ctx.reply('❌ فشل: ' + e.message);
  }
  expectingCodeUpdate = false;
});

bot.command('start', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.reply('أهلاً أدمن. الأوامر:\n/status /logs /updatecode');
});

bot.command('status', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const count = db.prepare('SELECT COUNT(*) FROM published').pluck().get();
  const active = timer ? 'نشط' : 'متوقف';
  ctx.reply(`✅ البوت: ${active}\n📬 الأخبار المحفوظة: ${count}\n🕒 ${new Date().toLocaleString()}`);
});

bot.command('logs', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  if (logLines.length === 0) return ctx.reply('لا سجلات.');
  ctx.reply(`<pre>${logLines.join('\n')}</pre>`, { parse_mode: 'HTML' });
});

bot.command('updatecode', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  expectingCodeUpdate = true;
  ctx.reply('أرسل ملف bot.js الجديد خلال 30 ثانية.');
  setTimeout(() => { expectingCodeUpdate = false; }, 30_000);
});

// ---------- بدء التشغيل ----------
bot.launch().then(() => {
  log('🤖 بوت الأخبار يعمل (الحد الأقصى: 30 دقيقة)');
  startCycle();
});

process.on('uncaughtException', err => log('💥 ' + err.message));
process.on('unhandledRejection', reason => log('⚠️ ' + reason));
