-- Ordonner les profils du plus haut rang au plus bas en base
-- Administrateur -> Superviseur -> Agent -> Collaborateur -> Lecture

BEGIN;

ALTER TABLE v_b_users_profiles
ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 999;

UPDATE v_b_users_profiles
SET display_order = CASE LOWER(name)
  WHEN 'administrateur' THEN 10
  WHEN 'superviseur' THEN 20
  WHEN 'agent' THEN 30
  WHEN 'collaborateur' THEN 40
  WHEN 'lecture' THEN 50
  ELSE 999
END;

COMMIT;

