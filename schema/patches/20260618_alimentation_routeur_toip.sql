-- Périphériques MSP : alimentation (onduleur/PDU), routeur/SD-WAN, TOIP

CREATE TABLE IF NOT EXISTS v_b_clients_m_alimentation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id INTEGER NOT NULL,
  item_key TEXT,
  name TEXT,
  data JSONB,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checkmk_host_name VARCHAR(512),
  checkmk_site VARCHAR(255),
  checkmk_service_name VARCHAR(512)
);

CREATE INDEX IF NOT EXISTS idx_v_b_clients_m_alimentation_client_id
  ON v_b_clients_m_alimentation (client_id);

CREATE TABLE IF NOT EXISTS v_b_clients_m_routeur (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id INTEGER NOT NULL,
  item_key TEXT,
  name TEXT,
  data JSONB,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checkmk_host_name VARCHAR(512),
  checkmk_site VARCHAR(255),
  checkmk_service_name VARCHAR(512)
);

CREATE INDEX IF NOT EXISTS idx_v_b_clients_m_routeur_client_id
  ON v_b_clients_m_routeur (client_id);

CREATE TABLE IF NOT EXISTS v_b_clients_m_toip (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id INTEGER NOT NULL,
  item_key TEXT,
  name TEXT,
  data JSONB,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checkmk_host_name VARCHAR(512),
  checkmk_site VARCHAR(255),
  checkmk_service_name VARCHAR(512)
);

CREATE INDEX IF NOT EXISTS idx_v_b_clients_m_toip_client_id
  ON v_b_clients_m_toip (client_id);
