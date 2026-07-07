CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS v_b_equipment_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       BIGINT NOT NULL,
  equipment_id    UUID NOT NULL,
  equipment_type  TEXT,
  equipment_name  TEXT,
  file_name       TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  category        TEXT NOT NULL DEFAULT 'Autre',
  description     TEXT,
  uploaded_by UUID,
  is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v_b_equipment_files_equipment_id
  ON v_b_equipment_files (equipment_id);

CREATE INDEX IF NOT EXISTS idx_v_b_equipment_files_client_id
  ON v_b_equipment_files (client_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_equipment_files TO veritas_user;
