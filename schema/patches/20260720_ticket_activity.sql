-- Journal d'activité générique des tickets (hors statut, déjà dans v_b_ticket_status_history)
CREATE TABLE IF NOT EXISTS v_b_ticket_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  action VARCHAR(48) NOT NULL,
  field VARCHAR(64) NULL,
  old_value TEXT NULL,
  new_value TEXT NULL,
  meta JSONB NULL,
  actor_user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_activity_ticket_created
  ON v_b_ticket_activity (ticket_id, created_at DESC);

COMMENT ON TABLE v_b_ticket_activity IS 'Historique des actions ticket (champs, assignés, followers, tags, etc.)';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'veritas_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_activity TO veritas_user;
  END IF;
END $$;
