-- Corbeille tickets : soft delete (deleted_at + is_deleted)
-- À exécuter avec le propriétaire de v_b_tickets (souvent postgres), pas veritas_user.
ALTER TABLE v_b_tickets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_v_b_tickets_deleted_at
  ON v_b_tickets (deleted_at)
  WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN v_b_tickets.deleted_at IS 'Date de mise en corbeille';
COMMENT ON COLUMN v_b_tickets.is_deleted IS 'Ticket en corbeille (soft delete)';
