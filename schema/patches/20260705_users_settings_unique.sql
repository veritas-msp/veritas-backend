-- Index unique pour les upserts ON CONFLICT (user_id, setting_key)
-- Supprime les doublons éventuels avant de créer l'index.

DELETE FROM v_b_users_settings a
USING v_b_users_settings b
WHERE a.user_id = b.user_id
  AND a.setting_key = b.setting_key
  AND (
    a.updated_at < b.updated_at
    OR (a.updated_at = b.updated_at AND a.id < b.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_v_b_users_settings_user_key
  ON v_b_users_settings (user_id, setting_key);
