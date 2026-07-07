-- Accès au hub documentaire par profil

ALTER TABLE v_b_users_profiles
  ADD COLUMN IF NOT EXISTS documents_enabled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE v_b_users_profiles
SET documents_enabled = TRUE
WHERE name IN ('Administrateur', 'Superviseur', 'Agent', 'Collaborateur');
