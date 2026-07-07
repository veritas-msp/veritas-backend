-- Archivage des notifications in-app (masquage par l'utilisateur)
BEGIN;

ALTER TABLE v_b_user_notifications
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_v_b_user_notifications_user_active
  ON v_b_user_notifications (user_id, created_at DESC)
  WHERE archived_at IS NULL;

COMMIT;
