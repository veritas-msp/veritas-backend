-- Gestion des alertes surveillance par périphérique (suspension + suivi tickets auto)

CREATE TABLE IF NOT EXISTS v_b_equipment_monitoring_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id BIGINT NOT NULL,
  equipment_id UUID NOT NULL,
  equipment_family VARCHAR(80) NOT NULL,
  equipment_name VARCHAR(255),
  alerts_enabled BOOLEAN NOT NULL DEFAULT false,
  suspension_type VARCHAR(20),
  suspended_until TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  suspended_by UUID,
  suspension_reason TEXT,
  last_known_status VARCHAR(24) NOT NULL DEFAULT 'ok',
  last_ticket_id UUID,
  last_alert_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_equipment_monitoring_alerts_item UNIQUE (client_id, equipment_id, equipment_family)
);

CREATE INDEX IF NOT EXISTS idx_equipment_monitoring_alerts_client
  ON v_b_equipment_monitoring_alerts (client_id);

CREATE INDEX IF NOT EXISTS idx_equipment_monitoring_alerts_suspension
  ON v_b_equipment_monitoring_alerts (suspension_type, suspended_until);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_equipment_monitoring_alerts TO veritas_user;
