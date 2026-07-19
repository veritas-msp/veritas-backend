import { pool } from "../database/db.js";
import { listEquipmentFamilies } from "./equipmentFamilies.js";

const CHECKMK_MONITORED_WHERE =
  "checkmk_host_name IS NOT NULL AND btrim(checkmk_host_name) <> ''";

/** System monitorable families — aligned with clients.js + hexagonal mapping. */
export const SYSTEM_MONITORABLE_FAMILIES = [
  {
    key: "Ordinateurs",
    label: "Ordinateurs",
    icon: "mdi:laptop",
    table: "v_b_clients_m_ordinateurs",
    where: "client_id IS NOT NULL AND COALESCE(is_active, TRUE) = TRUE",
    monitoredWhere: `(agent_id IS NOT NULL OR (${CHECKMK_MONITORED_WHERE}))`,
  },
  {
    key: "Internet",
    label: "Internet",
    icon: "mdi:web",
    table: "v_b_clients_m_internet",
    where: "data IS NOT NULL",
  },
  {
    key: "Switch",
    label: "Switch",
    icon: "mdi:lan-connect",
    table: "v_b_clients_m_switch",
    where: "data IS NOT NULL",
  },
  {
    key: "Firewalls",
    label: "Firewall",
    icon: "mdi:shield-outline",
    table: "v_b_clients_m_firewall",
    where: "data IS NOT NULL",
  },
  {
    key: "Routeur",
    label: "Routeur / SD-WAN",
    icon: "mdi:router-wireless",
    table: "v_b_clients_m_routeur",
    where: "data IS NOT NULL",
  },
  {
    key: "Serveurs",
    label: "Serveurs",
    icon: "mdi:server",
    table: "v_b_clients_m_servers",
    where: "data IS NOT NULL",
  },
  {
    key: "BorneWifi",
    label: "Borne Wi‑Fi",
    icon: "mdi:wifi",
    table: "v_b_clients_m_wifi",
    where: "data IS NOT NULL",
  },
  {
    key: "Stockage",
    label: "Stockage",
    icon: "mdi:database-outline",
    table: "v_b_clients_m_stockage",
    where: "data IS NOT NULL",
  },
  {
    key: "Sauvegarde",
    label: "Sauvegarde",
    icon: "mdi:backup-restore",
    table: "v_b_clients_m_save",
    where: "data IS NOT NULL",
  },
  {
    key: "Alimentation",
    label: "Alimentation",
    icon: "mdi:power-plug",
    table: "v_b_clients_m_alimentation",
    where: "data IS NOT NULL",
  },
  {
    key: "TOIP",
    label: "TOIP / VOIP",
    icon: "mdi:phone-voip",
    table: "v_b_clients_m_toip",
    where: "data IS NOT NULL",
  },
];

const VIDEO_SURVEILLANCE_TABLES = [
  "v_b_clients_m_videosurveillance",
  "v_b_clients_m_camera",
  "v_b_clients_m_cameras",
];

function buildSurveillancePercent(monitoredCount, count) {
  const total = Number(count) || 0;
  const monitored = Number(monitoredCount) || 0;
  if (total <= 0) return null;
  return Math.round((monitored / total) * 100);
}

async function countFamilyWithMonitoring({ table, where, monitoredWhere = CHECKMK_MONITORED_WHERE }) {
  const count = await countFamilyTable({ table, where });
  let monitoredCount = 0;
  try {
    monitoredCount = await countOrZero(
      `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where} AND (${monitoredWhere})`
    );
  } catch (err) {
    if (err.code !== "42703") throw err;
  }
  return {
    count,
    monitoredCount,
    surveillancePercent: buildSurveillancePercent(monitoredCount, count),
  };
}

async function countOrZero(sql, params = []) {
  try {
    const result = await pool.query(sql, params);
    return Number(result.rows[0]?.count) || 0;
  } catch (err) {
    if (err.code === "42P01" || err.code === "42703") return 0;
    throw err;
  }
}

