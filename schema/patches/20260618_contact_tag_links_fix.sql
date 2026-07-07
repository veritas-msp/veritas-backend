-- Liaison contact ↔ étiquette (sans FK contact : veritas_user n'a pas REFERENCES sur v_b_contacts)
-- L'intégrité contact_id est assurée par l'API.

CREATE TABLE IF NOT EXISTS v_b_contact_tag_links (
  contact_id INTEGER NOT NULL,
  tag_id UUID NOT NULL REFERENCES v_b_client_tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_v_b_contact_tag_links_contact_id
  ON v_b_contact_tag_links(contact_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_contact_tag_links TO veritas_user;

-- Optionnel (superuser) : contrainte FK si les droits le permettent
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v_b_contact_tag_links_contact_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE v_b_contact_tag_links
        ADD CONSTRAINT v_b_contact_tag_links_contact_id_fkey
        FOREIGN KEY (contact_id) REFERENCES v_b_contacts(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'FK contact_id ignorée (droits insuffisants sur v_b_contacts)';
    END;
  END IF;
END $$;
