-- Suspension / reprise des alertes monitoring au niveau entreprise (client)

ALTER TABLE v_b_clients
  ADD COLUMN IF NOT EXISTS monitoring_alerts_suspension_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS monitoring_alerts_suspended_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS monitoring_alerts_suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS monitoring_alerts_suspended_by UUID,
  ADD COLUMN IF NOT EXISTS monitoring_alerts_suspension_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_v_b_clients_monitoring_alerts_suspension
  ON v_b_clients (monitoring_alerts_suspension_type, monitoring_alerts_suspended_until)
  WHERE monitoring_alerts_suspension_type IS NOT NULL;
