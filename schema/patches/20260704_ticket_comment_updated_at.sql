-- Horodatage de modification des commentaires ticket
ALTER TABLE v_b_ticket_comments
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN v_b_ticket_comments.updated_at IS 'Date de dernière modification du commentaire';
