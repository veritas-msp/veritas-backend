-- Alertes surveillance désactivées par défaut ; activation explicite par périphérique

ALTER TABLE v_b_equipment_monitoring_alerts
  ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT false;
