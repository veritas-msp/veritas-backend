import { pool } from "../database/db.js";
export const ALLOWED_FEED_LOCALES = ["fr", "en", "de", "it", "es"];
export const ALLOWED_FEED_CATEGORIES = ["cve", "security", "news", "tech"];
export const DEFAULT_FEEDS_BY_LOCALE = {
  fr: [{
    feed_key: "cert-fr",
    category: "security",
    source: "CERT-FR",
    url: "https://www.cert.ssi.gouv.fr/alerte/feed/"
  }, {
    feed_key: "zdnet-fr",
    category: "news",
    source: "ZDNet France",
    url: "https://www.zdnet.fr/feeds/rss/"
  }, {
    feed_key: "lemonde-info",
    category: "news",
    source: "Le Monde Informatique",
    url: "https://www.lemondeinformatique.fr/flux-rss/thematique/toute-l-actualite/rss.xml"
  }, {
    feed_key: "it-connect",
    category: "tech",
    source: "IT-Connect",
    url: "https://www.it-connect.fr/feed/"
  }, {
    feed_key: "journalduhacker",
    category: "tech",
    source: "Journal du Hacker",
    url: "https://www.journalduhacker.net/rss"
  }, {
    feed_key: "cisa",
    category: "cve",
    source: "CISA",
    url: "https://www.cisa.gov/cybersecurity-advisories/all.xml"
  }, {
    feed_key: "exploitdb",
    category: "cve",
    source: "Exploit-DB",
    url: "https://www.exploit-db.com/rss.xml"
  }],
  en: [{
    feed_key: "thn",
    category: "security",
    source: "The Hacker News",
    url: "https://feeds.feedburner.com/TheHackersNews"
  }, {
    feed_key: "bleeping",
    category: "security",
    source: "BleepingComputer",
    url: "https://www.bleepingcomputer.com/feed/"
  }, {
    feed_key: "cisa",
    category: "cve",
    source: "CISA",
    url: "https://www.cisa.gov/cybersecurity-advisories/all.xml"
  }, {
    feed_key: "exploitdb",
    category: "cve",
    source: "Exploit-DB",
    url: "https://www.exploit-db.com/rss.xml"
  }, {
    feed_key: "ars",
    category: "tech",
    source: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/technology"
  }, {
    feed_key: "register",
    category: "news",
    source: "The Register",
    url: "https://www.theregister.com/headlines.atom"
  }],
  de: [{
    feed_key: "heise",
    category: "security",
    source: "Heise Security",
    url: "https://www.heise.de/security/rss/news.rss"
  }, {
    feed_key: "golem",
    category: "tech",
    source: "Golem.de",
    url: "https://rss.golem.de/rss.php?tp=se&ty=1"
  }, {
    feed_key: "cisa",
    category: "cve",
    source: "CISA",
    url: "https://www.cisa.gov/cybersecurity-advisories/all.xml"
  }, {
    feed_key: "thn",
    category: "security",
    source: "The Hacker News",
    url: "https://feeds.feedburner.com/TheHackersNews"
  }],
  it: [{
    feed_key: "punto",
    category: "tech",
    source: "Punto Informatico",
    url: "https://www.punto-informatico.it/feed/"
  }, {
    feed_key: "hwupgrade",
    category: "news",
    source: "HWUpgrade",
    url: "https://www.hwupgrade.it/rss/rss_news.xml"
  }, {
    feed_key: "cisa",
    category: "cve",
    source: "CISA",
    url: "https://www.cisa.gov/cybersecurity-advisories/all.xml"
  }, {
    feed_key: "bleeping",
    category: "security",
    source: "BleepingComputer",
    url: "https://www.bleepingcomputer.com/feed/"
  }],
  es: [{
    feed_key: "xataka",
    category: "tech",
    source: "Xataka",
    url: "https://www.xataka.com/index.xml"
  }, {
    feed_key: "muycomputer",
    category: "news",
    source: "MuyComputer",
    url: "https://www.muycomputer.com/feed/"
  }, {
    feed_key: "cisa",
    category: "cve",
    source: "CISA",
    url: "https://www.cisa.gov/cybersecurity-advisories/all.xml"
  }, {
    feed_key: "thn",
    category: "security",
    source: "The Hacker News",
    url: "https://feeds.feedburner.com/TheHackersNews"
  }]
};
let tableReady = false;
function normalizeLocale(locale) {
  const code = String(locale || "fr").trim().toLowerCase().slice(0, 2);
  return ALLOWED_FEED_LOCALES.includes(code) ? code : "fr";
}
function normalizeCategory(category) {
  const value = String(category || "news").trim().toLowerCase();
  return ALLOWED_FEED_CATEGORIES.includes(value) ? value : "news";
}
function slugifyFeedKey(value) {
  return String(value || "feed").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "feed";
}
function mapFeedRow(row) {
  return {
    id: row.id,
    locale: row.locale,
    feedKey: row.feed_key,
    source: row.source,
    url: row.url,
    category: row.category,
    enabled: Boolean(row.enabled),
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
export async function ensureTechNewsFeedsTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS v_b_tech_news_feeds (
      id SERIAL PRIMARY KEY,
      locale VARCHAR(5) NOT NULL,
      feed_key VARCHAR(64) NOT NULL,
      source VARCHAR(120) NOT NULL,
      url TEXT NOT NULL,
      category VARCHAR(16) NOT NULL DEFAULT 'news',
      enabled BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (locale, feed_key)
    );
    CREATE INDEX IF NOT EXISTS idx_tech_news_feeds_locale_enabled
      ON v_b_tech_news_feeds(locale, enabled, sort_order);
  `);
  await pool.query(`
    DELETE FROM v_b_tech_news_feeds a
    USING v_b_tech_news_feeds b
    WHERE a.ctid < b.ctid
      AND a.locale = b.locale
      AND a.feed_key = b.feed_key
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS v_b_tech_news_feeds_locale_feed_key_uniq
      ON v_b_tech_news_feeds (locale, feed_key)
  `);
  tableReady = true;
}
async function seedDefaultsIfEmpty(locale) {
  const loc = normalizeLocale(locale);
  const count = await pool.query(`SELECT COUNT(*)::int AS count FROM v_b_tech_news_feeds WHERE locale = $1`, [loc]);
  if (Number(count.rows[0]?.count) > 0) return;
  const defaults = DEFAULT_FEEDS_BY_LOCALE[loc] || [];
  for (let i = 0; i < defaults.length; i += 1) {
    const feed = defaults[i];
    await pool.query(`INSERT INTO v_b_tech_news_feeds (locale, feed_key, source, url, category, enabled, sort_order)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       ON CONFLICT (locale, feed_key) DO NOTHING`, [loc, feed.feed_key, feed.source, feed.url, feed.category, i * 10]);
  }
}
export async function listTechNewsFeeds(localeInput, {
  includeDisabled = true
} = {}) {
  await ensureTechNewsFeedsTable();
  const locale = normalizeLocale(localeInput);
  await seedDefaultsIfEmpty(locale);
  const conditions = ["locale = $1"];
  const params = [locale];
  if (!includeDisabled) {
    conditions.push("enabled = true");
  }
  const result = await pool.query(`SELECT id, locale, feed_key, source, url, category, enabled, sort_order, created_at, updated_at
     FROM v_b_tech_news_feeds
     WHERE ${conditions.join(" AND ")}
     ORDER BY sort_order ASC, id ASC`, params);
  return result.rows.map(mapFeedRow);
}
export async function getEnabledFeedsForLocale(localeInput) {
  const feeds = await listTechNewsFeeds(localeInput, {
    includeDisabled: false
  });
  return feeds.map(feed => ({
    id: feed.feedKey,
    source: feed.source,
    url: feed.url,
    category: feed.category
  }));
}
export async function createTechNewsFeed(payload) {
  await ensureTechNewsFeedsTable();
  const locale = normalizeLocale(payload.locale);
  const source = String(payload.source || "").trim();
  const url = String(payload.url || "").trim();
  if (!source || !url) {
    const err = new Error("Feed name and URL are required.");
    err.status = 400;
    throw err;
  }
  if (!/^https?:\/\//i.test(url)) {
    const err = new Error("The feed URL must start with http:// or https://");
    err.status = 400;
    throw err;
  }
  let feedKey = slugifyFeedKey(payload.feedKey || source);
  const exists = await pool.query(`SELECT id FROM v_b_tech_news_feeds WHERE locale = $1 AND feed_key = $2`, [locale, feedKey]);
  if (exists.rows.length > 0) {
    feedKey = `${feedKey}-${Date.now().toString(36)}`;
  }
  const sortOrder = Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : (await pool.query(`SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM v_b_tech_news_feeds WHERE locale = $1`, [locale])).rows[0].next;
  const result = await pool.query(`INSERT INTO v_b_tech_news_feeds (locale, feed_key, source, url, category, enabled, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, locale, feed_key, source, url, category, enabled, sort_order, created_at, updated_at`, [locale, feedKey, source, url, normalizeCategory(payload.category), payload.enabled !== false, sortOrder]);
  return mapFeedRow(result.rows[0]);
}
export async function updateTechNewsFeed(id, payload) {
  await ensureTechNewsFeedsTable();
  const feedId = Number(id);
  if (!Number.isInteger(feedId) || feedId <= 0) {
    const err = new Error("Feed not found.");
    err.status = 404;
    throw err;
  }
  const existing = await pool.query(`SELECT * FROM v_b_tech_news_feeds WHERE id = $1`, [feedId]);
  if (!existing.rows[0]) {
    const err = new Error("Feed not found.");
    err.status = 404;
    throw err;
  }
  const row = existing.rows[0];
  const source = payload.source !== undefined ? String(payload.source).trim() : row.source;
  const url = payload.url !== undefined ? String(payload.url).trim() : row.url;
  if (!source || !url) {
    const err = new Error("Feed name and URL are required.");
    err.status = 400;
    throw err;
  }
  if (!/^https?:\/\//i.test(url)) {
    const err = new Error("The feed URL must start with http:// or https://");
    err.status = 400;
    throw err;
  }
  const result = await pool.query(`UPDATE v_b_tech_news_feeds
     SET source = $1,
         url = $2,
         category = $3,
         enabled = $4,
         sort_order = $5,
         updated_at = NOW()
     WHERE id = $6
     RETURNING id, locale, feed_key, source, url, category, enabled, sort_order, created_at, updated_at`, [source, url, payload.category !== undefined ? normalizeCategory(payload.category) : row.category, payload.enabled !== undefined ? Boolean(payload.enabled) : row.enabled, payload.sortOrder !== undefined ? Number(payload.sortOrder) : row.sort_order, feedId]);
  return mapFeedRow(result.rows[0]);
}
export async function deleteTechNewsFeed(id) {
  await ensureTechNewsFeedsTable();
  const feedId = Number(id);
  const result = await pool.query(`DELETE FROM v_b_tech_news_feeds WHERE id = $1 RETURNING id`, [feedId]);
  if (!result.rows[0]) {
    const err = new Error("Feed not found.");
    err.status = 404;
    throw err;
  }
  return {
    success: true
  };
}
export async function resetTechNewsFeedsForLocale(localeInput) {
  await ensureTechNewsFeedsTable();
  const locale = normalizeLocale(localeInput);
  await pool.query(`DELETE FROM v_b_tech_news_feeds WHERE locale = $1`, [locale]);
  await seedDefaultsIfEmpty(locale);
  return listTechNewsFeeds(locale);
}
export function getTechNewsFeedsMeta() {
  return {
    locales: ALLOWED_FEED_LOCALES,
    categories: ALLOWED_FEED_CATEGORIES,
    categoryLabels: {
      cve: "CVE",
      security: "Security",
      news: "News",
      tech: "Technology"
    }
  };
}
