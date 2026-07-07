-- Corrélation Message-ID ↔ ticket pour le filage des réponses email (collecte mail)

CREATE TABLE IF NOT EXISTS v_b_ticket_email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  collector_id TEXT NULL,
  message_id TEXT NOT NULL,
  in_reply_to TEXT NULL,
  references_header TEXT NULL,
  subject TEXT NULL,
  from_address TEXT NULL,
  direction VARCHAR(16) NOT NULL DEFAULT 'inbound',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ticket_email_messages_message_id UNIQUE (message_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_email_messages_ticket_id
  ON v_b_ticket_email_messages (ticket_id);

CREATE INDEX IF NOT EXISTS idx_ticket_email_messages_created_at
  ON v_b_ticket_email_messages (created_at DESC);

GRANT SELECT, INSERT, DELETE ON TABLE v_b_ticket_email_messages TO veritas_user;
