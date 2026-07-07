-- Assignations vues tickets : utilisateurs + équipes (+ profils existants)

ALTER TABLE v_b_ticket_views
  DROP CONSTRAINT IF EXISTS v_b_ticket_views_visibility_check;

ALTER TABLE v_b_ticket_views
  ADD CONSTRAINT v_b_ticket_views_visibility_check
  CHECK (visibility IN ('private', 'public', 'profile', 'assigned'));

UPDATE v_b_ticket_views SET visibility = 'assigned' WHERE visibility = 'profile';

CREATE TABLE IF NOT EXISTS v_b_ticket_view_users (
  view_id UUID NOT NULL REFERENCES v_b_ticket_views(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES v_b_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (view_id, user_id)
);

CREATE TABLE IF NOT EXISTS v_b_ticket_view_teams (
  view_id UUID NOT NULL REFERENCES v_b_ticket_views(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES v_b_teams(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (view_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_view_users_user
  ON v_b_ticket_view_users(user_id);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_view_teams_team
  ON v_b_ticket_view_teams(team_id);
