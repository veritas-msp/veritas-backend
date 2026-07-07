import { pool } from "../database/db.js";

const RMM_SETTING_KEYS = [
  "RMM_HEARTBEAT_INTERVAL_MINUTES",
  "RMM_OFFLINE_THRESHOLD_MINUTES",
  "RMM_COLLECT_OS",
  "RMM_COLLECT_DOMAIN",
  "RMM_COLLECT_UPDATES",
  "RMM_COLLECT_LICENSE",
  "RMM_COLLECT_HARDWARE",
  "RMM_COLLECT_CHASSIS",
  "RMM_COLLECT_SESSION",
  "RMM_COLLECT_NETWORK",
  "RMM_COLLECT_SOFTWARE",
  "RMM_COLLECT_PRINTERS",
  "RMM_COLLECT_SHARES",
  "RMM_COLLECT_SERVICES",
  "RMM_COLLECT_PERIPHERALS",
  "RMM_COLLECT_PERFORMANCE",
  "RMM_COLLECT_SENSORS",
  "RMM_COLLECT_SECURITY",
  "RMM_METRICS_SAMPLE_INTERVAL_MINUTES",
  "RMM_METRICS_DISK_DELTA_PCT",
  "RMM_METRICS_RETENTION_DAYS",
];

const COLLECTOR_KEYS = [
  "os",
  "domain",
  "updates",
  "license",
  "hardware",
  "chassis",
  "session",
  "network",
  "software",
  "printers",
  "shares",
  "services",
  "peripherals",
  "performance",
  "sensors",
  "security",
];

const DEFAULTS = {
  RMM_HEARTBEAT_INTERVAL_MINUTES: 5,
  RMM_OFFLINE_THRESHOLD_MINUTES: 15,
  RMM_COLLECT_OS: true,
  RMM_COLLECT_DOMAIN: true,
  RMM_COLLECT_UPDATES: true,
  RMM_COLLECT_LICENSE: true,
  RMM_COLLECT_HARDWARE: true,
  RMM_COLLECT_CHASSIS: true,
  RMM_COLLECT_SESSION: true,
  RMM_COLLECT_NETWORK: true,
  RMM_COLLECT_SOFTWARE: false,
  RMM_COLLECT_PRINTERS: true,
  RMM_COLLECT_SHARES: true,
  RMM_COLLECT_SERVICES: true,
  RMM_COLLECT_PERIPHERALS: true,
  RMM_COLLECT_PERFORMANCE: true,
  RMM_COLLECT_SENSORS: true,
  RMM_COLLECT_SECURITY: true,
  RMM_METRICS_SAMPLE_INTERVAL_MINUTES: 60,
  RMM_METRICS_DISK_DELTA_PCT: 5,
  RMM_METRICS_RETENTION_DAYS: 730,
};

const METRICS_BOUNDS = {
  sampleIntervalMinutes: { min: 15, max: 1440 },
  diskDeltaPct: { min: 1, max: 50 },
  retentionDays: { min: 30, max: 3650 },
};

function clampMetricsValue(key, value, fallback) {
  const bounds = METRICS_BOUNDS[key];
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

function buildMetricsFromDb(byKey = {}) {
  return {
    sampleIntervalMinutes: clampMetricsValue(
      "sampleIntervalMinutes",
      byKey.RMM_METRICS_SAMPLE_INTERVAL_MINUTES,
      DEFAULTS.RMM_METRICS_SAMPLE_INTERVAL_MINUTES
    ),
    diskDeltaPct: clampMetricsValue(
      "diskDeltaPct",
      byKey.RMM_METRICS_DISK_DELTA_PCT,
      DEFAULTS.RMM_METRICS_DISK_DELTA_PCT
    ),
    retentionDays: clampMetricsValue(
      "retentionDays",
      byKey.RMM_METRICS_RETENTION_DAYS,
      DEFAULTS.RMM_METRICS_RETENTION_DAYS
    ),
  };
}

function mergeMetricsSettings(baseMetrics, overridesMetrics = null) {
  const merged = { ...baseMetrics };
  if (!overridesMetrics || typeof overridesMetrics !== "object") return merged;
  for (const key of Object.keys(METRICS_BOUNDS)) {
    if (overridesMetrics[key] !== undefined && overridesMetrics[key] !== null) {
      merged[key] = clampMetricsValue(key, overridesMetrics[key], merged[key]);
    }
  }
  return merged;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "oui"].includes(normalized)) return true;
  if (["false", "0", "no", "non"].includes(normalized)) return false;
  return fallback;
}

