-- SLA snapshot par ticket (délais calculés à la création depuis le contrat client)
ALTER TABLE v_b_tickets
  ADD COLUMN IF NOT EXISTS sla_info JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN v_b_tickets.sla_info IS
  'Snapshot SLA: échéances première réponse / résolution, horodatages et politique appliquée';
