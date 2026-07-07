-- Refonte complète table système maintenance (modèle mono-ligne)
-- ATTENTION: cette migration DROP la table existante.

DROP TABLE IF EXISTS v_b_settings_system;

CREATE TABLE v_b_settings_system (
  id SMALLINT PRIMARY KEY,
  maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
  maintenance_message TEXT NOT NULL DEFAULT 'L''application est actuellement en maintenance. Veuillez réessayer plus tard.',
  ticker_color VARCHAR(7) NOT NULL DEFAULT '#d97706',
  ticker_speed INTEGER NOT NULL DEFAULT 22,
  ticker_direction VARCHAR(5) NOT NULL DEFAULT 'left',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_v_b_settings_system_id CHECK (id = 1),
  CONSTRAINT chk_v_b_settings_system_ticker_speed CHECK (ticker_speed BETWEEN 5 AND 60),
  CONSTRAINT chk_v_b_settings_system_ticker_direction CHECK (ticker_direction IN ('left', 'right')),
  CONSTRAINT chk_v_b_settings_system_ticker_color CHECK (ticker_color ~ '^#[0-9A-Fa-f]{6}$')
);

INSERT INTO v_b_settings_system (
  id,
  maintenance_mode,
  maintenance_message,
  ticker_color,
  ticker_speed,
  ticker_direction
) VALUES (
  1,
  FALSE,
  'L''application est actuellement en maintenance. Veuillez réessayer plus tard.',
  '#d97706',
  22,
  'left'
);

