-- Équipes helpdesk (membres = agents avec profil, responsable par équipe)

CREATE TABLE IF NOT EXISTS v_b_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  description TEXT,
  color VARCHAR(32),
  icon VARCHAR(64) NOT NULL DEFAULT 'mdi:account-group-outline',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT v_b_teams_name_unique UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS v_b_team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES v_b_teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES v_b_users(id) ON DELETE CASCADE,
  is_leader BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT v_b_team_members_unique UNIQUE (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_v_b_teams_active_order
  ON v_b_teams(is_active, display_order, name);

CREATE INDEX IF NOT EXISTS idx_v_b_team_members_user
  ON v_b_team_members(user_id);

CREATE INDEX IF NOT EXISTS idx_v_b_team_members_team
  ON v_b_team_members(team_id);
