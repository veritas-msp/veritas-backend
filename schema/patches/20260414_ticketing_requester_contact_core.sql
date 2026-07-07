-- Ticketing natif Veritas (V1.1)
-- Ajoute le support du demandeur contact sur les tickets.

ALTER TABLE v_b_tickets
  ADD COLUMN IF NOT EXISTS requester_contact_id BIGINT NULL;

CREATE INDEX IF NOT EXISTS idx_v_b_tickets_requester_contact_id
  ON v_b_tickets(requester_contact_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'v_b_contacts'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'v_b_tickets_requester_contact_id_fkey'
    ) THEN
      ALTER TABLE v_b_tickets
        ADD CONSTRAINT v_b_tickets_requester_contact_id_fkey
        FOREIGN KEY (requester_contact_id)
        REFERENCES v_b_contacts(id)
        ON DELETE SET NULL;
    END IF;
  END IF;
END
$$;

