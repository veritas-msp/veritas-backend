BEGIN;

ALTER TABLE v_b_sales_form_fields
  ADD COLUMN IF NOT EXISTS visibility_rules JSONB NOT NULL DEFAULT '{"matchMode":"all","conditions":[]}'::jsonb;

COMMIT;
