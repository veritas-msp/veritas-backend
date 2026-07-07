-- Carnets de tickets support avec dates de validité

CREATE TABLE IF NOT EXISTS v_b_client_support_credit_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id INTEGER NOT NULL REFERENCES v_b_clients(id) ON DELETE CASCADE,
  label TEXT NULL,
  initial_amount INTEGER NOT NULL CHECK (initial_amount > 0),
  remaining_amount INTEGER NOT NULL CHECK (remaining_amount >= 0),
  valid_from DATE NULL,
  valid_until DATE NULL,
  note TEXT NULL,
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ NULL,
  CONSTRAINT v_b_client_support_credit_packs_remaining_chk
    CHECK (remaining_amount <= initial_amount)
);

CREATE INDEX IF NOT EXISTS idx_support_credit_packs_client
  ON v_b_client_support_credit_packs(client_id, created_at DESC);

ALTER TABLE v_b_client_support_credit_ledger
  ADD COLUMN IF NOT EXISTS pack_id UUID NULL
    REFERENCES v_b_client_support_credit_packs(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v_b_client_support_credit_packs_created_by_fkey'
  ) THEN
    BEGIN
      ALTER TABLE v_b_client_support_credit_packs
        ADD CONSTRAINT v_b_client_support_credit_packs_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES v_b_users(id) ON DELETE SET NULL;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'FK created_by ignorée (droits insuffisants sur v_b_users)';
    END;
  END IF;
END $$;

-- Migrer les soldes existants vers un carnet sans date de fin
INSERT INTO v_b_client_support_credit_packs (
  client_id, label, initial_amount, remaining_amount, note, created_at
)
SELECT
  c.client_id,
  'Carnet initial',
  c.balance,
  c.balance,
  'Solde migré automatiquement',
  NOW()
FROM v_b_client_support_credits c
WHERE c.balance > 0
  AND NOT EXISTS (
    SELECT 1 FROM v_b_client_support_credit_packs p WHERE p.client_id = c.client_id
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_client_support_credit_packs TO veritas_user;
