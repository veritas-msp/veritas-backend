import { pool } from "../database/db.js";

/** Taille moyenne estimée par ligne (données + index), en octets. */
export const RMM_METRICS_BYTES_PER_ROW = 72;

export function countMetricSeriesPerAgentDay(collectors = {}, avgDisksPerAgent = 3) {
  let count = 0;
  if (collectors.hardware !== false) {
    count += Math.max(1, Math.min(8, Math.round(Number(avgDisksPerAgent) || 3)));
  }
  if (collectors.updates !== false) count += 1;
  if (collectors.performance !== false) count += 2;
  if (collectors.sensors !== false) count += 1;
  return count;
}

/**
 * Estime la volumétrie à régime permanent (agrégation journalière).
 * La fréquence d'échantillonnage n'augmente pas le nombre de lignes — elle affine min/max du jour.
 */
export function estimateRmmMetricsStorage({
  agentCount = 0,
  retentionDays = 730,
  collectors = {},
  avgDisksPerAgent = 3,
} = {}) {
  const safeAgents = Math.max(0, Math.round(Number(agentCount) || 0));
  const safeRetention = Math.max(1, Math.min(3650, Math.round(Number(retentionDays) || 730)));
  const rowsPerAgentDay = countMetricSeriesPerAgentDay(collectors, avgDisksPerAgent);
  const steadyStateRows = safeAgents * rowsPerAgentDay * safeRetention;
  const tableBytes = steadyStateRows * RMM_METRICS_BYTES_PER_ROW;
  const estimatedBytes = Math.round(tableBytes * 1.35);

  return {
    agentCount: safeAgents,
    retentionDays: safeRetention,
    avgDisksPerAgent: Math.max(1, Math.min(8, Math.round(Number(avgDisksPerAgent) || 3))),
    rowsPerAgentDay,
    steadyStateRows,
    estimatedBytes,
    samplesPerDayHint: null,
  };
}

export async function fetchRmmMetricsStorageStats(client = pool) {
  const [statsResult, agentsResult, disksResult] = await Promise.all([
    client.query(`
      SELECT
        COUNT(*)::bigint AS row_count,
        COUNT(DISTINCT agent_id)::int AS agent_count,
        MIN(day_date) AS oldest_day,
        MAX(day_date) AS newest_day
      FROM v_b_rmm_metric_daily
    `),
    client.query(`
      SELECT COUNT(*)::int AS active_agents
      FROM v_b_rmm_agents
      WHERE status = 'active'
    `),
    client.query(`
      SELECT COALESCE(AVG(disk_dims), 3)::numeric(4,1) AS avg_disks_per_agent
      FROM (
        SELECT agent_id, COUNT(DISTINCT dim_id) AS disk_dims
        FROM v_b_rmm_metric_daily
        WHERE metric_id = 1 AND dim_id > 0 AND day_date >= CURRENT_DATE - 30
        GROUP BY agent_id
      ) t
    `),
  ]);

  let totalBytes = 0;
  let tableBytes = 0;
  let indexesBytes = 0;
  try {
    const sizeResult = await client.query(`
      SELECT
        pg_total_relation_size('v_b_rmm_metric_daily')::bigint AS total_bytes,
        pg_relation_size('v_b_rmm_metric_daily')::bigint AS table_bytes,
        pg_indexes_size('v_b_rmm_metric_daily')::bigint AS indexes_bytes
    `);
    totalBytes = Number(sizeResult.rows[0]?.total_bytes || 0);
    tableBytes = Number(sizeResult.rows[0]?.table_bytes || 0);
    indexesBytes = Number(sizeResult.rows[0]?.indexes_bytes || 0);
  } catch {
    const rowCount = Number(statsResult.rows[0]?.row_count || 0);
    totalBytes = Math.round(rowCount * RMM_METRICS_BYTES_PER_ROW * 1.35);
    tableBytes = Math.round(rowCount * RMM_METRICS_BYTES_PER_ROW);
    indexesBytes = totalBytes - tableBytes;
  }

  const row = statsResult.rows[0] || {};
  return {
    rowCount: Number(row.row_count || 0),
    agentCountWithData: Number(row.agent_count || 0),
    activeAgents: Number(agentsResult.rows[0]?.active_agents || 0),
    avgDisksPerAgent: Number(disksResult.rows[0]?.avg_disks_per_agent || 3),
    oldestDay: row.oldest_day || null,
    newestDay: row.newest_day || null,
    totalBytes,
    tableBytes,
    indexesBytes,
  };
}
