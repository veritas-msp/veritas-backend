-- Journal d'usage IA (quotas journaliers)

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
);

CREATE INDEX IF NOT EXISTS idx_v_b_ai_usage_used_at ON v_b_ai_usage (used_at DESC);
CREATE INDEX IF NOT EXISTS idx_v_b_ai_usage_feature_day ON v_b_ai_usage (feature, used_at);
