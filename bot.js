// ==================== بوت الأخبار العراقي (إصدار SQLite + DeepSeek AI) ====================
require('dotenv').config();
const { Telegraf } = require('telegraf');
const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const Database = require('better-sqlite3');

// ---------- الإعدادات ----------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_USER_ID);
const CHANNEL = '@EGIIIU';
const NITTER_ACCOUNTS = process.env.NITTER_ACCOUNTS.split(',').map(s => s.trim());
const FETCH_INTERVAL = (parseInt(process.env.FETCH_INTERVAL_MINUTES) || 1) * 60 * 1000;
const ACTIVE_DURATION = 15 * 60 * 1000;   // 15 دقيقة
const REST_DURATION = 3 * 60 * 1000;     // 3 دقائق

// GitHub للنسخ الاحتياطي (اختياري)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// DeepSeek API
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const deepseek = DEEPSEEK_API_KEY ? new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: DEEPSEEK_API_KEY,
}) : null;

// قاعدة البيانات
const DB_FILE = 'news_bot.db';
const db = new Database(DB_FILE);

// تهيئة قاعدة البيانات
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT UNIQUE,
    title TEXT,
    link TEXT,
    pub_date TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_hash ON news(hash);
  CREATE TABLE IF NOT EXISTS last_pub_date (
    account TEXT PRIMARY KEY,
    last_date TEXT
  );
`);

// ---------- أدوات السجل ----------
const logLines = [];
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 100) logLines.shift();
}

// ---------- دوال قاعدة البيانات ----------
function isNewsDuplicate(hash) {
  return db.prepare('SELECT id FROM news WHERE hash = ?').get(hash) !== undefined;
}

function saveNewsHash(hash, title, link, pubDate) {
  try {
    db.prepare('INSERT OR IGNORE INTO news (hash, title, link, pub_date) VALUES (?, ?, ?, ?)').run(hash, title, link, pubDate);
    return true;
  } catch (e) {
    return false;
  }
}

function getLastPubDate(account) {
  const row = db.prepare('SELECT last_date FROM last_pub_date WHERE account = ?').get(account);
  return row ? row.last_date : null;
}

function updateLastPubDate(account, pubDate) {
  db.prepare('INSERT OR REPLACE INTO last_pub_date (account, last_date) VALUES (?, ?)').run(account, pubDate);
}

// احتياطي GitHub (رفع قاعدة البيانات كاملة)
async function backupToGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  const [owner, repo] = GITHUB_REPO.split('/');
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${DB_FILE}`;
  const dbContent = fs.readFileSync(DB_FILE);
  const base64Content = dbContent.toString('base64');
  try {
    let sha = null;
    try {
      const getRes = await axios.get(apiUrl, {
        headers: { Authorization: `token ${GITHUB_TOKEN}` },
        params: { ref: GITHUB_BRANCH }
      });
      sha = getRes.data.sha;
    } catch (e) {}
    await axios.put(apiUrl, {
      message: 'تحديث قاعدة البيانات ' + new Date().toISOString(),
      content: base64Content,
      branch: GITHUB_BRANCH,
      sha: sha
    }, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });
    log('☁️ تم رفع قاعدة البيانات إلى GitHub.');
  } catch (e) {
    log('❌ فشل رفع قاعدة البيانات إلى GitHub: ' + e.message);
  }
}

// ---------- DeepSeek AI صياغة الخبر ----------
async function formatNewsWithAI(title, description) {
  if (!deepseek) {
    return title; // إرجاع العنوان فقط إذا لم يتوفر AI
  }
  const text = `العنوان: ${title}\nالوصف: ${description || ''}`;
  try {
    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `أنت محرر أخبار عراقي محترف. قم بصياغة الخبر التالي في جملة أو جملتين باللغة العربية، بأسلوب موجز ومناسب للنشر على قناة تيليجرام. أضف إيموجي مناسب في البداية. لا تضف أي تعليقات إضافية.`
        },
        {
          role: 'user',
          content: `صغ الخبر التالي:\n${text}`
        }
      ],
      max_tokens: 200,
      temperature: 0.7,
    });
    const formatted = response.choices[0]?.message?.content?.trim();
    if (formatted) {
      return formatted;
    }
  } catch (err) {
    log(`❌ فشل صياغة AI للخبر "${title}": ${err.message}`);
  }
  // في حال الفشل، نرجع عنوانًا منسقًا يدويًا
  return `📰 ${title}`;
}

