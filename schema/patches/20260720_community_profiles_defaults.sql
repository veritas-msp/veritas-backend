-- Profils par défaut alignés sur l'édition Community (modules Contrat, Contact, Ticket).
-- Les installations Pro peuvent réactiver les flags Pro via l'administration des profils.

BEGIN;

UPDATE v_b_users_profiles
SET
  monitoring_enabled = FALSE,
  infrastructure_enabled = FALSE,
  cybersecurite_enabled = FALSE,
  planning_enabled = FALSE,
  service_enabled = FALSE,
  configurateur_enabled = FALSE,
  contrat_enabled = TRUE,
  contact_enabled = TRUE,
  tickets_enabled = TRUE,
  dashboard_enabled = CASE name
    WHEN 'Administrateur' THEN TRUE
    WHEN 'Superviseur' THEN TRUE
    ELSE FALSE
  END
WHERE name IN ('Administrateur', 'Superviseur', 'Agent', 'Collaborateur', 'Lecture');

COMMIT;
