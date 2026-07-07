ALTER TABLE v_b_contacts
  ADD COLUMN IF NOT EXISTS communications JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN v_b_contacts.communications IS
  'Moyens de communication du contact (e-mail, téléphone, etc.) avec indicateur principal par type';
