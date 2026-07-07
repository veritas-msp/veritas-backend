-- Catalogues de catégorisation des résolutions ticket (intervention + action)
BEGIN;

CREATE TABLE IF NOT EXISTS v_b_ticket_solution_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(32) NOT NULL CHECK (category IN ('intervention', 'action')),
  label VARCHAR(120) NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_v_b_ticket_solution_catalog_cat_label
  ON v_b_ticket_solution_catalog (category, lower(trim(label)));

ALTER TABLE v_b_ticket_resolution_validations
  ADD COLUMN IF NOT EXISTS intervention_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS action_type TEXT NULL;

COMMIT;
