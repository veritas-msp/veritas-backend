BEGIN;

CREATE TABLE IF NOT EXISTS v_b_sales_form_definitions (
  id TEXT PRIMARY KEY,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('prestation', 'installation')),
  form_key VARCHAR(80) NOT NULL,
  label VARCHAR(200) NOT NULL,
  icon VARCHAR(64) NOT NULL DEFAULT 'mdi:file-document-outline',
  category_slug VARCHAR(120) NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  display_order INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (kind, form_key)
);

CREATE TABLE IF NOT EXISTS v_b_sales_form_fields (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES v_b_sales_form_definitions(id) ON DELETE CASCADE,
  field_key VARCHAR(80) NOT NULL,
  label VARCHAR(200) NOT NULL,
  field_type VARCHAR(30) NOT NULL DEFAULT 'text',
  required BOOLEAN NOT NULL DEFAULT FALSE,
  placeholder TEXT NOT NULL DEFAULT '',
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  display_order INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (form_id, field_key)
);

DO $$
BEGIN
  ALTER TABLE v_b_tickets ADD COLUMN IF NOT EXISTS sales_form_data JSONB;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Colonne sales_form_data ignorée (droits insuffisants sur v_b_tickets)';
END $$;

INSERT INTO v_b_sales_form_definitions (id, kind, form_key, label, icon, category_slug, display_order, enabled)
VALUES
  ('sales-form-prestation-audit', 'prestation', 'audit', 'Audit', 'mdi:clipboard-search-outline', 'prestation-audit', 10, TRUE),
  ('sales-form-prestation-enlevement', 'prestation', 'enlevement', 'Enlèvement', 'mdi:truck-remove-outline', 'prestation-enlevement', 20, TRUE),
  ('sales-form-prestation-expedition', 'prestation', 'expedition', 'Expédition', 'mdi:truck-delivery-outline', 'prestation-expedition', 30, TRUE),
  ('sales-form-prestation-formation', 'prestation', 'formation', 'Formation', 'mdi:school-outline', 'prestation-formation', 40, TRUE),
  ('sales-form-prestation-intervention-distante', 'prestation', 'intervention-distante', 'Intervention distante', 'mdi:remote-desktop', 'prestation-intervention-distante', 50, TRUE),
  ('sales-form-prestation-intervention-site', 'prestation', 'intervention-site', 'Intervention site', 'mdi:map-marker-radius', 'prestation-intervention-site', 60, TRUE),
  ('sales-form-prestation-production', 'prestation', 'production', 'Production', 'mdi:cog-play-outline', 'prestation-production', 70, TRUE),
  ('sales-form-prestation-etude-avant-vente', 'prestation', 'etude-avant-vente', 'Étude avant-vente', 'mdi:file-document-edit-outline', 'prestation-etude-avant-vente', 80, TRUE),
  ('sales-form-installation-site', 'installation', 'site', 'Installation sur site', 'mdi:hammer-wrench', 'installation-site', 10, TRUE),
  ('sales-form-installation-distante', 'installation', 'distante', 'Installation à distance', 'mdi:cloud-sync-outline', 'installation-distante', 20, TRUE),
  ('sales-form-installation-materiel', 'installation', 'materiel', 'Déploiement matériel', 'mdi:devices', 'installation-materiel', 30, TRUE),
  ('sales-form-installation-logiciel', 'installation', 'logiciel', 'Déploiement logiciel', 'mdi:application-outline', 'installation-logiciel', 40, TRUE),
  ('sales-form-installation-reseau', 'installation', 'reseau', 'Configuration réseau', 'mdi:lan', 'installation-reseau', 50, TRUE),
  ('sales-form-installation-mise-en-service', 'installation', 'mise-en-service', 'Mise en service', 'mdi:rocket-launch-outline', 'installation-mise-en-service', 60, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO v_b_sales_form_fields (id, form_id, field_key, label, field_type, placeholder, display_order, enabled)
SELECT v.id, v.form_id, v.field_key, v.label, v.field_type, v.placeholder, v.display_order, TRUE
FROM (
  VALUES
    ('sales-field-p-audit-services', 'sales-form-prestation-audit', 'services', 'Services vendus', 'textarea', 'Ex: M365 Business Premium, sauvegarde externalisée…', 10),
    ('sales-field-p-audit-materiel', 'sales-form-prestation-audit', 'materiel', 'Matériel vendu', 'textarea', 'Ex: 1x firewall Fortinet 60F…', 20),
    ('sales-field-p-enlevement-services', 'sales-form-prestation-enlevement', 'services', 'Services vendus', 'textarea', 'Ex: M365 Business Premium…', 10),
    ('sales-field-p-enlevement-materiel', 'sales-form-prestation-enlevement', 'materiel', 'Matériel vendu', 'textarea', 'Ex: 1x firewall…', 20),
    ('sales-field-p-expedition-services', 'sales-form-prestation-expedition', 'services', 'Services vendus', 'textarea', 'Ex: M365 Business Premium…', 10),
    ('sales-field-p-expedition-materiel', 'sales-form-prestation-expedition', 'materiel', 'Matériel vendu', 'textarea', 'Ex: 1x firewall…', 20),
    ('sales-field-p-formation-services', 'sales-form-prestation-formation', 'services', 'Services vendus', 'textarea', 'Ex: Formation utilisateurs…', 10),
    ('sales-field-p-formation-materiel', 'sales-form-prestation-formation', 'materiel', 'Matériel vendu', 'textarea', 'Ex: 1x firewall…', 20),
    ('sales-field-p-id-services', 'sales-form-prestation-intervention-distante', 'services', 'Services vendus', 'textarea', 'Ex: Intervention à distance…', 10),
    ('sales-field-p-id-materiel', 'sales-form-prestation-intervention-distante', 'materiel', 'Matériel vendu', 'textarea', 'Ex: 1x firewall…', 20),
    ('sales-field-p-is-services', 'sales-form-prestation-intervention-site', 'services', 'Services vendus', 'textarea', 'Ex: Intervention sur site…', 10),
    ('sales-field-p-is-materiel', 'sales-form-prestation-intervention-site', 'materiel', 'Matériel vendu', 'textarea', 'Ex: 1x firewall…', 20),
    ('sales-field-p-prod-services', 'sales-form-prestation-production', 'services', 'Services vendus', 'textarea', 'Ex: Production…', 10),
    ('sales-field-p-prod-materiel', 'sales-form-prestation-production', 'materiel', 'Matériel vendu', 'textarea', 'Ex: 1x firewall…', 20),
    ('sales-field-p-eav-services', 'sales-form-prestation-etude-avant-vente', 'services', 'Services vendus', 'textarea', 'Ex: Étude avant-vente…', 10),
    ('sales-field-p-eav-materiel', 'sales-form-prestation-etude-avant-vente', 'materiel', 'Matériel vendu', 'textarea', 'Ex: 1x firewall…', 20),
    ('sales-field-i-site-materiel', 'sales-form-installation-site', 'materiel', 'Matériel à installer', 'textarea', 'Ex: 1x firewall Fortinet 60F…', 10),
    ('sales-field-i-site-location', 'sales-form-installation-site', 'location', 'Lieu d''installation', 'textarea', 'Ex: Siège social, Paris…', 20),
    ('sales-field-i-distante-materiel', 'sales-form-installation-distante', 'materiel', 'Matériel à installer', 'textarea', 'Ex: 1x firewall…', 10),
    ('sales-field-i-distante-location', 'sales-form-installation-distante', 'location', 'Lieu d''installation', 'textarea', 'Ex: Site distant…', 20),
    ('sales-field-i-materiel-materiel', 'sales-form-installation-materiel', 'materiel', 'Matériel à installer', 'textarea', 'Ex: 1x firewall…', 10),
    ('sales-field-i-materiel-location', 'sales-form-installation-materiel', 'location', 'Lieu d''installation', 'textarea', 'Ex: Entrepôt client…', 20),
    ('sales-field-i-logiciel-materiel', 'sales-form-installation-logiciel', 'materiel', 'Matériel à installer', 'textarea', 'Ex: Serveur…', 10),
    ('sales-field-i-logiciel-location', 'sales-form-installation-logiciel', 'location', 'Lieu d''installation', 'textarea', 'Ex: Datacenter…', 20),
    ('sales-field-i-reseau-materiel', 'sales-form-installation-reseau', 'materiel', 'Matériel à installer', 'textarea', 'Ex: Switch, AP…', 10),
    ('sales-field-i-reseau-location', 'sales-form-installation-reseau', 'location', 'Lieu d''installation', 'textarea', 'Ex: Baie réseau…', 20),
    ('sales-field-i-mes-materiel', 'sales-form-installation-mise-en-service', 'materiel', 'Matériel à installer', 'textarea', 'Ex: Postes, serveurs…', 10),
    ('sales-field-i-mes-location', 'sales-form-installation-mise-en-service', 'location', 'Lieu d''installation', 'textarea', 'Ex: Siège…', 20)
) AS v(id, form_id, field_key, label, field_type, placeholder, display_order)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  app_user VARCHAR(255);
BEGIN
  SELECT value INTO app_user FROM v_b_settings WHERE key = 'db_user' LIMIT 1;
  IF app_user IS NULL OR app_user = '' THEN
    app_user := current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_user) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_sales_form_definitions TO %I', app_user);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_sales_form_fields TO %I', app_user);
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_sales_form_definitions TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_sales_form_fields TO veritas_user;

COMMIT;
