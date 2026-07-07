-- Étiquettes par contact (catalogue partagé v_b_client_tags)
-- Note : FK vers v_b_contacts ajoutée seulement si le rôle DB a REFERENCES (voir 20260618_contact_tag_links_fix.sql)

CREATE TABLE IF NOT EXISTS v_b_contact_tag_links (
  contact_id INTEGER NOT NULL,
  tag_id UUID NOT NULL REFERENCES v_b_client_tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_v_b_contact_tag_links_contact_id ON v_b_contact_tag_links(contact_id);
