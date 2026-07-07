-- Licences et abonnements génériques par client (nom + expiration)

CREATE TABLE IF NOT EXISTS v_b_clients_m_licences (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  client_id INTEGER NOT NULL,
  item_key TEXT,
  name TEXT,
  data JSONB,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_clients_m_licences_client_id ON v_b_clients_m_licences (client_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_m_licences_client_name
  ON v_b_clients_m_licences (client_id, name)
  WHERE name IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_m_licences_client_item_key
  ON v_b_clients_m_licences (client_id, item_key)
  WHERE item_key IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_clients_m_licences TO veritas_user;
