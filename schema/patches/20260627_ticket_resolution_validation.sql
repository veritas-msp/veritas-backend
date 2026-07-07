-- Validation client après résolution de ticket support
BEGIN;

CREATE TABLE IF NOT EXISTS v_b_ticket_resolution_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL UNIQUE REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  resolution_reason TEXT NOT NULL,
  resolution_comment_id UUID NULL REFERENCES v_b_ticket_comments(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  auto_close_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ NULL,
  outcome VARCHAR(32) NOT NULL DEFAULT 'pending',
  rejection_message TEXT NULL,
  responded_by_user_id UUID NULL REFERENCES v_b_users(id) ON DELETE SET NULL,
  resolved_by_user_id UUID NULL REFERENCES v_b_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT v_b_ticket_resolution_validations_outcome_chk
    CHECK (outcome IN ('pending', 'accepted', 'rejected', 'auto_closed'))
);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_resolution_validations_pending
  ON v_b_ticket_resolution_validations (outcome, auto_close_at)
  WHERE outcome = 'pending';

COMMIT;
