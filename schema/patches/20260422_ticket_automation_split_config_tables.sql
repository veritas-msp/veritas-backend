BEGIN;

CREATE TABLE IF NOT EXISTS v_b_ticket_comment_templates_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_ticket_macros_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_ticket_email_inboxes_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_ticket_exclusion_rules_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_ticket_auto_reply_rules_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_ticket_auto_reply_template_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '""'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_ticket_scheduled_alert_rules_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_ticket_chat_ui_settings_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_ticket_mail_collectors_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_notification_events_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_notification_webhooks_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_notification_templates_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_notification_logs_config (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

INSERT INTO v_b_ticket_comment_templates_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_macros_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_email_inboxes_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_exclusion_rules_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_auto_reply_rules_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_auto_reply_template_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_scheduled_alert_rules_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_chat_ui_settings_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_mail_collectors_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_notification_events_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_notification_webhooks_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_notification_templates_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_notification_logs_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'v_b_ticket_automation_config'
  ) THEN
    UPDATE v_b_ticket_comment_templates_config t
    SET data = COALESCE(s.comment_templates, '[]'::jsonb),
        updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_ticket_macros_config t
    SET data = COALESCE(s.macros, '[]'::jsonb),
        updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_ticket_email_inboxes_config t
    SET data = COALESCE(s.email_inboxes, '[]'::jsonb),
        updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_ticket_exclusion_rules_config t
    SET data = COALESCE(s.exclusion_rules, '[]'::jsonb),
        updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_ticket_auto_reply_rules_config t
    SET data = (
      CASE
        WHEN jsonb_typeof(s.auto_reply_rules) = 'object' THEN COALESCE(s.auto_reply_rules->'legacyRules', '[]'::jsonb)
        WHEN jsonb_typeof(s.auto_reply_rules) = 'array' THEN s.auto_reply_rules
        ELSE '[]'::jsonb
      END
    ),
    updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_ticket_auto_reply_template_config t
    SET data = to_jsonb(COALESCE(s.auto_reply_template, '')),
        updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_ticket_scheduled_alert_rules_config t
    SET data = COALESCE(s.scheduled_alert_rules, '[]'::jsonb),
        updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_ticket_chat_ui_settings_config t
    SET data = COALESCE(s.chat_ui_settings, '{}'::jsonb),
        updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_ticket_mail_collectors_config t
    SET data = COALESCE(s.mail_collectors, '[]'::jsonb),
        updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_notification_events_config t
    SET data = (
      CASE
        WHEN jsonb_typeof(s.auto_reply_rules) = 'object' THEN
          CASE
            WHEN jsonb_typeof(s.auto_reply_rules->'notificationSettings') = 'object'
              THEN (s.auto_reply_rules->'notificationSettings') - 'webhooks' - 'templates' - 'logs'
            ELSE s.auto_reply_rules - 'legacyRules' - 'webhooks' - 'templates' - 'logs'
          END
        ELSE '{}'::jsonb
      END
    ),
    updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_notification_webhooks_config t
    SET data = (
      CASE
        WHEN jsonb_typeof(s.auto_reply_rules) = 'object' THEN
          CASE
            WHEN jsonb_typeof(s.auto_reply_rules->'notificationSettings') = 'object'
              THEN COALESCE(s.auto_reply_rules->'notificationSettings'->'webhooks', '[]'::jsonb)
            ELSE COALESCE(s.auto_reply_rules->'webhooks', '[]'::jsonb)
          END
        ELSE '[]'::jsonb
      END
    ),
    updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_notification_templates_config t
    SET data = (
      CASE
        WHEN jsonb_typeof(s.auto_reply_rules) = 'object' THEN
          CASE
            WHEN jsonb_typeof(s.auto_reply_rules->'notificationSettings') = 'object'
              THEN COALESCE(s.auto_reply_rules->'notificationSettings'->'templates', '[]'::jsonb)
            ELSE COALESCE(s.auto_reply_rules->'templates', '[]'::jsonb)
          END
        ELSE '[]'::jsonb
      END
    ),
    updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;

    UPDATE v_b_notification_logs_config t
    SET data = (
      CASE
        WHEN jsonb_typeof(s.auto_reply_rules) = 'object' THEN
          CASE
            WHEN jsonb_typeof(s.auto_reply_rules->'notificationSettings') = 'object'
              THEN COALESCE(s.auto_reply_rules->'notificationSettings'->'logs', '[]'::jsonb)
            ELSE COALESCE(s.auto_reply_rules->'logs', '[]'::jsonb)
          END
        ELSE '[]'::jsonb
      END
    ),
    updated_at = NOW()
    FROM v_b_ticket_automation_config s
    WHERE t.id = 1 AND s.id = 1;
  END IF;
END $$;

COMMIT;
