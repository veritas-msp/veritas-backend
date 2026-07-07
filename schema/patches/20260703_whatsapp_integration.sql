-- Intégration WhatsApp Business : corrélation numéro ↔ ticket et idempotence messages

CREATE TABLE IF NOT EXISTS v_b_whatsapp_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_phone TEXT NOT NULL,
  ticket_id UUID NOT NULL REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  wa_contact_name TEXT NULL,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_whatsapp_conversations_ticket UNIQUE (ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_phone
  ON v_b_whatsapp_conversations (wa_phone);

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_last_message
  ON v_b_whatsapp_conversations (last_message_at DESC);

CREATE TABLE IF NOT EXISTS v_b_whatsapp_processed_messages (
  wa_message_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_whatsapp_conversations TO veritas_user;
GRANT SELECT, INSERT, DELETE ON TABLE v_b_whatsapp_processed_messages TO veritas_user;