function parseIntSetting(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function mapGlobalRows(byKey) {
  return {
    heartbeatIntervalMinutes: parseIntSetting(
      byKey.RMM_HEARTBEAT_INTERVAL_MINUTES,
      DEFAULTS.RMM_HEARTBEAT_INTERVAL_MINUTES
    ),
    offlineThresholdMinutes: parseIntSetting(
      byKey.RMM_OFFLINE_THRESHOLD_MINUTES,
      DEFAULTS.RMM_OFFLINE_THRESHOLD_MINUTES
    ),
    collectors: {
      os: parseBool(byKey.RMM_COLLECT_OS, DEFAULTS.RMM_COLLECT_OS),
      domain: parseBool(byKey.RMM_COLLECT_DOMAIN, DEFAULTS.RMM_COLLECT_DOMAIN),
      updates: parseBool(byKey.RMM_COLLECT_UPDATES, DEFAULTS.RMM_COLLECT_UPDATES),
      license: parseBool(byKey.RMM_COLLECT_LICENSE, DEFAULTS.RMM_COLLECT_LICENSE),
      hardware: parseBool(byKey.RMM_COLLECT_HARDWARE, DEFAULTS.RMM_COLLECT_HARDWARE),
      chassis: parseBool(byKey.RMM_COLLECT_CHASSIS, DEFAULTS.RMM_COLLECT_CHASSIS),
      session: parseBool(byKey.RMM_COLLECT_SESSION, DEFAULTS.RMM_COLLECT_SESSION),
      network: parseBool(byKey.RMM_COLLECT_NETWORK, DEFAULTS.RMM_COLLECT_NETWORK),
      software: parseBool(byKey.RMM_COLLECT_SOFTWARE, DEFAULTS.RMM_COLLECT_SOFTWARE),
      printers: parseBool(byKey.RMM_COLLECT_PRINTERS, DEFAULTS.RMM_COLLECT_PRINTERS),
      shares: parseBool(byKey.RMM_COLLECT_SHARES, DEFAULTS.RMM_COLLECT_SHARES),
      services: parseBool(byKey.RMM_COLLECT_SERVICES, DEFAULTS.RMM_COLLECT_SERVICES),
      peripherals: parseBool(byKey.RMM_COLLECT_PERIPHERALS, DEFAULTS.RMM_COLLECT_PERIPHERALS),
      performance: parseBool(byKey.RMM_COLLECT_PERFORMANCE, DEFAULTS.RMM_COLLECT_PERFORMANCE),
      sensors: parseBool(byKey.RMM_COLLECT_SENSORS, DEFAULTS.RMM_COLLECT_SENSORS),
      security: parseBool(byKey.RMM_COLLECT_SECURITY, DEFAULTS.RMM_COLLECT_SECURITY),
    },
    metrics: buildMetricsFromDb(byKey),
  };
}

export function mergeRmmSettings(global, overrides = null) {
  const base = global || mapGlobalRows({});
  if (!overrides || typeof overrides !== "object") {
    return { ...base, collectors: { ...base.collectors }, metrics: { ...base.metrics }, scope: "global" };
  }

  const merged = {
    heartbeatIntervalMinutes:
      overrides.heartbeatIntervalMinutes != null
        ? parseIntSetting(overrides.heartbeatIntervalMinutes, base.heartbeatIntervalMinutes)
        : base.heartbeatIntervalMinutes,
    offlineThresholdMinutes:
      overrides.offlineThresholdMinutes != null
        ? parseIntSetting(overrides.offlineThresholdMinutes, base.offlineThresholdMinutes)
        : base.offlineThresholdMinutes,
    collectors: { ...base.collectors },
    metrics: mergeMetricsSettings(base.metrics, overrides.metrics),
    scope: "client",
  };

  if (overrides.collectors && typeof overrides.collectors === "object") {
    for (const key of COLLECTOR_KEYS) {
      if (overrides.collectors[key] !== undefined && overrides.collectors[key] !== null) {
        merged.collectors[key] = parseBool(overrides.collectors[key], base.collectors[key]);
      }
    }
  }

  return merged;
}

export async function fetchGlobalRmmSettings() {
  const result = await pool.query(
    `SELECT key, value FROM v_b_settings WHERE section = 'rmm' AND key = ANY($1::text[])`,
    [RMM_SETTING_KEYS]
  );
  const byKey = Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
  return mapGlobalRows(byKey);
}

/** @param {number|null|undefined} clientId */
export async function fetchRmmSettings(clientId = null) {
  const global = await fetchGlobalRmmSettings();
  if (!clientId) {
    return { ...global, collectors: { ...global.collectors }, metrics: { ...global.metrics }, scope: "global" };
  }

  const overrides = await fetchClientRmmOverrides(clientId);
  return mergeRmmSettings(global, overrides);
}

export async function fetchClientRmmOverrides(clientId) {
  if (!clientId) return null;
  const result = await pool.query(
    `SELECT overrides FROM v_b_rmm_client_settings WHERE client_id = $1 LIMIT 1`,
    [clientId]
  );
  const raw = result.rows[0]?.overrides;
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) return null;
  return raw;
}

export async function listClientRmmSettings() {
  const result = await pool.query(
    `SELECT s.client_id, s.overrides, s.updated_at, c.name AS client_name
     FROM v_b_rmm_client_settings s
     JOIN v_b_clients c ON c.id = s.client_id
     ORDER BY c.name ASC`
  );
  return result.rows.map((row) => ({
    clientId: row.client_id,
    clientName: row.client_name,
    overrides: row.overrides || {},
    updatedAt: row.updated_at,
  }));
}

