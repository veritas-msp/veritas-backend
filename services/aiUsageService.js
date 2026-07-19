import { pool } from "../database/db.js";

let schemaReady = false;

export async function ensureAiUsageSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS v_b_ai_usage (
      id BIGSERIAL PRIMARY KEY,
      used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id UUID NULL,
      feature VARCHAR(64) NOT NULL,
      provider VARCHAR(32) NOT NULL,
      model VARCHAR(128) NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      success BOOLEAN NOT NULL DEFAULT TRUE,
      error_message TEXT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_v_b_ai_usage_used_at ON v_b_ai_usage (used_at DESC)
  `);
  schemaReady = true;
}

export async function getAiTokensUsedToday() {
  await ensureAiUsageSchema();
  const result = await pool.query(
    `SELECT COALESCE(SUM(total_tokens), 0)::int AS used
     FROM v_b_ai_usage
     WHERE success = TRUE
       AND used_at >= date_trunc('day', NOW())`
  );
  return Number(result.rows[0]?.used || 0);
}

export async function assertAiQuotaAvailable(maxTokensPerDay, estimated = 0) {
  const used = await getAiTokensUsedToday();
  if (used + estimated > maxTokensPerDay) {
    const err = new Error("Quota IA journalier atteint");
    err.code = "AI_QUOTA_EXCEEDED";
    err.used = used;
    err.limit = maxTokensPerDay;
    throw err;
  }
  return { used, limit: maxTokensPerDay };
}

export async function recordAiUsage({
  userId = null,
  feature,
  provider,
  model,
  promptTokens = 0,
  completionTokens = 0,
  success = true,
  errorMessage = null,
}) {
  await ensureAiUsageSchema();
  const total = Math.max(0, Number(promptTokens) || 0) + Math.max(0, Number(completionTokens) || 0);
  await pool.query(
    `INSERT INTO v_b_ai_usage
      (user_id, feature, provider, model, prompt_tokens, completion_tokens, total_tokens, success, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      userId || null,
      String(feature || "unknown").slice(0, 64),
      String(provider || "unknown").slice(0, 32),
      model ? String(model).slice(0, 128) : null,
      Math.max(0, Number(promptTokens) || 0),
      Math.max(0, Number(completionTokens) || 0),
      total,
      Boolean(success),
      errorMessage ? String(errorMessage).slice(0, 1000) : null,
    ]
  );
  return total;
}

export async function listAiUsage({ limit = 50, offset = 0 } = {}) {
  await ensureAiUsageSchema();
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const result = await pool.query(
    `SELECT u.id, u.used_at, u.user_id, u.feature, u.provider, u.model,
            u.prompt_tokens, u.completion_tokens, u.total_tokens, u.success, u.error_message,
            COALESCE(NULLIF(TRIM(usr.username), ''), usr.email) AS user_name
     FROM v_b_ai_usage u
     LEFT JOIN v_b_users usr ON usr.id = u.user_id
     ORDER BY u.used_at DESC
     LIMIT $1 OFFSET $2`,
    [safeLimit, safeOffset]
  );
  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM v_b_ai_usage`);
  return {
    rows: result.rows,
    total: countResult.rows[0]?.total || 0,
    limit: safeLimit,
    offset: safeOffset,
  };
}

export async function getAiUsageBreakdownToday() {
  await ensureAiUsageSchema();
  const result = await pool.query(
    `SELECT feature, COALESCE(SUM(total_tokens), 0)::int AS tokens, COUNT(*)::int AS calls
     FROM v_b_ai_usage
     WHERE success = TRUE
       AND used_at >= date_trunc('day', NOW())
     GROUP BY feature
     ORDER BY tokens DESC`
  );
  return result.rows;
}
