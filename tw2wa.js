// tw2wa.js
// Free Twitter → WhatsApp using: Nitter (RSS first), Nitter HTML, Markdown harvest, Twitter Syndication JSON fallback + whatsapp-web.js
// Sends image (when present) + label + IST date/time + full tweet text.
// Install once:
// npm i whatsapp-web.js qrcode-terminal rss-parser node-fetch@2 he node-html-parser fs-extra puppeteer

"use strict";

const fs = require("fs-extra");
const path = require("path");
const Parser = require("rss-parser");
const fetch = require("node-fetch");          // v2 (CJS)
const { parse: htmlParse } = require("node-html-parser");
const he = require("he");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// -------- config --------
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

// PRIORITY first (your request)
const PRIORITY_HANDLES = [
  "@LiveLawIndia",
  "@lawbarandbench",
  "@barandbench",
  "@TheLeaflet_in",
  "@LawBeatInd",
  "@verdictum_in"
];

// Normalize & prioritize
const uniq = (arr) => [...new Set(arr)];
const allHandles = uniq((cfg.handles || []).map(h => h.trim()).filter(Boolean));
const prioritized = uniq([...PRIORITY_HANDLES, ...allHandles]);
cfg.handles = prioritized;

// -------- timing & state --------
const BASE_POLL_SECONDS = Number(cfg.pollSeconds || 45); // default 45s
const CHAT_NAME = cfg.chatName || "Tweets";
const POLL_MS_BASE = Math.max(20, BASE_POLL_SECONDS) * 1000;
const PER_HANDLE_PAUSE_MS = 700; // friendly spacing
const JITTER_MS = 10_000;        // ±10s jitter
const MAX_ITEMS_PER_HANDLE = Number(cfg.maxItemsPerHandle || 8); // cap per cycle
const CAPTION_MAX = 1000; // safe caption size for image messages
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SEEN_FILE = path.join(__dirname, "seen.json");
const seen = fs.existsSync(SEEN_FILE) ? JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")) : {};
const saveSeen = () => fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));

async function withRetry(fn, { retries = 2, minTimeout = 2000 } = {}) {
  let err;
  for (let a = 0; a <= retries; a++) {
    try { return await fn(); }
    catch (e) { err = e; if (a < retries) await sleep(minTimeout); }
  }
  throw err;
}

// -------- Nitter mirrors (avoid whitelist-only) --------
const NITTER_BASES = [
  "https://nitter.net",
  "https://nitter.poast.org",
  "https://nitter.privacydev.net",
  "https://nitter.tiekoetter.com",
  "https://nitter.space"
];

const parser = new Parser({
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8"
  }
});

const isXMLish = (s) => typeof s === "string" && s.trim().startsWith("<") && /<rss|<feed/i.test(s);
const looksLikeWhitelistBlock = (s) => /whitelist/i.test(s) && /rss reader not yet whitelist/i.test(s);
const looksLikeRateLimit = (s) => /rate limit|try again later|too many requests/i.test(s);
const looksLikeEmptyTimeline = (s) => /no tweets found|no statuses found|this account is private/i.test(s);

function handleToUser(h) { return h.replace(/^@/, ""); }

