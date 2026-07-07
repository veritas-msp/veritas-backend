-- Droits ticketing pour le support requester_contact_id
-- Pas de nouvelle table: on réapplique le GRANT sur v_b_tickets.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_tickets TO veritas_user;

