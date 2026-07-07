-- Visibilité portail client pour les documents du coffre-fort entreprise
ALTER TABLE v_b_client_files
  ADD COLUMN IF NOT EXISTS visible_to_client BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN v_b_client_files.visible_to_client IS
  'Si true, le document est visible et téléchargeable depuis le portail client (coffre-fort).';

CREATE INDEX IF NOT EXISTS idx_v_b_client_files_portal_visible
  ON v_b_client_files (client_id, visible_to_client)
  WHERE is_deleted = FALSE AND visible_to_client = TRUE;
