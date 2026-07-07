-- Carnets de tickets support prépayés par entreprise
-- ticket_id / created_by sans FK immédiate : veritas_user n'a pas REFERENCES sur v_b_tickets / v_b_users

CREATE TABLE IF NOT EXISTS v_b_client_support_credits (
  client_id INTEGER PRIMARY KEY REFERENCES v_b_clients(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_client_support_credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id INTEGER NOT NULL REFERENCES v_b_clients(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  kind VARCHAR(32) NOT NULL DEFAULT 'credit',
  ticket_id UUID NULL,
  note TEXT NULL,
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT v_b_client_support_credit_ledger_kind_chk
    CHECK (kind IN ('credit', 'debit', 'refund', 'adjustment'))
);

CREATE INDEX IF NOT EXISTS idx_support_credit_ledger_client
  ON v_b_client_support_credit_ledger(client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_credit_ledger_ticket
  ON v_b_client_support_credit_ledger(ticket_id)
  WHERE ticket_id IS NOT NULL;

-- Optionnel (superuser) : contraintes FK si les droits le permettent
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v_b_client_support_credit_ledger_ticket_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE v_b_client_support_credit_ledger
        ADD CONSTRAINT v_b_client_support_credit_ledger_ticket_id_fkey
        FOREIGN KEY (ticket_id) REFERENCES v_b_tickets(id) ON DELETE SET NULL;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'FK ticket_id ignorée (droits insuffisants sur v_b_tickets)';
    END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v_b_client_support_credit_ledger_created_by_fkey'
  ) THEN
    BEGIN
      ALTER TABLE v_b_client_support_credit_ledger
        ADD CONSTRAINT v_b_client_support_credit_ledger_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES v_b_users(id) ON DELETE SET NULL;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'FK created_by ignorée (droits insuffisants sur v_b_users)';
    END;
  END IF;
END $$;
