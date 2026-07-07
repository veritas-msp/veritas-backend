-- Surcharges RMM par entreprise (sinon configuration globale)

CREATE TABLE IF NOT EXISTS v_b_rmm_client_settings (
  client_id BIGINT PRIMARY KEY REFERENCES v_b_clients(id) ON DELETE CASCADE,
  overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);

CREATE INDEX IF NOT EXISTS idx_v_b_rmm_client_settings_updated
  ON v_b_rmm_client_settings (updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_rmm_client_settings TO veritas_user;
