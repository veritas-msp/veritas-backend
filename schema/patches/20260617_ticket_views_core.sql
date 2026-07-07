-- Vues tickets helpdesk (privées / publiques, règles JSON génériques)

CREATE TABLE IF NOT EXISTS v_b_ticket_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  description TEXT,
  page_scope VARCHAR(32) NOT NULL DEFAULT 'ticket'
    CHECK (page_scope IN ('ticket', 'ticket_sales')),
  visibility VARCHAR(16) NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'public')),
  owner_user_id UUID REFERENCES v_b_users(id) ON DELETE CASCADE,
  icon VARCHAR(64) NOT NULL DEFAULT 'mdi:view-list',
  color VARCHAR(32),
  rules JSONB NOT NULL DEFAULT '{"matchMode":"all","viewMode":"active","criteria":[]}'::jsonb,
  sort_by VARCHAR(64) NOT NULL DEFAULT 'updated_at',
  sort_direction VARCHAR(4) NOT NULL DEFAULT 'desc'
    CHECK (sort_direction IN ('asc', 'desc')),
  display_order INTEGER NOT NULL DEFAULT 0,
  is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_views_scope_visibility
  ON v_b_ticket_views(page_scope, visibility, display_order);

CREATE INDEX IF NOT EXISTS idx_v_b_ticket_views_owner
  ON v_b_ticket_views(owner_user_id, page_scope);

-- Vues publiques de départ (modifiables par les admins)
INSERT INTO v_b_ticket_views (name, description, page_scope, visibility, owner_user_id, icon, rules, display_order, is_builtin)
SELECT
  v.name,
  v.description,
  'ticket',
  'public',
  NULL,
  v.icon,
  v.rules::jsonb,
  v.display_order,
  TRUE
FROM (VALUES
  (
    'Nouveaux tickets',
    'Tickets au statut nouveau',
    'mdi:inbox-arrow-down',
    '{"matchMode":"all","viewMode":"active","criteria":[{"field":"status","operator":"equals","value":"new"}]}',
    0
  ),
  (
    'Tickets en cours',
    'Tickets en cours de traitement',
    'mdi:progress-clock',
    '{"matchMode":"all","viewMode":"active","criteria":[{"field":"status","operator":"equals","value":"in_progress"}]}',
    10
  ),
  (
    'Tickets en attente',
    'Tickets en attente de retour',
    'mdi:pause-circle-outline',
    '{"matchMode":"all","viewMode":"active","criteria":[{"field":"status","operator":"equals","value":"pending"}]}',
    20
  ),
  (
    'Tous les tickets',
    'Tous les tickets actifs (hors corbeille)',
    'mdi:ticket-outline',
    '{"matchMode":"all","viewMode":"active","criteria":[]}',
    30
  )
) AS v(name, description, icon, rules, display_order)
WHERE NOT EXISTS (
  SELECT 1 FROM v_b_ticket_views WHERE is_builtin = TRUE AND page_scope = 'ticket' LIMIT 1
);
