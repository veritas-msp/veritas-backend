-- Optimisation route GET /api/contacts/list
-- Tri/filtre principal de ContactPage

CREATE INDEX IF NOT EXISTS idx_v_b_contacts_nom_prenom
  ON v_b_contacts (nom, prenom);

CREATE INDEX IF NOT EXISTS idx_v_b_contacts_client_id
  ON v_b_contacts (client_id);

CREATE INDEX IF NOT EXISTS idx_v_b_contacts_statut
  ON v_b_contacts (statut);

CREATE INDEX IF NOT EXISTS idx_v_b_contacts_lower_nom
  ON v_b_contacts ((lower(nom)));

CREATE INDEX IF NOT EXISTS idx_v_b_contacts_lower_prenom
  ON v_b_contacts ((lower(prenom)));
