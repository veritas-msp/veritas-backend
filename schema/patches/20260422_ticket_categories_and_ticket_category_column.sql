BEGIN;

ALTER TABLE v_b_tickets
ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS v_b_ticket_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

INSERT INTO v_b_ticket_categories (id, name, description, enabled)
VALUES
  ('itil-cat-incident', 'Incident', 'Interruption ou degradation d''un service IT', TRUE),
  ('itil-cat-demande', 'Demande', 'Demande standard de service', TRUE),
  ('itil-cat-probleme', 'Probleme', 'Cause racine ou probleme recurrent', TRUE),
  ('itil-cat-changement', 'Changement', 'Evolution ou modification planifiee', TRUE)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  app_user VARCHAR(255);
BEGIN
  SELECT value INTO app_user
  FROM v_b_settings
  WHERE key = 'db_user'
  LIMIT 1;

  IF app_user IS NULL OR app_user = '' THEN
    app_user := 'veritas_user';
  END IF;

  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_categories TO veritas_user');
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_categories TO %I', app_user);
END $$;

COMMIT;
