import { pool } from "../database/db.js";
import { fetchRmmSettings, isAgentOnline } from "../utils/rmmSettings.js";
import { computeMonitoringSummary } from "../routes/integrations/checkmk/equipmentMonitoringSync.js";
import { evaluateMonitoringAlert } from "./equipmentMonitoringAlertDispatcher.js";

/**
 * Parcourt les équipements supervisés (CheckMK + RMM) et déclenche les alertes tickets.
 */
export async function runEquipmentMonitoringAlertScan() {
  let evaluated = 0;
  let created = 0;

  const checkmkRows = await pool.query(
    `SELECT equipment_id, client_id, equipment_family, checkmk_host_name, monitoring_data, last_synced_at
     FROM v_b_equipment_checkmk_monitoring`
  );

  for (const row of checkmkRows.rows) {
    const summary = computeMonitoringSummary(row.monitoring_data, row.last_synced_at);
    evaluated += 1;
    const result = await evaluateMonitoringAlert({
      clientId: row.client_id,
      equipmentId: row.equipment_id,
      equipmentFamily: row.equipment_family,
      equipmentName: row.checkmk_host_name,
      monitorStatus: summary.status,
      source: "checkmk",
      details: summary,
    });
    if (result?.created) created += 1;
  }

  const rmmTable = await pool.query(
    `SELECT to_regclass('public.v_b_clients_m_ordinateurs') AS reg`
  );
  if (!rmmTable.rows[0]?.reg) {
    return { evaluated, created, skippedRmm: true };
  }

  const rmmRows = await pool.query(
    `SELECT o.id AS ordinateur_id,
            o.client_id,
            o.name,
            o.data,
            a.last_seen_at
     FROM v_b_clients_m_ordinateurs o
     INNER JOIN v_b_rmm_agents a ON a.id = o.agent_id
     WHERE o.is_active IS DISTINCT FROM false AND a.status = 'active'`
  );

  const thresholdCache = new Map();
  for (const row of rmmRows.rows) {
    const data = row.data && typeof row.data === "object" ? row.data : {};
    let threshold = thresholdCache.get(row.client_id);
    if (threshold == null) {
      const settings = await fetchRmmSettings(row.client_id);
      threshold = settings.offlineThresholdMinutes;
      thresholdCache.set(row.client_id, threshold);
    }
    const online = isAgentOnline(row.last_seen_at, threshold);
    const status = online ? "ok" : "offline";
    const equipmentName = row.name || data.nom || data.hostname || "Poste";
    evaluated += 1;
    const result = await evaluateMonitoringAlert({
      clientId: row.client_id,
      equipmentId: row.ordinateur_id,
      equipmentFamily: "ordinateurs",
      equipmentName,
      monitorStatus: status,
      source: "rmm",
      details: { agentOnline: online, lastSeenAt: row.last_seen_at },
    });
    if (result?.created) created += 1;
  }

  return { evaluated, created };
}
