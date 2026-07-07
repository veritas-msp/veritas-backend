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
    IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', tbl, app_user);
    END IF;
  END LOOP;
END $$;
