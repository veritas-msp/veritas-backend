-- Étiquettes par périphérique (catalogue partagé v_b_client_tags)

CREATE TABLE IF NOT EXISTS v_b_equipment_tag_links (
  equipment_id UUID NOT NULL,
  client_id BIGINT NOT NULL,
  tag_id UUID NOT NULL REFERENCES v_b_client_tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (equipment_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_v_b_equipment_tag_links_equipment_id
  ON v_b_equipment_tag_links(equipment_id);

CREATE INDEX IF NOT EXISTS idx_v_b_equipment_tag_links_client_id
  ON v_b_equipment_tag_links(client_id);
