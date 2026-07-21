import { pool } from "../database/db.js";
import { fetchGlobalRmmSettings } from "./rmmSettings.js";
export const RMM_METRIC_ID = {
  DISK_USED_PCT: 1,
  UPDATES_PENDING: 2,
  CPU_USAGE_PCT: 3,
  RAM_USAGE_PCT: 4,
  CPU_TEMP_C: 5
};
export const RMM_METRIC_NAMES = {
  disk_used_pct: RMM_METRIC_ID.DISK_USED_PCT,
  updates_pending: RMM_METRIC_ID.UPDATES_PENDING,
  cpu_usage_pct: RMM_METRIC_ID.CPU_USAGE_PCT,
  ram_usage_pct: RMM_METRIC_ID.RAM_USAGE_PCT,
  cpu_temp_c: RMM_METRIC_ID.CPU_TEMP_C
};
const METRIC_ID_TO_NAME = Object.fromEntries(Object.entries(RMM_METRIC_NAMES).map(([name, id]) => [String(id), name]));
export const RMM_METRICS_SAMPLE_INTERVAL_MS_DEFAULT = 60 * 60 * 1000;
export const RMM_METRICS_RETENTION_DAYS_DEFAULT = 730;
export const RMM_METRICS_DISK_DELTA_PCT_DEFAULT = 5;
let lastRetentionRunAt = 0;
export function resolveMetricsRuntimeConfig(settings = {}) {
  const metrics = settings?.metrics || {};
  const sampleIntervalMinutes = Number(metrics.sampleIntervalMinutes) || 60;
  const diskDeltaPct = Number(metrics.diskDeltaPct) || RMM_METRICS_DISK_DELTA_PCT_DEFAULT;
  const retentionDays = Number(metrics.retentionDays) || RMM_METRICS_RETENTION_DAYS_DEFAULT;
  return {
    sampleIntervalMs: Math.max(15, sampleIntervalMinutes) * 60 * 1000,
    diskDeltaPct: Math.max(1, diskDeltaPct),
    retentionDays: Math.max(30, retentionDays)
  };
}
export function driveToDimId(drive) {
  const match = String(drive || "").trim().toUpperCase().match(/^([A-Z])/);
  if (!match) return 0;
  const code = match[1].charCodeAt(0) - 64;
  return code >= 1 && code <= 26 ? code : 0;
}
export function dimIdToDrive(dimId) {
  const id = Number(dimId);
  if (!Number.isFinite(id) || id < 1 || id > 26) return null;
  return `${String.fromCharCode(64 + id)}:`;
}
function clampSmallInt(value, max = 32767) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(max, n));
}
function parseDiskUsedPct(disk) {
  if (!disk || typeof disk !== "object") return null;
  const sizeGB = disk.sizeGB ?? disk.sizeGb ?? null;
  const freeGB = disk.freeGB ?? disk.freeGb ?? null;
  if (sizeGB == null || sizeGB <= 0) return null;
  const used = Math.max(0, sizeGB - (freeGB ?? 0));
  return clampSmallInt(used / sizeGB * 100, 100);
}
export function extractRmmMetricSamples(inventory = {}, collectors = {}) {
  const samples = [];
  if (!inventory || typeof inventory !== "object") return samples;
  if (collectors.hardware !== false) {
    const disks = inventory.hardware?.disks;
    if (Array.isArray(disks)) {
      for (const disk of disks) {
        const dimId = driveToDimId(disk.drive || disk.device || disk.DeviceID);
        if (!dimId) continue;
        const pct = parseDiskUsedPct(disk);
        if (pct == null) continue;
        samples.push({
          metricId: RMM_METRIC_ID.DISK_USED_PCT,
          dimId,
          value: pct
        });
      }
    }
  }
  if (collectors.updates !== false) {
    const updates = inventory.updates || {};
    const pending = updates.pendingCount ?? (Array.isArray(updates.pending) ? updates.pending.length : null);
    if (pending != null) {
      const value = clampSmallInt(pending);
      if (value != null) {
        samples.push({
          metricId: RMM_METRIC_ID.UPDATES_PENDING,
          dimId: 0,
          value
        });
      }
    }
  }
  if (collectors.performance !== false) {
    const perf = inventory.performance || {};
    const cpu = clampSmallInt(perf.cpuUsagePct, 100);
    const ram = clampSmallInt(perf.ramUsagePct, 100);
    if (cpu != null) {
      samples.push({
        metricId: RMM_METRIC_ID.CPU_USAGE_PCT,
        dimId: 0,
        value: cpu
      });
    }
    if (ram != null) {
      samples.push({
        metricId: RMM_METRIC_ID.RAM_USAGE_PCT,
        dimId: 0,
        value: ram
      });
    }
  }
  if (collectors.sensors !== false) {
    const maxTemp = inventory.sensors?.maxTempC;
    const temp = clampSmallInt(maxTemp, 150);
    if (temp != null && temp > 0) {
      samples.push({
        metricId: RMM_METRIC_ID.CPU_TEMP_C,
        dimId: 0,
        value: temp
      });
    }
  }
  return samples;
}
function shouldSampleNow(agentConfig = {}, samples = [], metricsRuntime = {}) {
  const lastAt = agentConfig?.metricsLastSampleAt;
  if (!lastAt) return true;
  const lastMs = new Date(lastAt).getTime();
  if (!Number.isFinite(lastMs)) return true;
  if (Date.now() - lastMs >= (metricsRuntime.sampleIntervalMs || RMM_METRICS_SAMPLE_INTERVAL_MS_DEFAULT)) {
    return true;
  }
  const lastWorst = Number(agentConfig?.metricsLastWorstDiskPct);
  if (!Number.isFinite(lastWorst)) return false;
  const deltaPct = metricsRuntime.diskDeltaPct || RMM_METRICS_DISK_DELTA_PCT_DEFAULT;
  for (const sample of samples) {
    if (sample.metricId !== RMM_METRIC_ID.DISK_USED_PCT) continue;
    if (Math.abs(sample.value - lastWorst) >= deltaPct) {
      return true;
    }
  }
  return false;
}
function worstDiskPct(samples) {
  let worst = null;
  for (const sample of samples) {
    if (sample.metricId !== RMM_METRIC_ID.DISK_USED_PCT) continue;
    if (worst == null || sample.value > worst) worst = sample.value;
  }
  return worst;
}
export async function upsertRmmMetricSamples(agentId, samples, client = pool) {
  if (!agentId || !samples.length) return 0;
  const metricIds = samples.map(s => s.metricId);
  const dimIds = samples.map(s => s.dimId);
  const values = samples.map(s => s.value);
  await client.query(`INSERT INTO v_b_rmm_metric_daily
       (agent_id, day_date, metric_id, dim_id, val_last, val_min, val_max, sample_count)
     SELECT $1::uuid, CURRENT_DATE, u.metric_id, u.dim_id, u.val, u.val, u.val, 1::smallint
     FROM unnest($2::smallint[], $3::smallint[], $4::smallint[]) AS u(metric_id, dim_id, val)
     ON CONFLICT (agent_id, day_date, metric_id, dim_id) DO UPDATE SET
       val_last = EXCLUDED.val_last,
       val_min = LEAST(v_b_rmm_metric_daily.val_min, EXCLUDED.val_last),
       val_max = GREATEST(v_b_rmm_metric_daily.val_max, EXCLUDED.val_last),
       sample_count = LEAST(32767, v_b_rmm_metric_daily.sample_count + 1)::smallint`, [agentId, metricIds, dimIds, values]);
  return samples.length;
}
export async function touchAgentMetricsSampleMeta(agentId, agentConfig = {}, samples = [], client = pool) {
  const patch = {
    metricsLastSampleAt: new Date().toISOString()
  };
  const worst = worstDiskPct(samples);
  if (worst != null) patch.metricsLastWorstDiskPct = worst;
  const nextConfig = {
    ...(agentConfig && typeof agentConfig === "object" ? agentConfig : {}),
    ...patch
  };
  await client.query(`UPDATE v_b_rmm_agents
     SET config = $2::jsonb, updated_at = NOW()
     WHERE id = $1`, [agentId, JSON.stringify(nextConfig)]);
}
export async function maybePurgeOldRmmMetrics(client = pool) {
  const now = Date.now();
  if (now - lastRetentionRunAt < 24 * 60 * 60 * 1000) return 0;
  lastRetentionRunAt = now;
  const global = await fetchGlobalRmmSettings();
  const defaultDays = resolveMetricsRuntimeConfig(global).retentionDays || RMM_METRICS_RETENTION_DAYS_DEFAULT;
  const result = await client.query(`DELETE FROM v_b_rmm_metric_daily d
     WHERE d.day_date < CURRENT_DATE - (
       SELECT COALESCE(
         NULLIF((s.overrides->'metrics'->>'retentionDays')::int, 0),
         $1::int
       )
       FROM v_b_rmm_agents a
       LEFT JOIN v_b_rmm_client_settings s ON s.client_id = a.client_id
       WHERE a.id = d.agent_id
       LIMIT 1
     )`, [defaultDays]);
  return result.rowCount || 0;
}
export async function recordRmmMetricsFromHeartbeat(agent, inventory, settings = {}) {
  if (!agent?.id || !inventory || typeof inventory !== "object") return {
    sampled: false
  };
  const collectors = settings.collectors || {};
  const metricsRuntime = resolveMetricsRuntimeConfig(settings);
  const samples = extractRmmMetricSamples(inventory, collectors);
  if (!samples.length) return {
    sampled: false
  };
  const agentConfig = agent.config && typeof agent.config === "object" ? agent.config : {};
  if (!shouldSampleNow(agentConfig, samples, metricsRuntime)) {
    return {
      sampled: false,
      skipped: "interval"
    };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const count = await upsertRmmMetricSamples(agent.id, samples, client);
    await touchAgentMetricsSampleMeta(agent.id, agentConfig, samples, client);
    await client.query("COMMIT");
    await maybePurgeOldRmmMetrics(client);
    return {
      sampled: true,
      count
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
export function resolveMetricId(metricName) {
  if (metricName == null || metricName === "") return null;
  const asNumber = Number(metricName);
  if (Number.isFinite(asNumber) && METRIC_ID_TO_NAME[String(asNumber)]) {
    return asNumber;
  }
  return RMM_METRIC_NAMES[String(metricName).trim()] ?? null;
}
export function resolveDimId(dimInput) {
  if (dimInput == null || dimInput === "") return 0;
  const asNumber = Number(dimInput);
  if (Number.isFinite(asNumber) && asNumber >= 0 && asNumber <= 26) {
    return asNumber;
  }
  return driveToDimId(dimInput);
}
export async function fetchRmmMetricHistory(agentId, {
  metricId,
  dimId = 0,
  days = 90
} = {}) {
  const safeDays = Math.min(730, Math.max(1, Number.parseInt(String(days), 10) || 90));
  const result = await pool.query(`SELECT day_date, val_last, val_min, val_max, sample_count
     FROM v_b_rmm_metric_daily
     WHERE agent_id = $1
       AND metric_id = $2
       AND dim_id = $3
       AND day_date >= CURRENT_DATE - $4::integer
     ORDER BY day_date ASC`, [agentId, metricId, dimId, safeDays]);
  return result.rows.map(row => ({
    day: row.day_date,
    last: row.val_last,
    min: row.val_min,
    max: row.val_max,
    samples: row.sample_count
  }));
}
export function metricIdToName(metricId) {
  return METRIC_ID_TO_NAME[String(metricId)] || null;
}
