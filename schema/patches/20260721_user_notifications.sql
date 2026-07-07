-- Notifications in-app pour les agents
BEGIN;

CREATE TABLE IF NOT EXISTS v_b_user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES v_b_users(id) ON DELETE CASCADE,
  type VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  ticket_id UUID NULL REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  comment_id UUID NULL REFERENCES v_b_ticket_comments(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v_b_user_notifications_user_created
  ON v_b_user_notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_v_b_user_notifications_user_unread
  ON v_b_user_notifications (user_id, read_at)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_v_b_user_notifications_ticket
  ON v_b_user_notifications (user_id, ticket_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_v_b_user_notifications_comment
  ON v_b_user_notifications (user_id, comment_id)
  WHERE comment_id IS NOT NULL;

COMMIT;
