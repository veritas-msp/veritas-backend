import { pool } from "../database/db.js";
import { AI_LIMIT_KEY_TO_USAGE_FEATURES, resolveAiLimitKey } from "../utils/aiSettings.js";

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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_v_b_ai_usage_feature_day
      ON v_b_ai_usage (feature, used_at DESC)
      WHERE success = TRUE
  `);
  schemaReady = true;
}

export async function getAiCallsUsedToday(usageFeatures = []) {
  await ensureAiUsageSchema();
  const features = (Array.isArray(usageFeatures) ? usageFeatures : [usageFeatures]).map(f => String(f || "").trim()).filter(Boolean);
  if (!features.length) return 0;
  const result = await pool.query(`SELECT COUNT(*)::int AS used
     FROM v_b_ai_usage
     WHERE success = TRUE
       AND used_at >= date_trunc('day', NOW())
       AND feature = ANY($1::text[])`, [features]);
  return Number(result.rows[0]?.used || 0);
}

export async function getAiCallsUsedTodayTotal() {
  await ensureAiUsageSchema();
  const result = await pool.query(`SELECT COUNT(*)::int AS used
     FROM v_b_ai_usage
     WHERE success = TRUE
       AND used_at >= date_trunc('day', NOW())`);
  return Number(result.rows[0]?.used || 0);
}

/** @deprecated kept for compatibility — prefer getAiCallsUsedTodayTotal */
export async function getAiTokensUsedToday() {
  return getAiCallsUsedTodayTotal();
}

export async function assertAiQuotaAvailable(configOrLimit, usageFeatureOrEstimated) {
  // New signature: assertAiQuotaAvailable(config, usageFeature)
  // Legacy signature: assertAiQuotaAvailable(maxTokensPerDay, estimated) — treat as global call limit if number
  if (typeof configOrLimit === "number") {
    const used = await getAiCallsUsedTodayTotal();
    const limit = Math.max(1, Number(configOrLimit) || 1);
    if (used >= limit) {
      const err = new Error("Daily AI usage limit reached");
      err.code = "AI_QUOTA_EXCEEDED";
      err.used = used;
      err.limit = limit;
      throw err;
    }
    return {
      used,
      limit
    };
  }

  const config = configOrLimit || {};
  const usageFeature = String(usageFeatureOrEstimated || "").trim();
  const limitKey = resolveAiLimitKey(usageFeature);
  const limit = Number(config.featureLimits?.[limitKey]);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
  const bucket = AI_LIMIT_KEY_TO_USAGE_FEATURES[limitKey] || [usageFeature];
  const used = await getAiCallsUsedToday(bucket);
  if (used >= safeLimit) {
    const err = new Error("Daily limit reached for this AI action");
    err.code = "AI_QUOTA_EXCEEDED";
    err.used = used;
    err.limit = safeLimit;
    err.feature = limitKey || usageFeature;
    throw err;
  }
  return {
    used,
    limit: safeLimit,
    feature: limitKey || usageFeature
  };
}

export async function recordAiUsage({
  userId = null,
  feature,
  provider,
  model,
  promptTokens = 0,
  completionTokens = 0,
  success = true,
  errorMessage = null
}) {
  await ensureAiUsageSchema();
  const total = Math.max(0, Number(promptTokens) || 0) + Math.max(0, Number(completionTokens) || 0);
  await pool.query(`INSERT INTO v_b_ai_usage
      (user_id, feature, provider, model, prompt_tokens, completion_tokens, total_tokens, success, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [userId || null, String(feature || "unknown").slice(0, 64), String(provider || "unknown").slice(0, 32), model ? String(model).slice(0, 128) : null, Math.max(0, Number(promptTokens) || 0), Math.max(0, Number(completionTokens) || 0), total, Boolean(success), errorMessage ? String(errorMessage).slice(0, 1000) : null]);
  return total;
}

export async function listAiUsage({
  limit = 50,
  offset = 0
} = {}) {
  await ensureAiUsageSchema();
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const result = await pool.query(`SELECT u.id, u.used_at, u.user_id, u.feature, u.provider, u.model,
            u.prompt_tokens, u.completion_tokens, u.total_tokens, u.success, u.error_message,
            COALESCE(NULLIF(TRIM(usr.username), ''), usr.email) AS user_name
     FROM v_b_ai_usage u
     LEFT JOIN v_b_users usr ON usr.id = u.user_id
     ORDER BY u.used_at DESC
     LIMIT $1 OFFSET $2`, [safeLimit, safeOffset]);
  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM v_b_ai_usage`);
  return {
    rows: result.rows,
    total: countResult.rows[0]?.total || 0,
    limit: safeLimit,
    offset: safeOffset
  };
}

export async function getAiUsageBreakdownToday() {
  await ensureAiUsageSchema();
  const result = await pool.query(`SELECT feature, COUNT(*)::int AS calls,
            COALESCE(SUM(total_tokens), 0)::int AS tokens
     FROM v_b_ai_usage
     WHERE success = TRUE
       AND used_at >= date_trunc('day', NOW())
     GROUP BY feature
     ORDER BY calls DESC`);
  return result.rows;
}

export async function getAiFeatureUsageToday(featureLimits = {}) {
  const out = {};
  for (const [limitKey, usageFeatures] of Object.entries(AI_LIMIT_KEY_TO_USAGE_FEATURES)) {
    const used = await getAiCallsUsedToday(usageFeatures);
    out[limitKey] = {
      used,
      limit: Number(featureLimits?.[limitKey]) || 0
    };
  }
  return out;
}
