import axios from "axios";
import * as cheerio from "cheerio";
import dotenv from "dotenv";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

dotenv.config();

/* =======================
   CONFIG
======================= */
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHANNEL = process.env.CHANNEL_ID;
const USERS = ["BBCWorld", "Reuters", "elonmusk"];

const FILE = "seen.json";

/* =======================
   STORAGE
======================= */
function loadSeen() {
  if (!fs.existsSync(FILE)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(FILE)));
}

function saveSeen(seen) {
  fs.writeFileSync(FILE, JSON.stringify([...seen]));
}

let seen = loadSeen();

function makeId(text) {
  return Buffer.from(text).toString("base64");
}

/* =======================
   AI CLASSIFIER (UPDATED)
======================= */
async function classifyContent(text) {
  try {
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
أنت نظام تصنيف أخبار دقيق.

صنف النص إلى واحد فقط:

- news → خبر حقيقي فيه حدث + جهة + معنى واضح
- opinion → تحليل أو رأي
- clickbait → عنوان مضلل أو مبالغ فيه
- irrelevant → غير خبري (نصائح، صحة، ترفيه...)

أجب بكلمة واحدة فقط بدون شرح.
          `,
        },
        { role: "user", content: text },
      ],
    });

    return res.choices[0].message.content.trim().toLowerCase();
  } catch {
    return "irrelevant";
  }
}

/* =======================
   SCRAPE X (NITTER)
======================= */
async function fetchX(user) {
  try {
    const url = `https://nitter.net/${user}`;
    const res = await axios.get(url);

    const $ = cheerio.load(res.data);
    let posts = [];

    $(".timeline-item").each((i, el) => {
      const text = $(el).find(".tweet-content").text().trim();

      if (text.length > 20) {
        posts.push({
          title: text.slice(0, 80),
          description: text,
          link: `https://x.com/${user}`,
        });
      }
    });

    return posts;
  } catch {
    return [];
  }
}

/* =======================
   TELEGRAM SEND
======================= */
async function sendNews(title, text, link) {
  const msg = `📰 ${title}\n\n${text}\n\n🔗 ${link}`;
  return bot.sendMessage(CHANNEL, msg);
}

/* =======================
   MAIN LOOP
======================= */
async function run() {
  console.log("Checking news...");

  for (let user of USERS) {
    const posts = await fetchX(user);

    for (let post of posts) {
      const id = makeId(post.description);

      if (seen.has(id)) continue;

      const type = await classifyContent(post.description);

      // 🚫 فلترة قوية
      if (type !== "news") continue;

      await sendNews(post.title, post.description, post.link);

      seen.add(id);
      saveSeen(seen);
    }
  }
}

/* =======================
   START BOT
======================= */
run();
setInterval(run, 60 * 1000);
