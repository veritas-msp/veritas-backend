import fetch from "node-fetch";
import { getEnabledFeedsForLocale } from "./techNewsFeedsConfig.js";

const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_ITEMS_PER_FEED = 8;
const MAX_TOTAL_ITEMS = 28;

const ALLOWED_LOCALES = ["fr", "en", "de", "it", "es"];

/** @type {Map<string, { expiresAt: number, payload: object }>} */
const cache = new Map();

function hashString(input) {
  let hash = 0;
  const s = String(input);
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeLocale(locale) {
  const code = String(locale || "fr")
    .trim()
    .toLowerCase()
    .slice(0, 2);
  return ALLOWED_LOCALES.includes(code) ? code : "fr";
}

function decodeEntities(text) {
  if (!text) return "";
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function normalizeCharset(charset) {
  const raw = String(charset || "utf-8").trim().toLowerCase();
  const compact = raw.replace(/[_\s-]/g, "");
  if (compact === "utf8") return "utf-8";
  if (["iso88591", "latin1", "latin", "l1"].includes(compact)) return "iso-8859-1";
  if (["windows1252", "cp1252", "winlatin1"].includes(compact)) return "windows-1252";
  return raw;
}

function decodeBytes(buffer, charset) {
  const normalized = normalizeCharset(charset);
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

function countReplacementChars(text) {
  let count = 0;
  for (const ch of text) {
    if (ch === "\uFFFD") count += 1;
  }
  return count;
}

function detectCharsetFromXmlHead(headLatin1) {
  const match = headLatin1.match(/<\?xml[^>]*encoding=["']([^"']+)["']/i);
  return match ? normalizeCharset(match[1]) : null;
}

function decodeFeedBody(buffer, contentType) {
  const headLatin1 = buffer.subarray(0, Math.min(buffer.length, 2048)).toString("latin1");
  const headerCharset = (contentType || "").match(/charset=([^;\s]+)/i)?.[1] || null;
  const xmlCharset = detectCharsetFromXmlHead(headLatin1);
  const primary = xmlCharset || headerCharset || "utf-8";

  let text = decodeBytes(buffer, primary);

  if (normalizeCharset(primary) === "utf-8" && countReplacementChars(text) > 0) {
    for (const fallback of ["windows-1252", "iso-8859-1"]) {
      const candidate = decodeBytes(buffer, fallback);
      if (countReplacementChars(candidate) < countReplacementChars(text)) {
        text = candidate;
      }
    }
  }

  return text;
}

function stripHtml(html) {
  return decodeEntities(String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function extractTag(block, tagNames) {
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = block.match(re);
    if (m) return decodeEntities(m[1].trim());
  }
  return "";
}

function extractLink(block) {
  const atomLink = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (atomLink) return atomLink[1].trim();
  const rssLink = extractTag(block, ["link"]);
  if (rssLink) return rssLink;
  const guid = extractTag(block, ["guid", "id"]);
  if (guid.startsWith("http")) return guid;
  return "";
}

function parseFeedXml(xml, feedMeta) {
  const items = [];
  const blocks = [
    ...(xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []),
    ...(xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []),
  ];

  for (const block of blocks.slice(0, MAX_ITEMS_PER_FEED)) {
    const title = extractTag(block, ["title"]);
    const link = extractLink(block);
    if (!title || !link) continue;

    const published =
      parseDate(extractTag(block, ["pubDate", "published", "updated", "dc:date"])) || null;
    const description = stripHtml(
      extractTag(block, ["description", "summary", "content", "content:encoded"])
    ).slice(0, 220);

    const id = `${feedMeta.id}-${hashString(`${link}|${title}`)}`;

    items.push({
      id,
      title: title.slice(0, 300),
      link,
      publishedAt: published,
      source: feedMeta.source,
      category: feedMeta.category,
      snippet: description,
    });
  }

  return items;
}

async function fetchFeedXml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Veritas-MSP/1.0 (+https://veritas.local)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return decodeFeedBody(buffer, res.headers.get("content-type"));
  } finally {
    clearTimeout(timer);
  }
}

async function loadLocaleFeeds(locale) {
  const feeds = await getEnabledFeedsForLocale(locale);
  if (feeds.length === 0) return [];
  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      const xml = await fetchFeedXml(feed.url);
      return parseFeedXml(xml, feed);
    })
  );

  const merged = [];
  for (const result of results) {
    if (result.status === "fulfilled") merged.push(...result.value);
  }

  merged.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

  const seen = new Set();
  const deduped = [];
  for (const item of merged) {
    const key = item.link.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= MAX_TOTAL_ITEMS) break;
  }

  return deduped;
}

export async function getTechNewsFeed(localeInput) {
  const locale = normalizeLocale(localeInput);
  const now = Date.now();
  const cached = cache.get(locale);
  if (cached && cached.expiresAt > now) {
    return cached.payload;
  }

  let items = [];
  let partial = false;
  try {
    items = await loadLocaleFeeds(locale);
  } catch {
    partial = true;
  }

  if (items.length === 0 && locale !== "en") {
    try {
      items = await loadLocaleFeeds("en");
      partial = true;
    } catch {
      /* ignore */
    }
  }

  const payload = {
    locale,
    fetchedAt: new Date().toISOString(),
    partial,
    items,
  };

  cache.set(locale, { expiresAt: now + CACHE_TTL_MS, payload });
  return payload;
}

export function clearTechNewsCache() {
  cache.clear();
}
