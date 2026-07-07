-- Normaliser les profils:
-- - name = nom affichable (Majuscule)
-- - label = description du profil

BEGIN;

-- 0) Securiser la FK pour autoriser le renommage des profils
--    (sinon: 23503 "users_profile_fkey")
ALTER TABLE v_b_users DROP CONSTRAINT IF EXISTS users_profile_fkey;
ALTER TABLE v_b_users
ADD CONSTRAINT users_profile_fkey
FOREIGN KEY (profile)
REFERENCES v_b_users_profiles(name)
ON UPDATE CASCADE;

-- 1) Mettre a jour les noms de profils (name) en version affichable
UPDATE v_b_users_profiles SET name = 'Administrateur' WHERE LOWER(name) = 'administrateur';
UPDATE v_b_users_profiles SET name = 'Superviseur'    WHERE LOWER(name) = 'superviseur';
UPDATE v_b_users_profiles SET name = 'Agent'          WHERE LOWER(name) = 'agent';
UPDATE v_b_users_profiles SET name = 'Collaborateur'  WHERE LOWER(name) = 'collaborateur';
UPDATE v_b_users_profiles SET name = 'Lecture'        WHERE LOWER(name) = 'lecture';

-- 2) Garder les utilisateurs alignes avec les nouveaux noms
--    (normalement deja cascade via ON UPDATE CASCADE)
UPDATE v_b_users SET profile = 'Administrateur' WHERE LOWER(profile) = 'administrateur';
UPDATE v_b_users SET profile = 'Superviseur'    WHERE LOWER(profile) = 'superviseur';
UPDATE v_b_users SET profile = 'Agent'          WHERE LOWER(profile) = 'agent';
UPDATE v_b_users SET profile = 'Collaborateur'  WHERE LOWER(profile) = 'collaborateur';
UPDATE v_b_users SET profile = 'Lecture'        WHERE LOWER(profile) = 'lecture';

-- 3) Transformer label en description métier
UPDATE v_b_users_profiles
SET label = 'Acces complet a tous les modules et a toutes les actions d''administration.'
WHERE name = 'Administrateur';

UPDATE v_b_users_profiles
SET label = 'Supervise les activites, pilote les equipes et accede aux fonctions de suivi avancees.'
WHERE name = 'Superviseur';

UPDATE v_b_users_profiles
SET label = 'Traite les demandes au quotidien, gere les operations et intervient sur les dossiers clients.'
WHERE name = 'Agent';

UPDATE v_b_users_profiles
SET label = 'Acces operationnel restreint pour contribuer aux taches sans droits administratifs.'
WHERE name = 'Collaborateur';

UPDATE v_b_users_profiles
SET label = 'Consultation uniquement, sans modification des donnees ni actions sensibles.'
WHERE name = 'Lecture';

COMMIT;

