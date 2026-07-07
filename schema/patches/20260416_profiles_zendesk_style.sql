-- Profils utilisateurs "type Zendesk"
-- Objectif:
-- - Standardiser les profils par defaut
-- - Conserver la table existante v_b_users_profiles
-- - Reaffecter les utilisateurs vers les nouveaux profils

BEGIN;

-- 1) Créer les profils cibles s'ils n'existent pas
INSERT INTO v_b_users_profiles (
  name, label,
  monitoring_enabled, infrastructure_enabled, cybersecurite_enabled,
  service_enabled, contrat_enabled, configurateur_enabled, planning_enabled, contact_enabled
)
SELECT *
FROM (
  VALUES
    -- Pleins droits operationnels
    ('administrateur', 'Administrateur', true, true, true, true, true, true, true, true),
    -- Pilotage et supervision (sans configurateur)
    ('superviseur', 'Superviseur', true, true, true, true, true, false, true, true),
    -- Traitement quotidien des tickets/dossiers
    ('agent', 'Agent', true, true, true, true, true, false, true, true),
    -- Acces operationnel limite (lecture + suivi)
    ('collaborateur', 'Collaborateur', true, true, true, true, false, false, true, true),
    -- Consultation uniquement
    ('lecture', 'Lecture seule', true, true, true, true, false, false, false, true)
) AS src(
  name, label,
  monitoring_enabled, infrastructure_enabled, cybersecurite_enabled,
  service_enabled, contrat_enabled, configurateur_enabled, planning_enabled, contact_enabled
)
WHERE NOT EXISTS (
  SELECT 1
  FROM v_b_users_profiles p
  WHERE p.name = src.name
);

-- 2) Mettre à jour les droits des profils cibles (idempotent)
UPDATE v_b_users_profiles
SET
  label = 'Administrateur',
  monitoring_enabled = true,
  infrastructure_enabled = true,
  cybersecurite_enabled = true,
  service_enabled = true,
  contrat_enabled = true,
  configurateur_enabled = true,
  planning_enabled = true,
  contact_enabled = true
WHERE name = 'administrateur';

UPDATE v_b_users_profiles
SET
  label = 'Superviseur',
  monitoring_enabled = true,
  infrastructure_enabled = true,
  cybersecurite_enabled = true,
  service_enabled = true,
  contrat_enabled = true,
  configurateur_enabled = false,
  planning_enabled = true,
  contact_enabled = true
WHERE name = 'superviseur';

UPDATE v_b_users_profiles
SET
  label = 'Agent',
  monitoring_enabled = true,
  infrastructure_enabled = true,
  cybersecurite_enabled = true,
  service_enabled = true,
  contrat_enabled = true,
  configurateur_enabled = false,
  planning_enabled = true,
  contact_enabled = true
WHERE name = 'agent';

UPDATE v_b_users_profiles
SET
  label = 'Collaborateur',
  monitoring_enabled = true,
  infrastructure_enabled = true,
  cybersecurite_enabled = true,
  service_enabled = true,
  contrat_enabled = false,
  configurateur_enabled = false,
  planning_enabled = true,
  contact_enabled = true
WHERE name = 'collaborateur';

UPDATE v_b_users_profiles
SET
  label = 'Lecture seule',
  monitoring_enabled = true,
  infrastructure_enabled = true,
  cybersecurite_enabled = true,
  service_enabled = true,
  contrat_enabled = false,
  configurateur_enabled = false,
  planning_enabled = false,
  contact_enabled = true
WHERE name = 'lecture';

-- 3) Mapper les anciens profils vers les nouveaux
UPDATE v_b_users SET profile = 'administrateur' WHERE profile IN ('administratif', 'direction');
UPDATE v_b_users SET profile = 'superviseur' WHERE profile IN ('responsable', 'manager');
UPDATE v_b_users SET profile = 'agent' WHERE profile IN ('tech_hd', 'utilisateur');

-- 4) Fallback: tout profil inconnu => agent
UPDATE v_b_users u
SET profile = 'agent'
WHERE NOT EXISTS (
  SELECT 1
  FROM v_b_users_profiles p
  WHERE p.name = u.profile
);

-- 5) Supprimer les anciens profils non souhaités (uniquement s'ils ne sont plus utilisés)
DELETE FROM v_b_users_profiles p
WHERE p.name IN (
  'administratif',
  'direction',
  'responsable',
  'manager',
  'tech_hd',
  'utilisateur'
)
AND NOT EXISTS (
  SELECT 1
  FROM v_b_users u
  WHERE u.profile = p.name
);

COMMIT;

