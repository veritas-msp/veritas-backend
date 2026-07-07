-- Module RMM Veritas : agents endpoint, tokens d'enrôlement, famille Ordinateurs

CREATE TABLE IF NOT EXISTS v_b_rmm_enrollment_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id INTEGER NOT NULL REFERENCES v_b_clients(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  label TEXT,
  expires_at TIMESTAMPTZ,
  max_uses INTEGER,
  uses_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES v_b_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_v_b_rmm_enrollment_tokens_client_id
  ON v_b_rmm_enrollment_tokens (client_id);

CREATE TABLE IF NOT EXISTS v_b_rmm_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id INTEGER NOT NULL REFERENCES v_b_clients(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL UNIQUE,
  hostname TEXT,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  agent_version TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ,
  ordinateur_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_v_b_rmm_agents_client_id ON v_b_rmm_agents (client_id);
CREATE INDEX IF NOT EXISTS idx_v_b_rmm_agents_status ON v_b_rmm_agents (status);

CREATE TABLE IF NOT EXISTS v_b_clients_m_ordinateurs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id INTEGER NOT NULL,
  item_key TEXT,
  name TEXT,
  data JSONB,
  agent_id UUID REFERENCES v_b_rmm_agents(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_v_b_clients_m_ordinateurs_client_id
  ON v_b_clients_m_ordinateurs (client_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_v_b_clients_m_ordinateurs_client_name
  ON v_b_clients_m_ordinateurs (client_id, name)
  WHERE name IS NOT NULL;

ALTER TABLE v_b_rmm_agents
  DROP CONSTRAINT IF EXISTS v_b_rmm_agents_ordinateur_id_fkey;

ALTER TABLE v_b_rmm_agents
  ADD CONSTRAINT v_b_rmm_agents_ordinateur_id_fkey
  FOREIGN KEY (ordinateur_id) REFERENCES v_b_clients_m_ordinateurs(id) ON DELETE SET NULL;

-- Paramètres RMM par défaut
INSERT INTO v_b_settings (key, value, label, section)
VALUES
  ('RMM_HEARTBEAT_INTERVAL_MINUTES', '5', 'Intervalle heartbeat agent (minutes)', 'rmm'),
  ('RMM_OFFLINE_THRESHOLD_MINUTES', '15', 'Seuil hors ligne agent (minutes)', 'rmm'),
  ('RMM_COLLECT_OS', 'true', 'Collecter OS / build', 'rmm'),
  ('RMM_COLLECT_DOMAIN', 'true', 'Collecter domaine / workgroup', 'rmm'),
  ('RMM_COLLECT_UPDATES', 'true', 'Collecter mises à jour / KB', 'rmm'),
  ('RMM_COLLECT_LICENSE', 'true', 'Collecter licence Windows', 'rmm'),
  ('RMM_COLLECT_HARDWARE', 'true', 'Collecter CPU / RAM / disques', 'rmm'),
  ('RMM_COLLECT_NETWORK', 'true', 'Collecter IP / MAC', 'rmm'),
  ('RMM_COLLECT_SOFTWARE', 'false', 'Collecter logiciels installés', 'rmm')
ON CONFLICT (key) DO NOTHING;
