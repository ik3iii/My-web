require('dotenv').config();
const { Telegraf } = require('telegraf');
const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const OpenAI = require('openai');

// ---------- الإعدادات ----------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_USER_ID);
const CHANNEL = '@EGIIIU';
const NITTER_ACCOUNTS = process.env.NITTER_ACCOUNTS.split(',').map(s => s.trim());
const FETCH_INTERVAL = (parseInt(process.env.FETCH_INTERVAL_MINUTES) || 1) * 60 * 1000;
const ACTIVE_DURATION = 15 * 60 * 1000;   // 15 دقيقة نشاط
const REST_DURATION = 3 * 60 * 1000;      // 3 دقائق راحة

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const HASHES_FILE = 'hashes.json';
const FILTERS_FILE = 'filters.json';

// DeepSeek API
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const deepseek = DEEPSEEK_API_KEY ? new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: DEEPSEEK_API_KEY,
}) : null;
const USE_AI_FILTER = !!deepseek;

// ---------- أدوات السجل ----------
const logLines = [];
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 100) logLines.shift();
}

// ---------- البصمات ----------
let seenHashes = new Set();

function loadLocalHashes() {
  try {
    if (fs.existsSync(HASHES_FILE)) {
      const data = JSON.parse(fs.readFileSync(HASHES_FILE, 'utf8'));
      seenHashes = new Set(data);
      log(`✅ تم تحميل ${seenHashes.size} بصمة محلية.`);
    } else {
      log('ℹ️ لا يوجد ملف بصمات محلي.');
    }
  } catch (e) {
    log('⚠️ فشل تحميل البصمات المحلية: ' + e.message);
  }
}

function saveLocalHashes() {
  try {
    fs.writeFileSync(HASHES_FILE, JSON.stringify([...seenHashes], null, 2), 'utf8');
  } catch (e) {
    log('❌ فشل حفظ البصمات محلياً: ' + e.message);
  }
}

async function fetchRemoteHashes() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${HASHES_FILE}`;
  try {
    const res = await axios.get(url, { timeout: 10000 });
    if (res.data && Array.isArray(res.data)) {
      seenHashes = new Set(res.data);
      log(`☁️ تم تحميل ${seenHashes.size} بصمة من GitHub.`);
      saveLocalHashes();
    }
  } catch (e) {
    log('⚠️ تعذر جلب البصمات من GitHub.');
  }
}

async function pushHashesToGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  const [owner, repo] = GITHUB_REPO.split('/');
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${HASHES_FILE}`;
  const content = JSON.stringify([...seenHashes], null, 2);
  const base64Content = Buffer.from(content).toString('base64');
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
      message: 'تحديث البصمات ' + new Date().toISOString(),
      content: base64Content,
      branch: GITHUB_BRANCH,
      sha: sha
    });
    log('☁️ تم رفع البصمات إلى GitHub.');
  } catch (e) {
    log('❌ فشل رفع البصمات إلى GitHub: ' + e.message);
  }
}

// ---------- قوائم التصفية ----------
let WHITELIST = [];
let BLACKLIST = [];

function loadFilters() {
  try {
    if (fs.existsSync(FILTERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(FILTERS_FILE, 'utf8'));
      if (data.whitelist) WHITELIST = data.whitelist;
      if (data.blacklist) BLACKLIST = data.blacklist;
      log(`✅ قوائم التصفية: (أبيض: ${WHITELIST.length}, أسود: ${BLACKLIST.length})`);
    }
  } catch (e) {
    log('⚠️ فشل تحميل قوائم التصفية.');
  }
}

function saveFilters() {
  fs.writeFileSync(FILTERS_FILE, JSON.stringify({ whitelist: WHITELIST, blacklist: BLACKLIST }, null, 2), 'utf8');
}

