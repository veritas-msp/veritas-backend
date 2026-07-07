-- Aligner l'index unique ordinateurs avec ON CONFLICT (client_id, name)

DROP INDEX IF EXISTS idx_v_b_clients_m_ordinateurs_client_name;

CREATE UNIQUE INDEX idx_v_b_clients_m_ordinateurs_client_name
  ON v_b_clients_m_ordinateurs (client_id, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_v_b_clients_m_ordinateurs_client_item_key
  ON v_b_clients_m_ordinateurs (client_id, item_key)
  WHERE item_key IS NOT NULL;