// ---------- جلب RSS ----------
const rssParser = new Parser({
  customFields: {
    item: ['media:content', 'enclosure', 'description']
  }
});

async function fetchRSS(account) {
  const url = `https://nitter.net/${account}/rss`;
  try {
    const feed = await rssParser.parseURL(url);
    return feed.items || [];
  } catch (e) {
    log(`❌ فشل جلب RSS من ${account}: ${e.message}`);
    return [];
  }
}

function extractMedia(item) {
  // استخراج رابط الصورة أو الفيديو
  if (item.enclosure) {
    const type = item.enclosure.type || '';
    if (type.startsWith('image/') || type.startsWith('video/')) {
      return { url: item.enclosure.url, type: type.startsWith('video/') ? 'video' : 'photo' };
    }
  }
  if (item['media:content']) {
    const url = item['media:content'].$.url;
    const type = item['media:content'].$.type || '';
    return { url, type: type.startsWith('video/') ? 'video' : 'photo' };
  }
  // قد يكون هناك وصف يحتوي على روابط وسائط
  return null;
}

// ---------- إرسال الخبر ----------
const bot = new Telegraf(BOT_TOKEN);

async function sendNews(formattedText, item) {
  const media = extractMedia(item);
  const link = item.link;

  try {
    if (media) {
      if (media.type === 'video') {
        await bot.telegram.sendVideo(CHANNEL, media.url, {
          caption: formattedText + (link ? `\n\n🔗 التفاصيل: ${link}` : ''),
          parse_mode: 'HTML'
        });
      } else {
        await bot.telegram.sendPhoto(CHANNEL, media.url, {
          caption: formattedText + (link ? `\n\n🔗 التفاصيل: ${link}` : ''),
          parse_mode: 'HTML'
        });
      }
    } else {
      await bot.telegram.sendMessage(CHANNEL, formattedText + (link ? `\n\n🔗 التفاصيل: ${link}` : ''), {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    }
    return true;
  } catch (e) {
    log(`❌ فشل إرسال الخبر: ${e.message}`);
    return false;
  }
}

// ---------- معالجة الأخبار ----------
async function processAllAccounts() {
  for (const account of NITTER_ACCOUNTS) {
    const items = await fetchRSS(account);
    if (items.length === 0) continue;

    // فرز العناصر حسب تاريخ النشر (من الأقدم للأحدث)
    items.sort((a, b) => {
      const dateA = new Date(a.pubDate || 0).getTime();
      const dateB = new Date(b.pubDate || 0).getTime();
      return dateA - dateB;
    });

    // جلب آخر تاريخ نشر تمت معالجته
    const lastDate = getLastPubDate(account);
    let latestProcessedDate = lastDate;

    for (const item of items) {
      const pubDate = item.pubDate || new Date().toISOString();
      // تجاهل الأخبار الأقدم من آخر تاريخ معالج (لتجنب القديم)
      if (lastDate && new Date(pubDate) <= new Date(lastDate)) {
        continue;
      }

      const title = item.title || 'بدون عنوان';
      const description = item.contentSnippet || item.content || '';

      // توليد بصمة فريدة
      const hash = require('crypto').createHash('sha256').update(title + description.substring(0, 60)).digest('hex');

      if (isNewsDuplicate(hash)) continue; // مكرر

      // صياغة الخبر بالذكاء الاصطناعي
      const formattedText = await formatNewsWithAI(title, description);

      // إرسال الخبر
      const sent = await sendNews(formattedText, item);
      if (sent) {
        // حفظ البصمة في قاعدة البيانات
        saveNewsHash(hash, title, item.link, pubDate);
        // تحديث آخر تاريخ
        if (!latestProcessedDate || new Date(pubDate) > new Date(latestProcessedDate)) {
          latestProcessedDate = pubDate;
        }
        // تأخير بسيط بين الإرسال
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else {
        log(`⏳ فشل إرسال "${title}"، سيُعاد لاحقاً.`);
      }
    }

    // تحديث آخر تاريخ معالج للحساب
    if (latestProcessedDate && latestProcessedDate !== lastDate) {
      updateLastPubDate(account, latestProcessedDate);
    }
  }
}

// ---------- دورة النشاط / الراحة ----------
let fetchTimer = null;
let activeTimeout = null;
let restTimeout = null;

function startActiveCycle() {
  if (fetchTimer) clearInterval(fetchTimer);
  log('🟢 بدء دورة النشاط (15 دقيقة).');
  // جلب فوري
  processAllAccounts().catch(e => log('خطأ: ' + e));
  fetchTimer = setInterval(() => {
    log('🔍 جلب دوري...');
    processAllAccounts().catch(e => log('خطأ: ' + e));
    // نسخ احتياطي كل 10 دقائق
    backupToGitHub().catch(() => {});
  }, FETCH_INTERVAL);

  activeTimeout = setTimeout(() => {
    log('🔴 انتهت النشاط، راحة 3 دقائق.');
    stopFetching();
    restTimeout = setTimeout(() => {
      startActiveCycle();
    }, REST_DURATION);
  }, ACTIVE_DURATION);
}

function stopFetching() {
  if (fetchTimer) {
    clearInterval(fetchTimer);
    fetchTimer = null;
  }
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
  if (restTimeout) {
    clearTimeout(restTimeout);
    restTimeout = null;
  }
}

// ---------- لوحة التحكم ----------
let expectingCodeUpdate = false;

bot.on('document', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID || !expectingCodeUpdate) return;
  const fileId = ctx.message.document.file_id;
  const fileName = ctx.message.document.file_name || 'bot.js';
  if (!fileName.endsWith('.js')) return ctx.reply('❌ يجب أن يكون الملف .js');
  try {
    const fileUrl = await bot.telegram.getFileLink(fileId);
    const res = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
    fs.writeFileSync(__filename, Buffer.from(res.data));
    ctx.reply('✅ تم تحديث الكود. إعادة التشغيل...');
    log('🔄 إعادة تشغيل البوت لتطبيق الكود الجديد.');
    stopFetching();
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    ctx.reply('❌ فشل التحديث: ' + e.message);
  }
  expectingCodeUpdate = false;
});

bot.command('start', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ غير مصرح.');
  ctx.reply('👋 مرحباً أدمن. أوامر: /status /logs /updatecode');
});

