-- Droits ticketing pour le support multi-assignés
-- A exécuter après la migration ticketing_multi_assignees_core.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_assignees TO veritas_user;

