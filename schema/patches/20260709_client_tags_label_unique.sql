-- Index unique sur v_b_client_tags.label pour les upserts et l'intégrité du catalogue.
-- Fusionne les doublons éventuels avant de créer l'index.

WITH ranked AS (
  SELECT
    id,
    label,
    ROW_NUMBER() OVER (
      PARTITION BY lower(trim(label))
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM v_b_client_tags
),
dup_to_keeper AS (
  SELECT dup.id AS dup_id, keeper.id AS keeper_id
  FROM ranked dup
  JOIN ranked keeper
    ON lower(trim(keeper.label)) = lower(trim(dup.label))
   AND keeper.rn = 1
  WHERE dup.rn > 1
)
UPDATE v_b_client_tag_links links
SET tag_id = d.keeper_id
FROM dup_to_keeper d
WHERE links.tag_id = d.dup_id;

DO $$
BEGIN
  IF to_regclass('public.v_b_contact_tag_links') IS NOT NULL THEN
    WITH ranked AS (
      SELECT
        id,
        label,
        ROW_NUMBER() OVER (
          PARTITION BY lower(trim(label))
          ORDER BY created_at ASC, id ASC
        ) AS rn
      FROM v_b_client_tags
    ),
    dup_to_keeper AS (
      SELECT dup.id AS dup_id, keeper.id AS keeper_id
      FROM ranked dup
      JOIN ranked keeper
        ON lower(trim(keeper.label)) = lower(trim(dup.label))
       AND keeper.rn = 1
      WHERE dup.rn > 1
    )
    UPDATE v_b_contact_tag_links links
    SET tag_id = d.keeper_id
    FROM dup_to_keeper d
    WHERE links.tag_id = d.dup_id;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.v_b_equipment_tag_links') IS NOT NULL THEN
    WITH ranked AS (
      SELECT
        id,
        label,
        ROW_NUMBER() OVER (
          PARTITION BY lower(trim(label))
          ORDER BY created_at ASC, id ASC
        ) AS rn
      FROM v_b_client_tags
    ),
    dup_to_keeper AS (
      SELECT dup.id AS dup_id, keeper.id AS keeper_id
      FROM ranked dup
      JOIN ranked keeper
        ON lower(trim(keeper.label)) = lower(trim(dup.label))
       AND keeper.rn = 1
      WHERE dup.rn > 1
    )
    UPDATE v_b_equipment_tag_links links
    SET tag_id = d.keeper_id
    FROM dup_to_keeper d
    WHERE links.tag_id = d.dup_id;
  END IF;
END $$;

DELETE FROM v_b_client_tags tag
WHERE tag.id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY lower(trim(label))
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM v_b_client_tags
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS v_b_client_tags_label_uniq
  ON v_b_client_tags (label);
