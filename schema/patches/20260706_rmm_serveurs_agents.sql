-- RMM : agents sur serveurs + liaison agent_id sur les serveurs

ALTER TABLE v_b_clients_m_servers
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES v_b_rmm_agents(id) ON DELETE SET NULL;

ALTER TABLE v_b_rmm_agents
  ADD COLUMN IF NOT EXISTS serveur_id UUID;

CREATE INDEX IF NOT EXISTS idx_v_b_clients_m_servers_agent_id
  ON v_b_clients_m_servers (agent_id)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_v_b_rmm_agents_serveur_id
  ON v_b_rmm_agents (serveur_id)
  WHERE serveur_id IS NOT NULL;
