-- Tenants Mailinblack Protect dédiés par client Veritas
CREATE TABLE IF NOT EXISTS v_b_clients_mailinblack (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL,
  label TEXT,
  solution TEXT NOT NULL DEFAULT 'Mailinblack Protect',
  api_url TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_v_b_clients_mailinblack_client_id
  ON v_b_clients_mailinblack (client_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_clients_mailinblack TO veritas_user;
GRANT USAGE, SELECT ON SEQUENCE v_b_clients_mailinblack_id_seq TO veritas_user;