async function fetchRaw(url, referer) {
  const res = await fetch(url, {
    timeout: 25000,
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "*/*",
      ...(referer ? { "Referer": referer } : {})
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return await res.text();
}

// Try direct; if blocked/timed out, fetch via r.jina.ai proxy
async function fetchTextSmart(url, referer) {
  try { return await fetchRaw(url, referer); }
  catch (e1) {
    const plain = url.replace(/^https?:\/\//i, "");
    const viaHttp = `https://r.jina.ai/http://${plain}`;
    const viaHttps = `https://r.jina.ai/https://${plain}`;
    try { return await fetchRaw(viaHttp, referer); }
    catch (e2) {
      try { return await fetchRaw(viaHttps, referer); }
      catch (_) { throw e1; }
    }
  }
}

// ---------- FEED FETCHERS ----------

// 1) prefer RSS
async function fetchNitterRSS(handle) {
  const user = handleToUser(handle);
  let lastErr;
  for (const base of NITTER_BASES) {
    const url = `${base}/${encodeURIComponent(user)}/rss`;
    try {
      const body = await fetchTextSmart(url, base);
      if (looksLikeWhitelistBlock(body) || looksLikeRateLimit(body) || looksLikeEmptyTimeline(body)) {
        throw new Error("Mirror refused or empty timeline");
      }
      if (!isXMLish(body)) throw new Error("Non-XML response");
      return await parser.parseString(body);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("All Nitter RSS mirrors failed");
}

// 2) HTML timeline fallback (+ Markdown harvest)
async function fetchNitterHTML(handle) {
  const user = handleToUser(handle);
  let lastErr;
  for (const base of NITTER_BASES) {
    const url = `${base}/${encodeURIComponent(user)}`;
    try {
      const body = await fetchTextSmart(url, base);
      if (looksLikeWhitelistBlock(body) || looksLikeRateLimit(body)) throw new Error("Mirror refused");

      // If proxy returned Markdown, harvest status links, then fetch per-status OG for text+image+time
      if (/Markdown Content:/i.test(body)) {
        const mdLinks = extractStatusLinksMD(body).slice(0, MAX_ITEMS_PER_HANDLE);
        const items = [];
        for (const abs of mdLinks) {
          const og = await fetchStatusViaOG(abs);
          const ts = await getTweetTimeFromStatus(abs);
          if (og.text) items.push({ link: abs, content: og.text, _ts: ts || null, _image: og.image || null });
          await sleep(300);
        }
        if (items.length) return { items };
      }

      const itemsDom = parseNitterHTML(body, base);
      if (!itemsDom.length) throw new Error("No tweets found in HTML");
      return { items: itemsDom };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("All Nitter HTML mirrors failed");
}

// 3) Twitter Syndication CDN fallback (no auth, JSON → HTML body)
async function fetchSyndication(handle) {
  const user = handleToUser(handle);
  const url = `https://cdn.syndication.twimg.com/widgets/timelines/profile?screen_name=${encodeURIComponent(user)}&dnt=false&lang=en`;
  const txt = await fetchRaw(url);
  let data;
  try { data = JSON.parse(txt); } catch { throw new Error("Syndication JSON parse error"); }
  if (!data || !data.body) throw new Error("Syndication returned no body");
  const root = htmlParse(data.body);
  const nodes = root.querySelectorAll("[data-tweet-id]");
  const items = [];
  for (const node of nodes.slice(0, MAX_ITEMS_PER_HANDLE)) {
    const id = node.getAttribute("data-tweet-id");
    if (!id) continue;
    const textEl = node.querySelector(".timeline-Tweet-text, .Tweet-text, .timeline-Tweet") || node;
    const text = htmlToText(textEl.toString());
    if (!text) continue;
    const nitterLink = `https://nitter.net/${user}/status/${id}`;
    const ts = await getTweetTimeFromStatus(nitterLink);

    // Try image from the widget markup
    let img = null;
    const imgEl = node.querySelector("img");
    if (imgEl) {
      img = imgEl.getAttribute("src") || imgEl.getAttribute("data-src") || null;
      if (img && img.startsWith("//")) img = "https:" + img;
    }

    items.push({ link: nitterLink, content: text, _ts: ts || null, _image: img });
    await sleep(250);
  }
  if (!items.length) throw new Error("Syndication returned no tweets");
  return { items };
}

// ---------- Parsers & helpers ----------

function parseNitterHTML(html, base) {
  const root = htmlParse(
    html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
  );

  const timeline = root.querySelector(".timeline") || root;
  const nodes =
    timeline.querySelectorAll(".timeline-item, .timeline-status").length
      ? timeline.querySelectorAll(".timeline-item, .timeline-status")
      : timeline.querySelectorAll("article, .tweet, .status");

  const items = [];
  const seenIds = new Set();

  for (const node of nodes.slice(0, MAX_ITEMS_PER_HANDLE)) {
    const linkEl = node.querySelector('a[href*="/status/"]');
    if (!linkEl) continue;
    const href = linkEl.getAttribute("href") || "";
    const m = href.match(/\/status\/(\d+)/);
    if (!m) continue;
    const id = m[1];
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const contentEl =
      node.querySelector(".tweet-content") ||
      node.querySelector(".content") ||
      node.querySelector(".status-content") ||
      node.querySelector(".timeline-item .body") ||
      node;

    const text = htmlToText(contentEl.toString());
    if (!text) continue;

    let abs = href;
    if (abs.startsWith("/")) abs = base + abs;

    // Timestamp from anchor title (UTC)
    const tsTitle = (linkEl.getAttribute("title") || "").trim() || null;

    // First image (if present)
    let img = null;
    const imgEl = node.querySelector("a.still-image img") || node.querySelector("img");
    if (imgEl) {
      let src = imgEl.getAttribute("src");
      if (src && src.startsWith("/")) src = base + src;
      img = src || null;
    }

    items.push({
      link: abs,
      content: text,
      _ts: tsTitle,
      _image: img
    });
  }

  return items;
}

// Extract /status/... links from HTML
function extractStatusLinks(html, base) {
  const links = new Set();
  const re = /href="([^"]*\/status\/\d+[^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    if (!href.startsWith("http")) {
      href = href.startsWith("/") ? base + href : base + "/" + href;
    }
    links.add(href);
  }
  return [...links];
}

// Extract /status/... links from r.jina.ai Markdown
function extractStatusLinksMD(markdownText) {
  const links = new Set();
  const re = /\((https?:\/\/[^)]+\/status\/\d+[^)]*)\)/g;
  let m;
  while ((m = re.exec(markdownText)) !== null) links.add(m[1]);
  return [...links];
}

// Read tweet text + image from a single status page (via OG meta)
async function fetchStatusViaOG(absUrl) {
  const body = await fetchTextSmart(absUrl);
  const root = htmlParse(body);
  const ogDesc = root.querySelector('meta[property="og:description"]')?.getAttribute("content") || "";
  let ogImg = root.querySelector('meta[property="og:image"]')?.getAttribute("content") || null;
  if (ogImg && ogImg.startsWith("//")) ogImg = "https:" + ogImg;
  return { text: he.decode(ogDesc).trim(), image: ogImg };
}

// Read a human timestamp from a status page (prefers UTC title; format to IST if possible)
async function getTweetTimeFromStatus(absUrl) {
  const body = await fetchTextSmart(absUrl);
  const root = htmlParse(body);
  const a = root.querySelector('.tweet-date a[title]') || root.querySelector('a[title*="UTC"]') || root.querySelector('a[title]');
  const raw = (a && a.getAttribute("title")) ? a.getAttribute("title").trim() : null;
  if (!raw) return null;
  const parsed = Date.parse(raw.replace(/\uFFFD/g, ""));
  if (!isNaN(parsed)) return formatIST(new Date(parsed));
  return raw;
}

// master feed chooser
async function fetchFeed(handle) {
  try {
    return await withRetry(() => fetchNitterRSS(handle), { retries: 1, minTimeout: 1200 });
  } catch (_) {
    try {
      return await withRetry(() => fetchNitterHTML(handle), { retries: 1, minTimeout: 1200 });
    } catch (__){
      return await withRetry(() => fetchSyndication(handle), { retries: 1, minTimeout: 1200 });
    }
  }
}

// ---------- TEXT / TIME formatting ----------

function htmlToText(html) {
  if (!html) return "";
  const normalized = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/ul>/gi, "\n");
  const root = htmlParse(normalized);
  const text = he.decode(root.innerText || root.text || "");
  return text
    .split("\n")
    .map(s => s.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getTweetIdFromLink(link) {
  if (!link) return null;
  const m = link.match(/status\/(\d+)/);
  return m ? m[1] : link;
}

function extractText(item) {
  const rawHtml = item["content:encoded"] || item.content || "";
  let text = htmlToText(rawHtml);
  if (!text) {
    let t = item.title || "";
    t = t.replace(/^[^:]+:\s*/, "");
    text = he.decode(t).trim();
  }
  return text;
}

// Prefer IST; fall back to raw
function formatIST(d) {
  try {
    const fmt = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric", month: "short", day: "2-digit",
      hour: "numeric", minute: "2-digit", hour12: true
    });
    return fmt.format(d) + " IST";
  } catch { return d.toString(); }
}

// Build a display time for an item: RSS → IST; HTML → title; Syndication/status → parsed IST if possible
async function getDisplayTime(item) {
  if (item.isoDate) {
    const d = new Date(item.isoDate);
    if (!isNaN(d)) return formatIST(d);
  }
  if (item._ts) {
    const parsed = Date.parse(item._ts.replace(/\uFFFD/g, ""));
    if (!isNaN(parsed)) return formatIST(new Date(parsed));
    return item._ts; // raw (likely UTC)
  }
  if (item.link && item.link.includes("/status/")) {
    const ts = await getTweetTimeFromStatus(item.link);
    if (ts) return ts;
  }
  return "";
}

// Pick an image url from the item (supports HTML, RSS, Syndication, Markdown OG)
function pickImage(item) {
  if (item._image) return item._image;
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  if (item.enclosures && item.enclosures[0] && item.enclosures[0].url) return item.enclosures[0].url;
  const html = item["content:encoded"] || item.content || "";
  const m = html.match(/<img[^>]+src="([^"]+)"/i);
  return m ? m[1] : null;
}

// ---------- WhatsApp helpers ----------

async function getChatIdByName(client, name) {
  const chats = await client.getChats();
  const exact = chats.find(c => c.name && c.name.trim() === name.trim());
  if (exact) return exact.id._serialized;
  const ci = chats.find(c => (c.name || "").toLowerCase() === name.trim().toLowerCase());
  if (ci) return ci.id._serialized;
  throw new Error(`WhatsApp chat named "${name}" not found. Create a group named exactly ${name}.`);
}

async function sendToWhatsApp(client, chatId, label, timeStr, text, imageUrl) {
  const timeLine = timeStr ? `${timeStr}\n\n` : "";
  const body = `${label}:\n${timeLine}${text}`;

  if (imageUrl) {
    try {
      const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
      // If caption too long, split: short caption + full text separately
      if (body.length > CAPTION_MAX) {
        const shortCap = `${label}:\n${timeStr || ""}`.trim();
        await client.sendMessage(chatId, media, { caption: shortCap });
        await client.sendMessage(chatId, text, { linkPreview: false });
      } else {
        await client.sendMessage(chatId, media, { caption: body });
      }
      return;
    } catch (e) {
      console.log("Image send failed, sending text only:", e.message);
    }
  }

  await client.sendMessage(chatId, body, { linkPreview: false });
}

// ---------- Main polling (priority + jitter) ----------

async function pollOnce(client, chatId) {
  for (const handle of cfg.handles) {
    let changed = false;
    try {
      const feed = await fetchFeed(handle);
      const items = (feed.items || []);
      const subset = items.slice(-MAX_ITEMS_PER_HANDLE); // newest N
      for (const item of subset.reverse()) {
        const id = getTweetIdFromLink(item.link);
        if (!id) continue;
        const key = `${handle}:${id}`;
        if (seen[key]) continue;

        const text = extractText(item);
        if (!text) { seen[key] = true; changed = true; continue; }

        const label = (cfg.labels && cfg.labels[handle]) || handle.replace(/^@/, "");
        const timeStr = await getDisplayTime(item);
        const imageUrl = pickImage(item);

        await sendToWhatsApp(client, chatId, label, timeStr, text, imageUrl);

        seen[key] = true;
        changed = true;
      }
    } catch (e) {
      console.log(`Feed error for ${handle}: ${e.message}`);
    }
    if (changed) saveSeen();
    await sleep(PER_HANDLE_PAUSE_MS);
  }
}

let waClient = null;

(async function main() {
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
    // Pin a stable WhatsApp Web build; or set to { type: "none" } to always use the live official build
    webVersionCache: {
      type: "remote",
      remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/latest.html"
    }
  });
  waClient = client;

  client.on("qr", qr => qrcode.generate(qr, { small: true }));
  client.on("ready", async () => {
    console.log("WhatsApp ready.");
    try {
      const chatId = await getChatIdByName(client, CHAT_NAME);
      console.log(`Sending to chat: ${CHAT_NAME}`);

      // loop with jitter (not fixed interval)
      const loop = async () => {
        await pollOnce(client, chatId);
        const jitter = Math.floor((Math.random() * 2 * JITTER_MS) - JITTER_MS);
        setTimeout(loop, POLL_MS_BASE + jitter);
      };
      await loop();
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  });

  client.on("auth_failure", m => console.error("Auth failure:", m));
  client.on("disconnected", r => console.error("Disconnected:", r));

  process.on("SIGINT", async () => {
    try { if (waClient) await waClient.destroy(); } catch {}
    try { saveSeen(); } catch {}
    process.exit(0);
  });

  client.initialize();
})();
