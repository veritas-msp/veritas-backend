BEGIN;

ALTER TABLE v_b_sales_form_definitions
  ADD COLUMN IF NOT EXISTS ticket_targets JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
