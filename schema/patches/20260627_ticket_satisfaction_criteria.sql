-- Notation multi-critères sur les retours satisfaction client
BEGIN;

ALTER TABLE v_b_ticket_satisfaction
  ADD COLUMN IF NOT EXISTS ratings JSONB NULL;

UPDATE v_b_ticket_satisfaction
SET ratings = jsonb_build_object(
  'responsiveness', rating,
  'solution_quality', rating,
  'communication', rating,
  'professionalism', rating,
  'overall', rating
)
WHERE ratings IS NULL AND rating IS NOT NULL;

COMMIT;
