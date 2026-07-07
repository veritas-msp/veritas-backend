-- Optimisation route GET /api/clients/list
-- Index de tri/recherche + jointure commerciale

CREATE INDEX IF NOT EXISTS idx_v_b_clients_name
  ON v_b_clients (name);

CREATE INDEX IF NOT EXISTS idx_v_b_clients_lower_name
  ON v_b_clients ((lower(name)));

CREATE INDEX IF NOT EXISTS idx_v_b_clients_commercial_id
  ON v_b_clients (commercial_id);

-- La jointure actuelle utilise ::text côté clients/users.
-- Ces index d'expression évitent un seq scan quand le planner garde le cast.
CREATE INDEX IF NOT EXISTS idx_v_b_clients_commercial_id_text
  ON v_b_clients ((commercial_id::text));

CREATE INDEX IF NOT EXISTS idx_v_b_users_id_text
  ON v_b_users ((id::text));
