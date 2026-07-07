-- Règles globales d'alerte supervision (centre de supervision)

CREATE TABLE IF NOT EXISTS v_b_supervision_alert_rules_config (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT supervision_alert_rules_singleton CHECK (id = 1)
);

INSERT INTO v_b_supervision_alert_rules_config (id, data)
VALUES (1, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_supervision_alert_rules_config TO veritas_user;
