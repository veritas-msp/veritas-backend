-- Permettre la creation d'utilisateurs sans renseigner de role.
-- Le role reste disponible pour la logique d'admin existante,
-- mais n'est plus obligatoire a l'insertion.

BEGIN;

ALTER TABLE v_b_users
  ALTER COLUMN role DROP NOT NULL;

ALTER TABLE v_b_users
  ALTER COLUMN role DROP DEFAULT;

COMMIT;

