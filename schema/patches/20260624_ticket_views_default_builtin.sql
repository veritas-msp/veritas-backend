-- Remplace les vues intégrées tickets par les 4 vues par défaut (statuts)

DELETE FROM v_b_ticket_views
WHERE is_builtin = TRUE AND page_scope = 'ticket';

INSERT INTO v_b_ticket_views (name, description, page_scope, visibility, owner_user_id, icon, rules, display_order, is_builtin)
VALUES
  (
    'Nouveaux tickets',
    'Tickets au statut nouveau',
    'ticket',
    'public',
    NULL,
    'mdi:inbox-arrow-down',
    '{"matchMode":"all","viewMode":"active","criteria":[{"field":"status","operator":"equals","value":"new"}]}'::jsonb,
    0,
    TRUE
  ),
  (
    'Tickets en cours',
    'Tickets en cours de traitement',
    'ticket',
    'public',
    NULL,
    'mdi:progress-clock',
    '{"matchMode":"all","viewMode":"active","criteria":[{"field":"status","operator":"equals","value":"in_progress"}]}'::jsonb,
    10,
    TRUE
  ),
  (
    'Tickets en attente',
    'Tickets en attente de retour',
    'ticket',
    'public',
    NULL,
    'mdi:pause-circle-outline',
    '{"matchMode":"all","viewMode":"active","criteria":[{"field":"status","operator":"equals","value":"pending"}]}'::jsonb,
    20,
    TRUE
  ),
  (
    'Tous les tickets',
    'Tous les tickets actifs (hors corbeille)',
    'ticket',
    'public',
    NULL,
    'mdi:ticket-outline',
    '{"matchMode":"all","viewMode":"active","criteria":[]}'::jsonb,
    30,
    TRUE
  );
