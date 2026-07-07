CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS v_b_client_vault_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  secret_encrypted TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_auth_tag TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  max_views INT NOT NULL DEFAULT 5 CHECK (max_views >= 1 AND max_views <= 100),
  view_count INT NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  deletion_requested_at TIMESTAMPTZ,
  deletion_requested_by UUID,
  created_by UUID,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v_b_client_vault_secrets_client
  ON v_b_client_vault_secrets (client_id, status, expires_at DESC);

COMMENT ON TABLE v_b_client_vault_secrets IS
  'Accès / mots de passe partagés temporairement avec le portail client (type Password Pusher).';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_client_vault_secrets TO veritas_user;
