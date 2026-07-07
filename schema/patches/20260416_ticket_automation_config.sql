-- Configuration des templates et macros tickets en base.

BEGIN;

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
  SELECT 1
  FROM v_b_ticket_automation_config
  WHERE id = 1
);

COMMIT;
