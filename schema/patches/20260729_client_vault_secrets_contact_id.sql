ALTER TABLE v_b_client_vault_secrets
  ADD COLUMN IF NOT EXISTS contact_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_v_b_client_vault_secrets_contact
  ON v_b_client_vault_secrets (contact_id, status, expires_at DESC);

COMMENT ON COLUMN v_b_client_vault_secrets.contact_id IS
  'Contact destinataire du partage (portail client).';
