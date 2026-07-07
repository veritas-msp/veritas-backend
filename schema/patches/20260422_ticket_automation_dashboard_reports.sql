CREATE TABLE IF NOT EXISTS v_b_dashboard_reports_config (
  id INTEGER PRIMARY KEY,
  reports JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

INSERT INTO v_b_dashboard_reports_config (id, reports)
VALUES (1, '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE v_b_ticket_automation_config
DROP COLUMN IF EXISTS dashboard_reports;

