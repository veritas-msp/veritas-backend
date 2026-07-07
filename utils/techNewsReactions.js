import { pool } from "../database/db.js";

export const ALLOWED_REACTION_EMOJIS = ["👍", "👀", "🔥", "😱", "💡", "🎯", "⚠️", "❤️"];

/** @type {Set<import('express').Response>} */
const streamClients = new Set();

let tableReady = false;

export async function ensureTechNewsReactionsTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS v_b_tech_news_reactions (
      id SERIAL PRIMARY KEY,
      article_id TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES v_b_users(id) ON DELETE CASCADE,
      emoji VARCHAR(16) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (article_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tech_news_reactions_article
      ON v_b_tech_news_reactions(article_id);
  `);
  tableReady = true;
}

function displayNameFromRow(row) {
  const username = String(row?.username || "").trim();
  if (username) return username;
  const email = String(row?.email || "").trim();
  if (!email) return "Utilisateur";
  const local = email.split("@")[0] || email;
  return local
    .split(/[._+\-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

function emptyArticleReactions() {
  return Object.fromEntries(ALLOWED_REACTION_EMOJIS.map((emoji) => [emoji, []]));
}

function buildArticleReactions(rows) {
  const grouped = emptyArticleReactions();
  for (const row of rows) {
    if (!ALLOWED_REACTION_EMOJIS.includes(row.emoji)) continue;
    grouped[row.emoji].push({
      userId: row.user_id,
      displayName: displayNameFromRow(row),
      reactedAt: row.updated_at || row.created_at,
    });
  }
  return grouped;
}

export async function getReactionsForArticles(articleIds = [], currentUserId = null) {
  await ensureTechNewsReactionsTable();
  const ids = [...new Set(articleIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (ids.length === 0) {
    return { articles: {}, mine: {} };
  }

  const result = await pool.query(
    `SELECT r.article_id, r.user_id, r.emoji, r.created_at, r.updated_at,
            u.username, u.email
     FROM v_b_tech_news_reactions r
     JOIN v_b_users u ON u.id = r.user_id
     WHERE r.article_id = ANY($1::text[])
     ORDER BY r.updated_at ASC`,
    [ids]
  );

  const articles = {};
  const mine = {};

  for (const id of ids) {
    articles[id] = emptyArticleReactions();
  }

  for (const row of result.rows) {
    if (!articles[row.article_id]) {
      articles[row.article_id] = emptyArticleReactions();
    }
    if (!ALLOWED_REACTION_EMOJIS.includes(row.emoji)) continue;
    articles[row.article_id][row.emoji].push({
      userId: row.user_id,
      displayName: displayNameFromRow(row),
      reactedAt: row.updated_at || row.created_at,
    });
    if (currentUserId && row.user_id === currentUserId) {
      mine[row.article_id] = row.emoji;
    }
  }

  return { articles, mine };
}

export async function getArticleReactions(articleId, currentUserId = null) {
  await ensureTechNewsReactionsTable();
  const id = String(articleId || "").trim();
  if (!id) return { articleId: id, reactions: emptyArticleReactions(), mine: null };

  const result = await pool.query(
    `SELECT r.user_id, r.emoji, r.created_at, r.updated_at, u.username, u.email
     FROM v_b_tech_news_reactions r
     JOIN v_b_users u ON u.id = r.user_id
     WHERE r.article_id = $1
     ORDER BY r.updated_at ASC`,
    [id]
  );

  const reactions = buildArticleReactions(result.rows);
  const mineRow = currentUserId
    ? result.rows.find((row) => row.user_id === currentUserId)
    : null;

  return {
    articleId: id,
    reactions,
    mine: mineRow?.emoji || null,
  };
}

export async function toggleTechNewsReaction(articleId, userId, emoji) {
  await ensureTechNewsReactionsTable();
  const id = String(articleId || "").trim();
  const normalizedEmoji = String(emoji || "").trim();

  if (!id) {
    const err = new Error("Article invalide");
    err.status = 400;
    throw err;
  }
  if (!ALLOWED_REACTION_EMOJIS.includes(normalizedEmoji)) {
    const err = new Error("Emoji non autorisé");
    err.status = 400;
    throw err;
  }

  const existing = await pool.query(
    `SELECT emoji FROM v_b_tech_news_reactions WHERE article_id = $1 AND user_id = $2`,
    [id, userId]
  );

  let action = "added";
  if (existing.rows[0]?.emoji === normalizedEmoji) {
    await pool.query(
      `DELETE FROM v_b_tech_news_reactions WHERE article_id = $1 AND user_id = $2`,
      [id, userId]
    );
    action = "removed";
  } else if (existing.rows[0]) {
    await pool.query(
      `UPDATE v_b_tech_news_reactions
       SET emoji = $1, updated_at = NOW()
       WHERE article_id = $2 AND user_id = $3`,
      [normalizedEmoji, id, userId]
    );
    action = "updated";
  } else {
    await pool.query(
      `INSERT INTO v_b_tech_news_reactions (article_id, user_id, emoji)
       VALUES ($1, $2, $3)`,
      [id, userId, normalizedEmoji]
    );
  }

  const payload = await getArticleReactions(id, userId);
  broadcastReactionUpdate({ type: "reaction", action, ...payload });
  return { action, ...payload };
}

export function addReactionStreamClient(res) {
  streamClients.add(res);
}

export function removeReactionStreamClient(res) {
  streamClients.delete(res);
}

export function broadcastReactionUpdate(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of streamClients) {
    try {
      client.write(data);
    } catch {
      streamClients.delete(client);
    }
  }
}

export function broadcastReactionHeartbeat() {
  const data = `data: ${JSON.stringify({ type: "heartbeat", at: new Date().toISOString() })}\n\n`;
  for (const client of streamClients) {
    try {
      client.write(data);
    } catch {
      streamClients.delete(client);
    }
  }
}
