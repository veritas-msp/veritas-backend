-- Ticketing : incident majeur et créneaux de contact client

ALTER TABLE v_b_tickets
  ADD COLUMN IF NOT EXISTS is_major_incident BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE v_b_tickets
  ADD COLUMN IF NOT EXISTS contact_slots JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_v_b_tickets_is_major_incident
  ON v_b_tickets(is_major_incident)
  WHERE is_major_incident = TRUE;
