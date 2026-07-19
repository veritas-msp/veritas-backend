-- Automatisation surveillance MSP : config, runbooks, événements, corrélation

CREATE TABLE IF NOT EXISTS v_b_monitoring_automation_config (
  id INT PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_monitoring_runbooks_config (
  id INT PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_monitoring_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(80) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  client_id BIGINT,
  equipment_id UUID,
  equipment_family VARCHAR(80),
  criterion_key VARCHAR(80),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  ticket_id UUID,
  incident_group_id UUID,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitoring_events_status_created
  ON v_b_monitoring_events (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_monitoring_events_client
  ON v_b_monitoring_events (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS v_b_monitoring_incident_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id BIGINT,
  title VARCHAR(255),
  criterion_key VARCHAR(80),
  parent_ticket_id UUID,
  equipment_count INT NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE v_b_equipment_monitoring_alerts
  ADD COLUMN IF NOT EXISTS last_known_criteria JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE v_b_tickets
  ADD COLUMN IF NOT EXISTS monitoring_meta JSONB;

CREATE INDEX IF NOT EXISTS idx_tickets_monitoring_channel
  ON v_b_tickets (channel, category, status)
  WHERE channel = 'monitoring';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_monitoring_automation_config TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_monitoring_runbooks_config TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_monitoring_events TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_monitoring_incident_groups TO veritas_user;
