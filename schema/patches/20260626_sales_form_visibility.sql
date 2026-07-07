BEGIN;

ALTER TABLE v_b_sales_form_definitions
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'public';

ALTER TABLE v_b_sales_form_definitions
  DROP CONSTRAINT IF EXISTS v_b_sales_form_definitions_visibility_check;

ALTER TABLE v_b_sales_form_definitions
  ADD CONSTRAINT v_b_sales_form_definitions_visibility_check
  CHECK (visibility IN ('public', 'assigned'));

CREATE TABLE IF NOT EXISTS v_b_sales_form_profiles (
  form_id TEXT NOT NULL,
  profile_name VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (form_id, profile_name)
);

CREATE TABLE IF NOT EXISTS v_b_sales_form_users (
  form_id TEXT NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (form_id, user_id)
);

CREATE TABLE IF NOT EXISTS v_b_sales_form_teams (
  form_id TEXT NOT NULL,
  team_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (form_id, team_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v_b_sales_form_profiles_form_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE v_b_sales_form_profiles
        ADD CONSTRAINT v_b_sales_form_profiles_form_id_fkey
        FOREIGN KEY (form_id) REFERENCES v_b_sales_form_definitions(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'FK profiles ignorée';
    END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v_b_sales_form_users_form_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE v_b_sales_form_users
        ADD CONSTRAINT v_b_sales_form_users_form_id_fkey
        FOREIGN KEY (form_id) REFERENCES v_b_sales_form_definitions(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'FK users form_id ignorée';
    END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v_b_sales_form_users_user_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE v_b_sales_form_users
        ADD CONSTRAINT v_b_sales_form_users_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES v_b_users(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'FK users user_id ignorée';
    END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v_b_sales_form_teams_form_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE v_b_sales_form_teams
        ADD CONSTRAINT v_b_sales_form_teams_form_id_fkey
        FOREIGN KEY (form_id) REFERENCES v_b_sales_form_definitions(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'FK teams form_id ignorée';
    END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v_b_sales_form_teams_team_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE v_b_sales_form_teams
        ADD CONSTRAINT v_b_sales_form_teams_team_id_fkey
        FOREIGN KEY (team_id) REFERENCES v_b_teams(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'FK teams team_id ignorée';
    END;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_v_b_sales_form_profiles_name
  ON v_b_sales_form_profiles(profile_name);

CREATE INDEX IF NOT EXISTS idx_v_b_sales_form_users_user
  ON v_b_sales_form_users(user_id);

CREATE INDEX IF NOT EXISTS idx_v_b_sales_form_teams_team
  ON v_b_sales_form_teams(team_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_sales_form_profiles TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_sales_form_users TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_sales_form_teams TO veritas_user;

COMMIT;