bot.command('status', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const active = fetchTimer ? 'نشط' : 'متوقف';
  const count = db.prepare('SELECT COUNT(*) as cnt FROM news').get().cnt;
  ctx.reply(`✅ البوت يعمل\n📡 الجلب: ${active}\n📬 الأخبار المحفوظة: ${count}\n🕒 ${new Date().toLocaleString()}`);
});

bot.command('logs', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  if (logLines.length === 0) return ctx.reply('لا سجلات.');
  ctx.reply(`📋 آخر ${logLines.length} سطر:\n<pre>${logLines.join('\n')}</pre>`, { parse_mode: 'HTML' });
});

bot.command('updatecode', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  expectingCodeUpdate = true;
  ctx.reply('📥 أرسل ملف bot.js الجديد (خلال 30 ثانية).');
  setTimeout(() => { expectingCodeUpdate = false; }, 30000);
});

// ---------- تشغيل البوت ----------
async function init() {
  // تحميل قاعدة البيانات (قد تكون موجودة)
  log(`📊 قاعدة البيانات جاهزة.`);

  bot.launch();
  log('🤖 بوت الأخبار بدأ.');

  startActiveCycle();
}

process.on('uncaughtException', (err) => log('💥 خطأ: ' + err.message));
process.on('unhandledRejection', (reason) => log('⚠️ وعد: ' + reason));

init().catch(err => {
  log('فشل البدء: ' + err.message);
  process.exit(1);
});
