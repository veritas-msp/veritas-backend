import { pool } from "../database/db.js";
import { computeMonitoringSummary } from "../routes/integrations/checkmk/equipmentMonitoringSync.js";
import { isEquipmentMonitoredInventoryItem } from "./equipmentSupervisionEvaluator.js";
export const SUPERVISION_SCAN_FAMILIES = [{
  family: "servers",
  table: "v_b_clients_m_servers",
  hasAgent: true
}, {
  family: "stockage",
  table: "v_b_clients_m_stockage",
  hasAgent: false
}, {
  family: "firewall",
  table: "v_b_clients_m_firewall",
  hasAgent: false
}, {
  family: "switch",
  table: "v_b_clients_m_switch",
  hasAgent: false
}, {
  family: "wifi",
  table: "v_b_clients_m_wifi",
  hasAgent: false
}, {
  family: "routeur",
  table: "v_b_clients_m_routeur",
  hasAgent: false
}, {
  family: "internet",
  table: "v_b_clients_m_internet",
  hasAgent: false
}, {
  family: "toip",
  table: "v_b_clients_m_toip",
  hasAgent: false
}, {
  family: "alimentation",
  table: "v_b_clients_m_alimentation",
  hasAgent: false
}, {
  family: "ordinateurs",
  table: "v_b_clients_m_ordinateurs",
  hasAgent: true
}];
async function tableExists(tableName) {
  const result = await pool.query(`SELECT to_regclass($1) AS reg`, [`public.${tableName}`]);
  return Boolean(result.rows[0]?.reg);
}
async function columnExists(tableName, columnName) {
  const result = await pool.query(`SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`, [tableName, columnName]);
  return result.rows.length > 0;
}
async function loadCheckmkMonitoringMap() {
  const result = await pool.query(`SELECT equipment_id::text, client_id, equipment_family, monitoring_data, last_synced_at
     FROM v_b_equipment_checkmk_monitoring`);
  const map = new Map();
  for (const row of result.rows) {
    map.set(`${row.client_id}:${row.equipment_id}:${row.equipment_family}`, row);
  }
  return map;
}
async function loadAgentLastSeenMap() {
  const result = await pool.query(`SELECT id::text AS agent_id, last_seen_at FROM v_b_rmm_agents WHERE status = 'active'`);
  return new Map(result.rows.map(r => [r.agent_id, r.last_seen_at]));
}
export async function loadSupervisionEquipmentInventory({
  clientId = null
} = {}) {
  const [checkmkMap, agentMap] = await Promise.all([loadCheckmkMonitoringMap(), loadAgentLastSeenMap()]);
  const items = [];
  for (const spec of SUPERVISION_SCAN_FAMILIES) {
    if (!(await tableExists(spec.table))) continue;
    const hasAgentCol = spec.hasAgent && (await columnExists(spec.table, "agent_id"));
    const hasIpCol = await columnExists(spec.table, "ip");
    const agentSelect = hasAgentCol ? ", agent_id" : ", NULL::uuid AS agent_id";
    const ipSelect = hasIpCol ? ", ip" : ", NULL::text AS ip";
    const values = [];
    let where = "is_active IS DISTINCT FROM false";
    if (clientId != null) {
      values.push(Number(clientId));
      where += ` AND client_id = $${values.length}`;
    }
    const result = await pool.query(`SELECT id, client_id, name, data${agentSelect}${ipSelect}
       FROM ${spec.table}
       WHERE ${where}`, values);
    for (const row of result.rows) {
      const data = row.data && typeof row.data === "object" ? row.data : {};
      const equipmentId = String(row.id);
      const mkKey = `${row.client_id}:${equipmentId}:${spec.family}`;
      const mkRow = checkmkMap.get(mkKey);
      const checkmkSummary = mkRow ? computeMonitoringSummary(mkRow.monitoring_data, mkRow.last_synced_at) : null;
      const isMkMapped = Boolean(mkRow || data.checkmk_host_name || data.checkmkHostName);
      const agentId = row.agent_id ? String(row.agent_id) : null;
      const lastSeenAt = agentId ? agentMap.get(agentId) || null : null;
      items.push({
        clientId: row.client_id,
        equipmentId,
        equipmentFamily: spec.family,
        equipmentName: row.name || data.nom || data.hostname || "Device",
        data,
        ip: row.ip || null,
        agentId,
        lastSeenAt,
        checkmkSummary,
        isMkMapped,
        isMonitored: isEquipmentMonitoredInventoryItem({
          agentId,
          data,
          isMkMapped
        }),
        source: spec.family === "ordinateurs" || agentId ? "rmm" : "checkmk"
      });
    }
  }
  return items;
}
export async function enableMonitoringAlertsForClient(clientId, {
  equipmentFamilies = null
} = {}) {
  const inventory = await loadSupervisionEquipmentInventory({
    clientId
  });
  let enabled = 0;
  let skipped = 0;
  for (const item of inventory) {
    if (equipmentFamilies?.length && !equipmentFamilies.includes(item.equipmentFamily)) continue;
    if (!item.isMonitored) {
      skipped += 1;
      continue;
    }
    await pool.query(`INSERT INTO v_b_equipment_monitoring_alerts
         (client_id, equipment_id, equipment_family, equipment_name, alerts_enabled, updated_at)
       VALUES ($1, $2::uuid, $3, $4, true, NOW())
       ON CONFLICT (client_id, equipment_id, equipment_family) DO UPDATE SET
         equipment_name = COALESCE(EXCLUDED.equipment_name, v_b_equipment_monitoring_alerts.equipment_name),
         alerts_enabled = true,
         updated_at = NOW()`, [clientId, item.equipmentId, item.equipmentFamily, item.equipmentName]);
    enabled += 1;
  }
  return {
    enabled,
    skipped,
    total: inventory.length
  };
}
export async function enableMonitoringAlertsForEquipment({
  clientId,
  equipmentId,
  equipmentFamily,
  equipmentName
}) {
  await pool.query(`INSERT INTO v_b_equipment_monitoring_alerts
       (client_id, equipment_id, equipment_family, equipment_name, alerts_enabled, updated_at)
     VALUES ($1, $2::uuid, $3, $4, true, NOW())
     ON CONFLICT (client_id, equipment_id, equipment_family) DO UPDATE SET
       equipment_name = COALESCE(EXCLUDED.equipment_name, v_b_equipment_monitoring_alerts.equipment_name),
       alerts_enabled = true,
       updated_at = NOW()`, [clientId, equipmentId, equipmentFamily, equipmentName || null]);
}
export async function isEquipmentMonitoredInDb(clientId, equipmentId, equipmentFamily) {
  const family = String(equipmentFamily || "").toLowerCase();
  const spec = SUPERVISION_SCAN_FAMILIES.find(s => s.family === family);
  if (!spec) return false;
  if (!(await tableExists(spec.table))) return false;
  const hasAgentCol = spec.hasAgent && (await columnExists(spec.table, "agent_id"));
  const agentSelect = hasAgentCol ? ", agent_id" : ", NULL::uuid AS agent_id";
  const result = await pool.query(`SELECT data${agentSelect}
     FROM ${spec.table}
     WHERE id = $1::uuid AND client_id = $2
     LIMIT 1`, [equipmentId, clientId]);
  const row = result.rows[0];
  if (!row) return false;
  const data = row.data && typeof row.data === "object" ? row.data : {};
  const agentId = row.agent_id ? String(row.agent_id) : null;
  const mkResult = await pool.query(`SELECT 1 FROM v_b_equipment_checkmk_monitoring
     WHERE client_id = $1 AND equipment_id = $2::uuid AND equipment_family = $3
     LIMIT 1`, [clientId, equipmentId, family]);
  const isMkMapped = Boolean(mkResult.rows.length || data.checkmk_host_name || data.checkmkHostName);
  return isEquipmentMonitoredInventoryItem({
    agentId,
    data,
    isMkMapped
  });
}
