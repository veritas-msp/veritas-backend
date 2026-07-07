-- Civilité contact : monsieur | madame (remplace homme | femme | autre)

UPDATE v_b_contacts
SET sexe = 'monsieur'
WHERE LOWER(TRIM(COALESCE(sexe, ''))) IN ('homme', 'h', 'm', 'masculin');

UPDATE v_b_contacts
SET sexe = 'madame'
WHERE LOWER(TRIM(COALESCE(sexe, ''))) IN ('femme', 'f', 'féminin', 'feminin');

UPDATE v_b_contacts
SET sexe = NULL
WHERE LOWER(TRIM(COALESCE(sexe, ''))) IN ('autre', 'x', 'non-binaire', 'non_binaire', 'non binaire');

COMMENT ON COLUMN v_b_contacts.sexe IS 'monsieur | madame';
