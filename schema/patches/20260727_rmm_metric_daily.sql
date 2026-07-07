-- Historique métriques RMM compact (agrégation journalière, ~40 octets/ligne)
-- metric_id : 1 = disque % utilisé, 2 = MAJ Windows en attente
-- dim_id    : 0 = sans dimension, 1-26 = lettre lecteur (A=1 … Z=26)

CREATE TABLE IF NOT EXISTS v_b_rmm_metric_daily (
  agent_id UUID NOT NULL REFERENCES v_b_rmm_agents(id) ON DELETE CASCADE,
  day_date DATE NOT NULL,
  metric_id SMALLINT NOT NULL,
  dim_id SMALLINT NOT NULL DEFAULT 0,
  val_last SMALLINT NOT NULL,
  val_min SMALLINT NOT NULL,
  val_max SMALLINT NOT NULL,
  sample_count SMALLINT NOT NULL DEFAULT 1,
  PRIMARY KEY (agent_id, day_date, metric_id, dim_id),
  CONSTRAINT v_b_rmm_metric_daily_metric_chk CHECK (metric_id BETWEEN 1 AND 32),
  CONSTRAINT v_b_rmm_metric_daily_dim_chk CHECK (dim_id BETWEEN 0 AND 26)
);

CREATE INDEX IF NOT EXISTS idx_v_b_rmm_metric_daily_agent_day
  ON v_b_rmm_metric_daily (agent_id, day_date DESC);

CREATE INDEX IF NOT EXISTS idx_v_b_rmm_metric_daily_day
  ON v_b_rmm_metric_daily (day_date);
