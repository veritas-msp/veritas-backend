-- La table est créée officiellement dans 20260416 ; bootstrap ici pour l'ordre chronologique des fichiers.
CREATE TABLE IF NOT EXISTS v_b_ticket_automation_config (
  id INTEGER PRIMARY KEY,
  comment_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
  macros JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO v_b_ticket_automation_config (id, comment_templates, macros)
SELECT 1, '[]'::jsonb, '[]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM v_b_ticket_automation_config WHERE id = 1
);

ALTER TABLE v_b_ticket_automation_config
  ADD COLUMN IF NOT EXISTS email_inboxes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS exclusion_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS auto_reply_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS auto_reply_template text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS scheduled_alert_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS chat_ui_settings jsonb NOT NULL DEFAULT '{"textSizePx":16,"messageSpacingPx":10}'::jsonb,
  ADD COLUMN IF NOT EXISTS mail_collectors jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE v_b_ticket_automation_config
SET email_inboxes = COALESCE(email_inboxes, '[]'::jsonb),
    exclusion_rules = COALESCE(exclusion_rules, '[]'::jsonb),
    auto_reply_rules = COALESCE(auto_reply_rules, '[]'::jsonb),
    auto_reply_template = COALESCE(auto_reply_template, ''),
    scheduled_alert_rules = COALESCE(scheduled_alert_rules, '[]'::jsonb),
    chat_ui_settings = COALESCE(chat_ui_settings, '{"textSizePx":16,"messageSpacingPx":10}'::jsonb),
    mail_collectors = COALESCE(mail_collectors, '[]'::jsonb)
WHERE id = 1;
