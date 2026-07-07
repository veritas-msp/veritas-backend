-- Retours satisfaction client sur tickets support (portail client)
BEGIN;

CREATE TABLE IF NOT EXISTS v_b_ticket_satisfaction (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL UNIQUE REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL,
  message TEXT NULL,
  author_user_id UUID NULL REFERENCES v_b_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT v_b_ticket_satisfaction_rating_chk CHECK (rating >= 1 AND rating <= 5)
);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_satisfaction_ticket
  ON v_b_ticket_satisfaction (ticket_id);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_satisfaction_created
  ON v_b_ticket_satisfaction (created_at DESC);

COMMIT;
