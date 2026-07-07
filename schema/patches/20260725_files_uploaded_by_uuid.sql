-- Les utilisateurs Veritas sont identifiés par UUID (v_b_users.id).
-- Corrige l'upload de fichiers client / équipement.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'v_b_equipment_files'
      AND column_name = 'uploaded_by'
      AND data_type = 'bigint'
  ) THEN
    ALTER TABLE v_b_equipment_files
      ALTER COLUMN uploaded_by TYPE UUID
      USING NULL::UUID;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'v_b_client_files'
      AND column_name = 'uploaded_by'
      AND data_type = 'bigint'
  ) THEN
    ALTER TABLE v_b_client_files
      ALTER COLUMN uploaded_by TYPE UUID
      USING NULL::UUID;
  END IF;
END $$;
