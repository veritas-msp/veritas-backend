-- Matrice de permissions fines par profil (RBAC configurable)
-- Une ligne = (profil, clé de permission, autorisé ou non).
-- La présence d'une ligne avec allowed = TRUE accorde le droit.

CREATE TABLE IF NOT EXISTS v_b_profile_permissions (
  profile_name   VARCHAR(255) NOT NULL
    REFERENCES v_b_users_profiles(name) ON DELETE CASCADE ON UPDATE CASCADE,
  permission_key VARCHAR(100) NOT NULL,
  allowed        BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (profile_name, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_v_b_profile_permissions_profile
  ON v_b_profile_permissions(profile_name);
