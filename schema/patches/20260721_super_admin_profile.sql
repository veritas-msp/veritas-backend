-- Ensure Super Admin system profile exists (immutable full-access profile).
-- Safe on DBs that may not yet have documents_enabled.
ALTER TABLE v_b_users_profiles
  ADD COLUMN IF NOT EXISTS documents_enabled BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO v_b_users_profiles (
  name, label,
  monitoring_enabled, infrastructure_enabled, cybersecurite_enabled,
  planning_enabled, service_enabled, contrat_enabled, contact_enabled,
  configurateur_enabled, tickets_enabled, dashboard_enabled, documents_enabled, display_order
) VALUES (
  'Super Admin',
  'Accès total non modifiable — propriétaire de l''instance.',
  true, true, true, true, true, true, true, true, true, true, true, 1
)
ON CONFLICT (name) DO NOTHING;
