BEGIN;

-- Cette table ne sert plus au runtime:
-- la configuration est désormais répartie dans des tables dédiées.
DROP TABLE IF EXISTS v_b_ticket_automation_config;

COMMIT;
