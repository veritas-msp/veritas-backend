-- Reconstruction complete de v_b_users_profiles
-- Objectif:
-- - drop / recreate propre de la table profils
-- - remettre les profils type Zendesk
-- - name = nom affichable
-- - label = description
-- - restaurer la FK v_b_users.profile -> v_b_users_profiles(name)

BEGIN;

-- 1) Sauvegarder les profils utilisateurs actuels
CREATE TEMP TABLE tmp_users_profile_backup AS
SELECT
  id,
  profile
FROM v_b_users;

-- 2) Supprimer la FK existante avant reconstruction
ALTER TABLE v_b_users DROP CONSTRAINT IF EXISTS users_profile_fkey;

-- 3) Drop / recreate complet de la table profils
DROP TABLE IF EXISTS v_b_users_profiles;

CREATE TABLE v_b_users_profiles (
  name VARCHAR(255) PRIMARY KEY,
  label TEXT NOT NULL,
  monitoring_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  infrastructure_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  cybersecurite_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  planning_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  service_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  contrat_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  contact_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  configurateur_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  tickets_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 999
);

-- 4) Recréer les profils cibles
INSERT INTO v_b_users_profiles (
  name,
  label,
  monitoring_enabled,
  infrastructure_enabled,
  cybersecurite_enabled,
  planning_enabled,
  service_enabled,
  contrat_enabled,
  contact_enabled,
  configurateur_enabled,
  tickets_enabled,
  display_order
)
VALUES
  (
    'Administrateur',
    'Acces complet a tous les modules et a toutes les actions d''administration.',
    TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, 10
  ),
  (
    'Superviseur',
    'Supervise les activites, pilote les equipes et accede aux fonctions de suivi avancees.',
    TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, TRUE, 20
  ),
  (
    'Agent',
    'Traite les demandes au quotidien, gere les operations et intervient sur les dossiers clients.',
    TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, TRUE, 30
  ),
  (
    'Collaborateur',
    'Acces operationnel restreint pour contribuer aux taches sans droits administratifs.',
    TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE, 40
  ),
  (
    'Lecture',
    'Consultation uniquement, sans modification des donnees ni actions sensibles.',
    TRUE, TRUE, TRUE, FALSE, TRUE, TRUE, TRUE, FALSE, FALSE, 50
  );

-- 5) Remapper tous les utilisateurs vers les nouveaux profils
UPDATE v_b_users u
SET profile = CASE
  WHEN LOWER(COALESCE(b.profile, '')) IN ('administrateur', 'administratif', 'direction') THEN 'Administrateur'
  WHEN LOWER(COALESCE(b.profile, '')) IN ('superviseur', 'responsable', 'manager') THEN 'Superviseur'
  WHEN LOWER(COALESCE(b.profile, '')) IN ('agent', 'tech_hd', 'utilisateur') THEN 'Agent'
  WHEN LOWER(COALESCE(b.profile, '')) = 'collaborateur' THEN 'Collaborateur'
  WHEN LOWER(COALESCE(b.profile, '')) IN ('lecture', 'lecture seule') THEN 'Lecture'
  ELSE 'Agent'
END
FROM tmp_users_profile_backup b
WHERE b.id = u.id;

-- 6) Recréer la contrainte de FK
ALTER TABLE v_b_users
ADD CONSTRAINT users_profile_fkey
FOREIGN KEY (profile)
REFERENCES v_b_users_profiles(name)
ON UPDATE CASCADE;

COMMIT;
