CREATE TABLE IF NOT EXISTS v_b_ticket_mail_collect_settings_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO v_b_ticket_mail_collect_settings_config (id, data)
VALUES (1, '{}'::jsonb)
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

  IF to_regclass('public.v_b_ticket_mail_collect_settings_config') IS NOT NULL THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_mail_collect_settings_config TO %I',
      app_user
    );
  END IF;
END $$;
