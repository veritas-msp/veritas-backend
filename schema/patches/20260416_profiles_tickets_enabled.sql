-- Ajout du droit Tickets par profil + verrouillage Entreprise/Contact.
-- Entreprise (contrat) et Contact doivent rester actifs par défaut et non désactivables.

BEGIN;

ALTER TABLE v_b_users_profiles
  ADD COLUMN IF NOT EXISTS tickets_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Conserver le comportement historique: tickets suit planning à l'initialisation.
UPDATE v_b_users_profiles
SET tickets_enabled = planning_enabled;

-- Entreprise + Contact toujours actifs.
UPDATE v_b_users_profiles
SET contrat_enabled = TRUE,
    contact_enabled = TRUE;

ALTER TABLE v_b_users_profiles
  ALTER COLUMN contrat_enabled SET DEFAULT TRUE;

ALTER TABLE v_b_users_profiles
  ALTER COLUMN contact_enabled SET DEFAULT TRUE;

ALTER TABLE v_b_users_profiles
  ALTER COLUMN contrat_enabled SET NOT NULL;

ALTER TABLE v_b_users_profiles
  ALTER COLUMN contact_enabled SET NOT NULL;

COMMIT;
