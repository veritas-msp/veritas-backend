-- Ticketing natif Veritas (V1.2)
-- Ajoute le support multi-assignés sur les tickets.

CREATE TABLE IF NOT EXISTS v_b_ticket_assignees (
  ticket_id UUID NOT NULL REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticket_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_assignees_ticket_id
  ON v_b_ticket_assignees(ticket_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_assignees_user_id
  ON v_b_ticket_assignees(user_id);