// ---------- أدوات RSS ----------
const rssParser = new Parser({
  customFields: {
    item: ['media:content', 'enclosure']
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

function extractImageUrl(item) {
  if (item.enclosure && item.enclosure.url && item.enclosure.type && item.enclosure.type.startsWith('image/')) {
    return item.enclosure.url;
  }
  if (item['media:content'] && item['media:content'].$.url) {
    return item['media:content'].$.url;
  }
  return null;
}

function generateHash(title, description) {
  const descPart = (description || '').substring(0, 60);
  const raw = `${title}|${descPart}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ---------- DeepSeek AI تصفية ----------
async function isRelevantNewsAI(title, description) {
  if (!deepseek) return true;
  const fullText = `العنوان: ${title}\nالمحتوى: ${description || 'لا يوجد وصف'}`;
  try {
    log(`🤖 تحليل AI للخبر: "${title.substring(0, 50)}..."`);
    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `أنت مساعد لتصنيف الأخبار. حدد إذا كان الخبر "خبرًا عراقيًا جادًا" (سياسة، اقتصاد، أمن، مجتمع، كوارث، أحداث عاجلة، أخبار محلية) أم "غير جاد" (ترفيه، رياضة، صحة عامة، نصائح، إعلانات، محتوى غير إخباري). أجب فقط بكلمة "جاد" أو "غير جاد".`
        },
        {
          role: 'user',
          content: `صنف الخبر التالي:\n${fullText}`
        }
      ],
      max_tokens: 5,
      temperature: 0,
    });
    const answer = response.choices[0]?.message?.content?.trim();
    const isRelevant = answer === 'جاد';
    log(isRelevant ? '✅ AI: الخبر جاد' : '❌ AI: الخبر غير جاد');
    return isRelevant;
  } catch (err) {
    log(`❌ فشل تحليل AI للخبر "${title}": ${err.message}`);
    return true; // تمرير الخبر عند الخطأ
  }
}

// ---------- إرسال الخبر ----------
const bot = new Telegraf(BOT_TOKEN);

async function sendNewsItem(item) {
  const title = item.title || 'بدون عنوان';
  const link = item.link || '';
  const description = item.contentSnippet || item.content || '';
  const imageUrl = extractImageUrl(item);

  // بناء النص الكامل: العنوان + جزء من الوصف إن وجد
  let fullCaption = title;
  const descTrimmed = description ? description.trim() : '';
  if (descTrimmed && descTrimmed.length > 10) {
    // إضافة الوصف بشكل مختصر لجعل الخبر أكثر وضوحًا
    const descPreview = descTrimmed.length > 150 ? descTrimmed.substring(0, 150) + '...' : descTrimmed;
    fullCaption = title + '\n\n' + descPreview;
  }

  // تحديد إضافة رابط التفاصيل (دائمًا تقريبًا للاطلاع على الخبر كاملاً)
  let addDetailsLink = true; // سنضيف الرابط دائمًا حيث أن التغريدة غالبًا مختصرة
  // لكن نستثني إذا كان النص طويلًا جدًا (> 200 حرف) والرابط غير ضروري
  if (fullCaption.length > 200 && !/بيان/i.test(title + ' ' + description)) {
    addDetailsLink = false;
  }

  // إيموجي عشوائي
  const emojis = ['📰', '🇮🇶', '🔥', '📢', '🚨', '📌', '💬', '📣', '🌐', '⚡', '📡'];
  const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

  let message = `${randomEmoji} ${fullCaption}`;
  if (addDetailsLink && link) {
    message += `\n\n🔗 التفاصيل`;
  }

  try {
    if (imageUrl) {
      await bot.telegram.sendPhoto(CHANNEL, { url: imageUrl }, { caption: message, parse_mode: 'HTML' });
    } else {
      await bot.telegram.sendMessage(CHANNEL, message, { parse_mode: 'HTML', disable_web_page_preview: false });
    }
    log(`✅ تم إرسال: "${title.substring(0, 50)}..."`);
    return true;
  } catch (e) {
    log(`❌ فشل إرسال "${title}": ${e.message}`);
    return false;
  }
}

// ---------- معالجة الأخبار ----------
async function processAllAccounts() {
  for (const account of NITTER_ACCOUNTS) {
    const items = await fetchRSS(account);
    for (const item of items) {
      const title = item.title || '';
      const description = item.contentSnippet || item.content || '';

      // فلترة AI
      if (USE_AI_FILTER) {
        const relevant = await isRelevantNewsAI(title, description);
        if (!relevant) continue;
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // بصمة المنع
      const hash = generateHash(title, description);
      if (seenHashes.has(hash)) {
        // تخطي المكرر
        continue;
      }

      const sent = await sendNewsItem(item);
      if (sent) {
        seenHashes.add(hash);
        saveLocalHashes();
        pushHashesToGitHub().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        log(`⏳ إعادة محاولة "${title}" لاحقاً.`);
      }
    }
  }
}

// ---------- دورة 15 نشاط / 3 راحة ----------
let fetchTimer = null;
let activeTimeout = null;
let restTimeout = null;

function startActiveCycle() {
  if (fetchTimer) clearInterval(fetchTimer);
  log('🟢 بدء دورة النشاط (15 دقيقة).');
  // تنفيذ فوري
  processAllAccounts().catch(e => log('خطأ: ' + e));
  fetchTimer = setInterval(() => {
    log('🔍 جلب دوري داخل النافذة النشطة.');
    processAllAccounts().catch(e => log('خطأ: ' + e));
  }, FETCH_INTERVAL);

  activeTimeout = setTimeout(() => {
    log('🔴 انتهت دورة النشاط، الدخول في راحة 3 دقائق.');
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

// مستمع document لاستقبال ملف التحديث (يعمل فقط عندما expectingCodeUpdate = true)
bot.on('document', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID || !expectingCodeUpdate) return;
  const fileId = ctx.message.document.file_id;
  const fileName = ctx.message.document.file_name || 'bot.js';
  if (!fileName.endsWith('.js')) {
    return ctx.reply('❌ الملف يجب أن يكون .js');
  }
  try {
    const fileUrl = await bot.telegram.getFileLink(fileId);
    const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
    const code = Buffer.from(response.data).toString('utf8');
    const currentFile = path.join(__dirname, 'bot.js');
    fs.writeFileSync(currentFile, code, 'utf8');
    ctx.reply('✅ تم تحديث الكود. جاري إعادة التشغيل...');
    log('🔄 إعادة تشغيل البوت لتطبيق الكود الجديد.');
    stopFetching();
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    ctx.reply('❌ فشل تحديث الكود: ' + e.message);
  }
  expectingCodeUpdate = false;
});

// الأوامر
bot.command('start', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ غير مصرح.');
  ctx.reply('👋 مرحباً أدمن. استخدم /help للأوامر.');
});

bot.command('help', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.reply(`📋 الأوامر المتاحة:
/status - حالة البوت
/logs - آخر السجلات
/updatecode - تحديث الكود
/filters - عرض القوائم
/addwhite كلمة
/delwhite كلمة
/addblack كلمة
/delblack كلمة`);
});

bot.command('status', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const active = fetchTimer ? 'نشط' : 'متوقف';
  ctx.reply(`✅ البوت يعمل
📡 حالة الجلب: ${active}
📬 الأخبار المخزنة: ${seenHashes.size}
🕒 الوقت: ${new Date().toLocaleString()}`);
});

bot.command('logs', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  if (logLines.length === 0) return ctx.reply('لا سجلات.');
  ctx.reply(`📋 آخر ${logLines.length} سطر:\n<pre>${logLines.join('\n')}</pre>`, { parse_mode: 'HTML' });
});

bot.command('updatecode', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  expectingCodeUpdate = true;
  ctx.reply('📥 أرسل ملف bot.js الجديد الآن (خلال 30 ثانية).');
  setTimeout(() => { expectingCodeUpdate = false; }, 30000);
});

bot.command('filters', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.reply(`📋 <b>القائمة البيضاء (${WHITELIST.length}):</b>\n${WHITELIST.join(', ') || 'فارغة'}\n\n🚫 <b>القائمة السوداء (${BLACKLIST.length}):</b>\n${BLACKLIST.join(', ') || 'فارغة'}`, { parse_mode: 'HTML' });
});
bot.command('addwhite', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const word = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!word) return ctx.reply('❌ استخدم: /addwhite كلمة');
  if (WHITELIST.includes(word)) return ctx.reply('موجودة مسبقاً.');
  WHITELIST.push(word);
  saveFilters();
  ctx.reply(`✅ أُضيفت "${word}".`);
});
bot.command('delwhite', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const word = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!word) return ctx.reply('❌ استخدم: /delwhite كلمة');
  WHITELIST = WHITELIST.filter(w => w !== word);
  saveFilters();
  ctx.reply(`🗑️ حُذفت "${word}".`);
});
bot.command('addblack', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const word = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!word) return ctx.reply('❌ استخدم: /addblack كلمة');
  if (BLACKLIST.includes(word)) return ctx.reply('موجودة مسبقاً.');
  BLACKLIST.push(word);
  saveFilters();
  ctx.reply(`✅ أُضيفت "${word}".`);
});
bot.command('delblack', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const word = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!word) return ctx.reply('❌ استخدم: /delblack كلمة');
  BLACKLIST = BLACKLIST.filter(w => w !== word);
  saveFilters();
  ctx.reply(`🗑️ حُذفت "${word}".`);
});

// ---------- تهيئة البوت ----------
async function init() {
  loadLocalHashes();
  await fetchRemoteHashes();
  loadFilters();

  // تشغيل البوت (تستقبل الأوامر)
  bot.launch();
  log('🤖 بوت الأخبار بدأ العمل.');

  // بدء الدورة
  startActiveCycle();
}

// معالجة الأعطال
process.on('uncaughtException', (err) => {
  log('💥 خطأ غير متوقع: ' + err.message);
});
process.on('unhandledRejection', (reason) => {
  log('⚠️ وعد مرفوض: ' + reason);
});

init().catch(err => {
  log('❌ فشل بدء التشغيل: ' + err.message);
  process.exit(1);
});
