-- Étiquettes et notes par client (catalogue partagé + liaisons + notes)

CREATE TABLE IF NOT EXISTS v_b_client_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label VARCHAR(64) NOT NULL UNIQUE,
  color VARCHAR(16) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_client_tag_links (
  client_id INTEGER NOT NULL REFERENCES v_b_clients(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES v_b_client_tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, tag_id)
);

CREATE TABLE IF NOT EXISTS v_b_client_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id INTEGER NOT NULL REFERENCES v_b_clients(id) ON DELETE CASCADE,
  user_id UUID NULL REFERENCES v_b_users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v_b_client_tag_links_client_id ON v_b_client_tag_links(client_id);
CREATE INDEX IF NOT EXISTS idx_v_b_client_notes_client_id ON v_b_client_notes(client_id, created_at DESC);
