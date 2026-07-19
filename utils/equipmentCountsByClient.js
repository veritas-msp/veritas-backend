import { pool } from "../database/db.js";

/** Keys aligned with EnterprisesPage / equipmentFamilyConstants */
export const EQUIPMENT_COUNT_KEYS = [
  "Ordinateurs",
  "Internet",
  "Firewalls",
  "Serveurs",
  "Stockage",
  "Switch",
  "BorneWifi",
  "Alimentation",
  "Routeur",
  "TOIP",
  "Sauvegarde",
];

export const createEmptyEquipmentCounts = () =>
  Object.fromEntries(EQUIPMENT_COUNT_KEYS.map((key) => [key, 0]));

const MODULE_FLAG_LABELS = [
  "Internet",
  "Firewalls",
  "Firewall",
  "Serveurs",
  "Stockage",
  "Switch",
  "BorneWifi",
  "Alimentation",
  "Routeur",
  "TOIP",
  "Sauvegarde",
  "Ordinateurs",
];

const MODULE_FLAG_SQL_LIST = MODULE_FLAG_LABELS.map((label) => `'${label}'`).join(", ");

/** Excludes "module enabled" rows without real equipment. */
const EXCLUDE_MODULE_FLAG_ROWS = `
  AND NOT (
    COALESCE(item_key, '') IN (${MODULE_FLAG_SQL_LIST})
    OR COALESCE(name, '') IN (${MODULE_FLAG_SQL_LIST})
  )
`;

const STANDARD_EQUIPMENT_WHERE = `
  client_id IS NOT NULL
  AND data IS NOT NULL
  AND COALESCE(is_active, TRUE) = TRUE
  ${EXCLUDE_MODULE_FLAG_ROWS}
`;

const STANDARD_EQUIPMENT_WHERE_FALLBACK = `
  client_id IS NOT NULL
  AND data IS NOT NULL
  ${EXCLUDE_MODULE_FLAG_ROWS}
`;

const ORDINATEURS_WHERE = `
  client_id IS NOT NULL
  AND COALESCE(is_active, TRUE) = TRUE
  ${EXCLUDE_MODULE_FLAG_ROWS}
`;

const ORDINATEURS_WHERE_FALLBACK = `
  client_id IS NOT NULL
  ${EXCLUDE_MODULE_FLAG_ROWS}
`;

/** Instanthese backup only (not jobs CheckMK). */
const SAUVEGARDE_COUNT_SQL = `
  SELECT client_id::text AS client_id,
         SUM(
           CASE
             WHEN COALESCE(item_key, '') LIKE 'job-%' OR COALESCE(data->>'type', '') = 'job' THEN 0
             WHEN data ? 'logiciel' THEN 1
             WHEN data ? 'instances'
               AND jsonb_typeof(data->'instances') = 'array'
               AND jsonb_array_length(data->'instances') > 0
               THEN jsonb_array_length(data->'instances')
             ELSE 0
           END
         )::int AS cnt
  FROM v_b_clients_m_save
  WHERE client_id IS NOT NULL
    AND data IS NOT NULL
    AND COALESCE(is_active, TRUE) = TRUE
  GROUP BY client_id
`;

