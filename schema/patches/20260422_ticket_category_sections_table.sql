BEGIN;

CREATE TABLE IF NOT EXISTS v_b_ticket_category_sections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

INSERT INTO v_b_ticket_category_sections (id, name, description, enabled)
VALUES
  ('itil-sec-infogerance', 'Infogérance (gestion des infrastructures)', 'Gestion des infrastructures', TRUE),
  ('itil-sec-hebergement', 'Hébergement (infra & cloud)', 'Gestion hébergement et cloud', TRUE),
  ('itil-sec-assistance', 'Assistance (support utilisateurs)', 'Support utilisateurs', TRUE),
  ('itil-sec-non-classee', 'Non classée', 'Section par défaut', TRUE)
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

  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_category_sections TO veritas_user');
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_category_sections TO %I', app_user);
END $$;

COMMIT;
