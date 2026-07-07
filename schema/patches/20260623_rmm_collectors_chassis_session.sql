-- Nouveaux collecteurs RMM : chassis (marque/modèle/série) et session utilisateur

INSERT INTO v_b_settings (key, value, description, section)
VALUES
  ('RMM_COLLECT_CHASSIS', 'true', 'Collecter marque, modèle et n° de série', 'rmm'),
  ('RMM_COLLECT_SESSION', 'true', 'Collecter utilisateur connecté', 'rmm')
ON CONFLICT (key) DO NOTHING;
