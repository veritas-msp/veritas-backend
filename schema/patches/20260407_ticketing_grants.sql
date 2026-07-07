-- Droits ticketing pour l'utilisateur applicatif
-- A exécuter après la migration ticketing_core.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_tickets TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_comments TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_status_history TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_tags TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_tag_links TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_watchers TO veritas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_attachments TO veritas_user;

-- Séquence BIGSERIAL ticket_number
GRANT USAGE, SELECT ON SEQUENCE v_b_tickets_ticket_number_seq TO veritas_user;

