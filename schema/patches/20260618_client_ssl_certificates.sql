-- Certificats SSL/TLS par client (monitoring expiration)
CREATE TABLE IF NOT EXISTS v_b_clients_m_ssl (
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

CREATE INDEX IF NOT EXISTS idx_clients_m_ssl_client_id ON v_b_clients_m_ssl (client_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_m_ssl_client_name
  ON v_b_clients_m_ssl (client_id, name)
  WHERE name IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_m_ssl_client_item_key
  ON v_b_clients_m_ssl (client_id, item_key)
  WHERE item_key IS NOT NULL;
