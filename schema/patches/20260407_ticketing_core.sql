-- Ticketing natif Veritas (V1)
-- Crée la table principale v_b_tickets et les tables de support.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS v_b_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number BIGSERIAL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  priority VARCHAR(16) NOT NULL DEFAULT 'normal',
  type VARCHAR(32) NOT NULL DEFAULT 'incident',
  channel VARCHAR(32) NOT NULL DEFAULT 'web',
  client_id BIGINT NULL,
  requester_user_id UUID NULL,
  assigned_user_id UUID NULL,
  created_by UUID NULL,
  resolved_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT v_b_tickets_status_chk CHECK (status IN ('open', 'pending', 'in_progress', 'resolved', 'closed')),
  CONSTRAINT v_b_tickets_priority_chk CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
);

CREATE TABLE IF NOT EXISTS v_b_ticket_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  author_user_id UUID NULL,
  content TEXT NOT NULL,
  is_internal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_ticket_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  old_status VARCHAR(32) NULL,
  new_status VARCHAR(32) NOT NULL,
  changed_by UUID NULL,
  note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_ticket_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label VARCHAR(64) NOT NULL UNIQUE,
  color VARCHAR(16) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_ticket_tag_links (
  ticket_id UUID NOT NULL REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES v_b_ticket_tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticket_id, tag_id)
);

CREATE TABLE IF NOT EXISTS v_b_ticket_watchers (
  ticket_id UUID NOT NULL REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticket_id, user_id)
);

CREATE TABLE IF NOT EXISTS v_b_ticket_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES v_b_tickets(id) ON DELETE CASCADE,
  comment_id UUID NULL REFERENCES v_b_ticket_comments(id) ON DELETE SET NULL,
  uploaded_by UUID NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type VARCHAR(128) NULL,
  file_size BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v_b_tickets_status ON v_b_tickets(status);
CREATE INDEX IF NOT EXISTS idx_v_b_tickets_priority ON v_b_tickets(priority);
CREATE INDEX IF NOT EXISTS idx_v_b_tickets_client_id ON v_b_tickets(client_id);
CREATE INDEX IF NOT EXISTS idx_v_b_tickets_assigned_user_id ON v_b_tickets(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_v_b_tickets_requester_user_id ON v_b_tickets(requester_user_id);
CREATE INDEX IF NOT EXISTS idx_v_b_tickets_updated_at ON v_b_tickets(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_v_b_tickets_created_at ON v_b_tickets(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_comments_ticket_id ON v_b_ticket_comments(ticket_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_v_b_ticket_status_history_ticket_id ON v_b_ticket_status_history(ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_v_b_ticket_attachments_ticket_id ON v_b_ticket_attachments(ticket_id, created_at DESC);