const EQUIPMENT_COUNT_TABLES = [
  { responseKey: "Ordinateurs", table: "v_b_clients_m_ordinateurs", where: ORDINATEURS_WHERE, fallbackWhere: ORDINATEURS_WHERE_FALLBACK },
  { responseKey: "Internet", table: "v_b_clients_m_internet", where: STANDARD_EQUIPMENT_WHERE, fallbackWhere: STANDARD_EQUIPMENT_WHERE_FALLBACK },
  { responseKey: "Firewalls", table: "v_b_clients_m_firewall", where: STANDARD_EQUIPMENT_WHERE, fallbackWhere: STANDARD_EQUIPMENT_WHERE_FALLBACK },
  { responseKey: "Serveurs", table: "v_b_clients_m_servers", where: STANDARD_EQUIPMENT_WHERE, fallbackWhere: STANDARD_EQUIPMENT_WHERE_FALLBACK },
  { responseKey: "Stockage", table: "v_b_clients_m_stockage", where: STANDARD_EQUIPMENT_WHERE, fallbackWhere: STANDARD_EQUIPMENT_WHERE_FALLBACK },
  { responseKey: "Switch", table: "v_b_clients_m_switch", where: STANDARD_EQUIPMENT_WHERE, fallbackWhere: STANDARD_EQUIPMENT_WHERE_FALLBACK },
  { responseKey: "BorneWifi", table: "v_b_clients_m_wifi", where: STANDARD_EQUIPMENT_WHERE, fallbackWhere: STANDARD_EQUIPMENT_WHERE_FALLBACK },
  { responseKey: "Alimentation", table: "v_b_clients_m_alimentation", where: STANDARD_EQUIPMENT_WHERE, fallbackWhere: STANDARD_EQUIPMENT_WHERE_FALLBACK },
  { responseKey: "Routeur", table: "v_b_clients_m_routeur", where: STANDARD_EQUIPMENT_WHERE, fallbackWhere: STANDARD_EQUIPMENT_WHERE_FALLBACK },
  { responseKey: "TOIP", table: "v_b_clients_m_toip", where: STANDARD_EQUIPMENT_WHERE, fallbackWhere: STANDARD_EQUIPMENT_WHERE_FALLBACK },
];

async function queryGroupedCounts(sql) {
  const result = await pool.query(sql);
  return result.rows;
}

async function countStandardEquipmentTable({ table, where, fallbackWhere }) {
  const sql = `
    SELECT client_id::text AS client_id, COUNT(*)::int AS cnt
    FROM ${table}
    WHERE ${where}
    GROUP BY client_id
  `;

  try {
    return await queryGroupedCounts(sql);
  } catch (err) {
    if (err.code === "42703" && fallbackWhere) {
      return await queryGroupedCounts(`
        SELECT client_id::text AS client_id, COUNT(*)::int AS cnt
        FROM ${table}
        WHERE ${fallbackWhere}
        GROUP BY client_id
      `);
    }
    throw err;
  }
}

function mergeCountRows(byClientId, rows, responseKey) {
  for (const row of rows) {
    const clientId = String(row.client_id);
    if (!byClientId[clientId]) {
      byClientId[clientId] = createEmptyEquipmentCounts();
    }
    byClientId[clientId][responseKey] = Number(row.cnt) || 0;
  }
}

/**
 * Equipment counts per client for EnterprisesPage (v_b_clients_m_* tables).
 */
export async function fetchEquipmentCountsByClientId() {
  const byClientId = {};

  for (const entry of EQUIPMENT_COUNT_TABLES) {
    try {
      const rows = await countStandardEquipmentTable(entry);
      mergeCountRows(byClientId, rows, entry.responseKey);
    } catch (err) {
      if (err.code === "42P01" || err.code === "42703") {
        console.warn(`[equipment-counts] ${entry.table} skipped:`, err.message);
        continue;
      }
      throw err;
    }
  }

  try {
    const saveRows = await queryGroupedCounts(SAUVEGARDE_COUNT_SQL);
    mergeCountRows(byClientId, saveRows, "Sauvegarde");
  } catch (err) {
    if (err.code === "42P01" || err.code === "42703") {
      console.warn("[equipment-counts] v_b_clients_m_save skipped:", err.message);
    } else {
      throw err;
    }
  }

  try {
    const customResult = await pool.query(`
      SELECT client_id::text AS client_id,
             family_key,
             COUNT(*)::int AS cnt
      FROM v_b_clients_m_custom_equipment
      WHERE client_id IS NOT NULL
        AND is_active IS NOT FALSE
      GROUP BY client_id, family_key
    `);

    for (const row of customResult.rows) {
      const clientId = String(row.client_id);
      if (!byClientId[clientId]) {
        byClientId[clientId] = createEmptyEquipmentCounts();
      }
      byClientId[clientId][row.family_key] = Number(row.cnt) || 0;
    }
  } catch (err) {
    if (err.code === "42P01" || err.code === "42703") {
      console.warn("[equipment-counts] custom_equipment skipped:", err.message);
    } else {
      throw err;
    }
  }

  return byClientId;
}

export function attachEquipmentCounts(clients, countsByClientId = {}) {
  return clients.map((client) => ({
    ...client,
    equipmentCounts: {
      ...createEmptyEquipmentCounts(),
      ...(countsByClientId[String(client.id)] || {}),
    },
  }));
}
