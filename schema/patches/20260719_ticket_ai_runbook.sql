-- Runbook IA par ticket (checklist + étapes cochées, partagé multi-agents)

ALTER TABLE v_b_tickets
  ADD COLUMN IF NOT EXISTS ai_runbook JSONB;

COMMENT ON COLUMN v_b_tickets.ai_runbook IS
  'Runbook IA support: { title, checklist[], checked{}, generatedAt, generatedBy }';
