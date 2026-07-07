-- Héritage de profils + vues tickets assignées par profil

ALTER TABLE v_b_ticket_views
  DROP CONSTRAINT IF EXISTS v_b_ticket_views_visibility_check;

ALTER TABLE v_b_ticket_views
  ADD CONSTRAINT v_b_ticket_views_visibility_check
  CHECK (visibility IN ('private', 'public', 'profile'));

ALTER TABLE v_b_users_profiles
  ADD COLUMN IF NOT EXISTS parent_profile TEXT
  REFERENCES v_b_users_profiles(name)
  ON UPDATE CASCADE
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_v_b_users_profiles_parent
  ON v_b_users_profiles(parent_profile);

CREATE TABLE IF NOT EXISTS v_b_ticket_view_profiles (
  view_id UUID NOT NULL REFERENCES v_b_ticket_views(id) ON DELETE CASCADE,
  profile_name TEXT NOT NULL REFERENCES v_b_users_profiles(name) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (view_id, profile_name)
);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_view_profiles_profile
  ON v_b_ticket_view_profiles(profile_name);