async function countFamilyTable({ table, where }) {
  return countOrZero(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`);
}

async function countVideoSurveillance() {
  for (const tableName of VIDEO_SURVEILLANCE_TABLES) {
    try {
      const stats = await countFamilyWithMonitoring({
        table: tableName,
        where: "data IS NOT NULL",
      });
      return stats;
    } catch (err) {
      if (err.code === "42P01") continue;
      throw err;
    }
  }
  return { count: 0, monitoredCount: 0, surveillancePercent: null };
}

async function countCustomFamilyMonitoring() {
  try {
    const result = await pool.query(`
      SELECT ce.family_key, COUNT(*)::int AS total_count,
             COUNT(cm.equipment_id)::int AS monitored_count
      FROM v_b_clients_m_custom_equipment ce
      LEFT JOIN v_b_equipment_checkmk_monitoring cm
        ON cm.equipment_id = ce.id
      WHERE ce.is_active IS NOT FALSE
      GROUP BY ce.family_key
    `);
    return new Map(
      result.rows.map((row) => [
        String(row.family_key),
        {
          count: Number(row.total_count) || 0,
          monitoredCount: Number(row.monitored_count) || 0,
        },
      ])
    );
  } catch (err) {
    if (err.code === "42P01" || err.code === "42703") return new Map();
    throw err;
  }
}

async function countCustomFamilies() {
  try {
    const monitoringByKey = await countCustomFamilyMonitoring();
    const definitions = await listEquipmentFamilies({ includeDisabled: false });
    return definitions.map((family) => {
      const stats = monitoringByKey.get(String(family.familyKey)) || {
        count: 0,
        monitoredCount: 0,
      };
      return {
        key: family.familyKey,
        label: family.label || family.familyKey,
        icon: family.icon || "mdi:devices",
        count: stats.count,
        monitoredCount: stats.monitoredCount,
        surveillancePercent: buildSurveillancePercent(stats.monitoredCount, stats.count),
        sortOrder: Number(family.sortOrder) || 100,
        isCustom: true,
      };
    });
  } catch (err) {
    if (err.code === "42P01" || err.code === "42703") return [];
    throw err;
  }
}

export async function fetchMonitorableEquipmentStats() {
  const families = [];

  for (const family of SYSTEM_MONITORABLE_FAMILIES) {
    const stats = await countFamilyWithMonitoring({
      table: family.table,
      where: family.where,
      monitoredWhere: family.monitoredWhere,
    });
    families.push({
      key: family.key,
      label: family.label,
      icon: family.icon,
      count: stats.count,
      monitoredCount: stats.monitoredCount,
      surveillancePercent: stats.surveillancePercent,
    });
  }

  const videoStats = await countVideoSurveillance();
  families.push({
    key: "Videosurveillance",
    label: "Vidéosurveillance",
    icon: "mdi:cctv",
    count: videoStats.count,
    monitoredCount: videoStats.monitoredCount,
    surveillancePercent: videoStats.surveillancePercent,
  });

  const customFamilies = await countCustomFamilies();
  const systemKeys = new Set(families.map((family) => family.key));
  customFamilies.forEach((family) => {
    if (systemKeys.has(family.key)) return;
    families.push({
      key: family.key,
      label: family.label,
      icon: family.icon,
      count: family.count,
      monitoredCount: family.monitoredCount,
      surveillancePercent: family.surveillancePercent,
    });
  });

  const equipMonitoredTotal = families.reduce((sum, family) => sum + (Number(family.count) || 0), 0);
  const equipUnderSurveillanceCount = families.reduce(
    (sum, family) => sum + (Number(family.monitoredCount) || 0),
    0
  );
  const equipSurveillancePercent = buildSurveillancePercent(
    equipUnderSurveillanceCount,
    equipMonitoredTotal
  );

  return {
    families,
    equipMonitoredTotal,
    equipUnderSurveillanceCount,
    equipSurveillancePercent,
  };
}
