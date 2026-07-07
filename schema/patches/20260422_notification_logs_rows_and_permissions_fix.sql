BEGIN;

-- 1) Transformer v_b_notification_logs_config en table "1 ligne = 1 log".
-- Si la table existe encore au format singleton (id + data jsonb), on migre les logs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'v_b_notification_logs_config'
      AND column_name = 'data'
  ) THEN
    CREATE TABLE IF NOT EXISTS v_b_notification_logs_config_new (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT '',
      element TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
      enterprise_id TEXT NOT NULL DEFAULT ''
    );

    INSERT INTO v_b_notification_logs_config_new
      (id, source, status, channel, element, message, created_at, enterprise_id)
    SELECT
      COALESCE(item->>'id', 'notif-log-' || floor(extract(epoch from now()) * 1000)::text || '-' || substr(md5(random()::text), 1, 6)),
      COALESCE(item->>'source', ''),
      COALESCE(item->>'status', ''),
      COALESCE(item->>'channel', ''),
      COALESCE(item->>'element', ''),
      COALESCE(item->>'message', ''),
      COALESCE((item->>'createdAt')::timestamp, NOW()),
      COALESCE(item->>'enterpriseId', '')
    FROM (
      SELECT jsonb_array_elements(COALESCE(data, '[]'::jsonb)) AS item
      FROM v_b_notification_logs_config
      WHERE id = 1
      LIMIT 1
    ) s
    ON CONFLICT (id) DO NOTHING;

    DROP TABLE v_b_notification_logs_config;
    ALTER TABLE v_b_notification_logs_config_new RENAME TO v_b_notification_logs_config;
  END IF;
END $$;

-- 2) Sécuriser la table logs si elle n'existait pas encore
CREATE TABLE IF NOT EXISTS v_b_notification_logs_config (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  element TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  enterprise_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_v_b_notification_logs_created_at
  ON v_b_notification_logs_config (created_at DESC);

-- 3) Forcer explicitement les droits veritas_user + utilisateur applicatif.
DO $$
DECLARE
  app_user VARCHAR(255);
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'v_b_ticket_comment_templates_config',
    'v_b_ticket_macros_config',
    'v_b_ticket_email_inboxes_config',
    'v_b_ticket_exclusion_rules_config',
    'v_b_ticket_auto_reply_rules_config',
    'v_b_ticket_auto_reply_template_config',
    'v_b_ticket_scheduled_alert_rules_config',
    'v_b_ticket_chat_ui_settings_config',
    'v_b_ticket_mail_collectors_config',
    'v_b_notification_events_config',
    'v_b_notification_webhooks_config',
    'v_b_notification_templates_config',
    'v_b_notification_logs_config',
    'v_b_dashboard_reports_config'
  ];
BEGIN
  SELECT value INTO app_user
  FROM v_b_settings
  WHERE key = 'db_user'
  LIMIT 1;

  IF app_user IS NULL OR app_user = '' THEN
    app_user := 'veritas_user';
  END IF;

  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO veritas_user', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', tbl, app_user);
  END LOOP;
END $$;

COMMIT;
