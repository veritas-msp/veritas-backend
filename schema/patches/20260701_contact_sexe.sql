-- Sexe / civilité du contact (homme, femme, autre)
ALTER TABLE v_b_contacts
  ADD COLUMN IF NOT EXISTS sexe VARCHAR(16);

COMMENT ON COLUMN v_b_contacts.sexe IS 'homme | femme | autre';
