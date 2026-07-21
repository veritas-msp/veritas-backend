-- Lien campagne MFA → tenant Microsoft (Entra)
ALTER TABLE v_b_clients_c_campaign
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50);

ALTER TABLE v_b_clients_c_campaign
  ADD COLUMN IF NOT EXISTS tenant_id TEXT;

ALTER TABLE v_b_clients_c_campaign
  ADD COLUMN IF NOT EXISTS azure_credential_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'v_b_clients_c_campaign_azure_credential_id_fkey'
  ) THEN
    ALTER TABLE v_b_clients_c_campaign
      ADD CONSTRAINT v_b_clients_c_campaign_azure_credential_id_fkey
      FOREIGN KEY (azure_credential_id)
      REFERENCES v_b_clients_azure(id)
      ON DELETE SET NULL;
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_v_b_clients_c_campaign_azure_credential_id
  ON v_b_clients_c_campaign (azure_credential_id);

CREATE INDEX IF NOT EXISTS idx_v_b_clients_c_campaign_provider
  ON v_b_clients_c_campaign (provider);