export function sanitizeClientRmmOverrides(payload = {}) {
  const overrides = {};
  if (payload.heartbeatIntervalMinutes !== undefined && payload.heartbeatIntervalMinutes !== null) {
    overrides.heartbeatIntervalMinutes = parseIntSetting(payload.heartbeatIntervalMinutes, null);
  }
  if (payload.offlineThresholdMinutes !== undefined && payload.offlineThresholdMinutes !== null) {
    overrides.offlineThresholdMinutes = parseIntSetting(payload.offlineThresholdMinutes, null);
  }
  if (payload.collectors && typeof payload.collectors === "object") {
    const collectors = {};
    for (const key of COLLECTOR_KEYS) {
      if (payload.collectors[key] !== undefined && payload.collectors[key] !== null) {
        collectors[key] = Boolean(payload.collectors[key]);
      }
    }
    if (Object.keys(collectors).length > 0) {
      overrides.collectors = collectors;
    }
  }
  if (payload.metrics && typeof payload.metrics === "object") {
    const metrics = {};
    for (const key of Object.keys(METRICS_BOUNDS)) {
      if (payload.metrics[key] !== undefined && payload.metrics[key] !== null) {
        const base = buildMetricsFromDb({});
        metrics[key] = clampMetricsValue(key, payload.metrics[key], base[key]);
      }
    }
    if (Object.keys(metrics).length > 0) {
      overrides.metrics = metrics;
    }
  }
  return overrides;
}

export async function saveClientRmmSettings(clientId, overrides = {}, updatedBy = null) {
  const sanitized = sanitizeClientRmmOverrides(overrides);
  if (Object.keys(sanitized).length === 0) {
    await deleteClientRmmSettings(clientId);
    return null;
  }

  const result = await pool.query(
    `INSERT INTO v_b_rmm_client_settings (client_id, overrides, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (client_id) DO UPDATE SET
       overrides = EXCLUDED.overrides,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING overrides, updated_at`,
    [clientId, JSON.stringify(sanitized), updatedBy]
  );
  return result.rows[0]?.overrides || sanitized;
}

export async function deleteClientRmmSettings(clientId) {
  await pool.query(`DELETE FROM v_b_rmm_client_settings WHERE client_id = $1`, [clientId]);
}

export async function saveRmmSettings(payload = {}) {
  const updates = [];

  if (payload.heartbeatIntervalMinutes !== undefined) {
    updates.push(["RMM_HEARTBEAT_INTERVAL_MINUTES", String(payload.heartbeatIntervalMinutes)]);
  }
  if (payload.offlineThresholdMinutes !== undefined) {
    updates.push(["RMM_OFFLINE_THRESHOLD_MINUTES", String(payload.offlineThresholdMinutes)]);
  }
  if (payload.collectors) {
    const map = {
      os: "RMM_COLLECT_OS",
      domain: "RMM_COLLECT_DOMAIN",
      updates: "RMM_COLLECT_UPDATES",
      license: "RMM_COLLECT_LICENSE",
      hardware: "RMM_COLLECT_HARDWARE",
      chassis: "RMM_COLLECT_CHASSIS",
      session: "RMM_COLLECT_SESSION",
      network: "RMM_COLLECT_NETWORK",
      software: "RMM_COLLECT_SOFTWARE",
      printers: "RMM_COLLECT_PRINTERS",
      shares: "RMM_COLLECT_SHARES",
      services: "RMM_COLLECT_SERVICES",
      peripherals: "RMM_COLLECT_PERIPHERALS",
      performance: "RMM_COLLECT_PERFORMANCE",
      sensors: "RMM_COLLECT_SENSORS",
      security: "RMM_COLLECT_SECURITY",
    };
    for (const [key, settingKey] of Object.entries(map)) {
      if (payload.collectors[key] !== undefined) {
        updates.push([settingKey, payload.collectors[key] ? "true" : "false"]);
      }
    }
  }

  if (payload.metrics && typeof payload.metrics === "object") {
    const metricsMap = {
      sampleIntervalMinutes: "RMM_METRICS_SAMPLE_INTERVAL_MINUTES",
      diskDeltaPct: "RMM_METRICS_DISK_DELTA_PCT",
      retentionDays: "RMM_METRICS_RETENTION_DAYS",
    };
    for (const [key, settingKey] of Object.entries(metricsMap)) {
      if (payload.metrics[key] !== undefined) {
        const base = buildMetricsFromDb({});
        updates.push([settingKey, String(clampMetricsValue(key, payload.metrics[key], base[key]))]);
      }
    }
  }

  for (const [key, value] of updates) {
    await pool.query(
      `INSERT INTO v_b_settings (key, value, section)
       VALUES ($1, $2, 'rmm')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, section = EXCLUDED.section`,
      [key, value]
    );
  }

  return fetchGlobalRmmSettings();
}

export function isAgentOnline(lastSeenAt, offlineThresholdMinutes) {
  if (!lastSeenAt) return false;
  const last = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(last)) return false;
  return Date.now() - last <= offlineThresholdMinutes * 60 * 1000;
}
