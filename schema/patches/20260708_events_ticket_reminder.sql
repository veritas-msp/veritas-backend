-- Rappels demandeur ticket → événement planning (1 rappel actif par ticket)
ALTER TABLE v_b_events
  ADD COLUMN IF NOT EXISTS ticket_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v_b_events_ticket_id_fkey'
  ) THEN
    ALTER TABLE v_b_events
      ADD CONSTRAINT v_b_events_ticket_id_fkey
      FOREIGN KEY (ticket_id) REFERENCES v_b_tickets(id) ON DELETE CASCADE;
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'FK ticket_id ignorée (droits insuffisants sur v_b_tickets)';
END $$;

CREATE INDEX IF NOT EXISTS idx_v_b_events_ticket_id
  ON v_b_events(ticket_id)
  WHERE ticket_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_v_b_events_ticket_reminder
  ON v_b_events(ticket_id)
  WHERE ticket_id IS NOT NULL;
