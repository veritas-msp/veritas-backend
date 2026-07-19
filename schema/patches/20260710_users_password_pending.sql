-- Comptes portail client : mot de passe non défini tant que le contact n'a pas activé son accès.
ALTER TABLE v_b_users ADD COLUMN IF NOT EXISTS password_pending boolean NOT NULL DEFAULT false;
