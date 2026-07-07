-- Ajout du droit Dashboard par profil.

BEGIN;

ALTER TABLE v_b_users_profiles
  ADD COLUMN IF NOT EXISTS dashboard_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
