BEGIN;

CREATE TABLE IF NOT EXISTS v_b_equipment_family_definitions (
  id SERIAL PRIMARY KEY,
  family_key VARCHAR(80) NOT NULL,
  label VARCHAR(120) NOT NULL,
  icon VARCHAR(120) NOT NULL DEFAULT 'mdi:devices',
  display_mode VARCHAR(20) NOT NULL DEFAULT 'hexagon',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  honeycomb_q INTEGER,
  honeycomb_r INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT v_b_equipment_family_definitions_family_key_key UNIQUE (family_key),
  CONSTRAINT v_b_equipment_family_definitions_display_mode_check
    CHECK (display_mode IN ('hexagon', 'brick'))
);

CREATE TABLE IF NOT EXISTS v_b_equipment_family_fields (
  id SERIAL PRIMARY KEY,
  family_id INTEGER NOT NULL,
  field_key VARCHAR(80) NOT NULL,
  label VARCHAR(120) NOT NULL,
  field_type VARCHAR(20) NOT NULL DEFAULT 'text',
  required BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT v_b_equipment_family_fields_family_field_key UNIQUE (family_id, field_key),
  CONSTRAINT v_b_equipment_family_fields_field_type_check
    CHECK (field_type IN ('text', 'textarea', 'date', 'number', 'boolean'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v_b_equipment_family_fields_family_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE v_b_equipment_family_fields
        ADD CONSTRAINT v_b_equipment_family_fields_family_id_fkey
        FOREIGN KEY (family_id) REFERENCES v_b_equipment_family_definitions(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'FK family fields ignorée';
    END;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS v_b_clients_m_custom_equipment (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  client_id INTEGER NOT NULL,
  family_key VARCHAR(80) NOT NULL,
  item_key TEXT,
  name TEXT,
  data JSONB,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_custom_equipment_client_id
  ON v_b_clients_m_custom_equipment (client_id);

CREATE INDEX IF NOT EXISTS idx_custom_equipment_client_family
  ON v_b_clients_m_custom_equipment (client_id, family_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_equipment_client_name
  ON v_b_clients_m_custom_equipment (client_id, family_key, name)
  WHERE name IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_equipment_family_definitions TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_equipment_family_fields TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_clients_m_custom_equipment TO veritas_user;

GRANT USAGE, SELECT ON SEQUENCE v_b_equipment_family_definitions_id_seq TO veritas_user;
GRANT USAGE, SELECT ON SEQUENCE v_b_equipment_family_fields_id_seq TO veritas_user;

COMMIT;
