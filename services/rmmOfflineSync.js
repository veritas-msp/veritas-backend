import { pool } from "../database/db.js";
import { fetchRmmSettings, isAgentOnline } from "../utils/rmmSettings.js";
import { evaluateMonitoringAlert } from "./equipmentMonitoringAlertDispatcher.js";

/**
 * Met à jour agentOnline dans v_b_clients_m_ordinateurs.data selon last_seen_at des agents.
 */
export async function syncRmmAgentOfflineStatus() {
  const tableCheck = await pool.query(
    `SELECT to_regclass('public.v_b_clients_m_ordinateurs') AS reg`
  );
  if (!tableCheck.rows[0]?.reg) {
    return { updated: 0, skipped: true };
  }

  const result = await pool.query(
    `SELECT o.id, o.client_id, o.name, o.data, a.last_seen_at
     FROM v_b_clients_m_ordinateurs o
     INNER JOIN v_b_rmm_agents a ON a.id = o.agent_id
     WHERE a.status = 'active' AND o.is_active IS DISTINCT FROM false`
  );

  let updated = 0;
  const thresholdCache = new Map();
  for (const row of result.rows) {
    let threshold = thresholdCache.get(row.client_id);
    if (threshold == null) {
      const settings = await fetchRmmSettings(row.client_id);
      threshold = settings.offlineThresholdMinutes;
      thresholdCache.set(row.client_id, threshold);
    }
    const online = isAgentOnline(row.last_seen_at, threshold);
    const currentData = row.data && typeof row.data === "object" ? row.data : {};
    const status = online ? "ok" : "offline";
    const equipmentName = row.name || currentData.nom || currentData.hostname || "Poste";

    if (currentData.agentOnline !== online) {
      await pool.query(
        `UPDATE v_b_clients_m_ordinateurs
         SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{agentOnline}', $1::jsonb, true),
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(online), row.id]
      );
      updated += 1;
    }

    evaluateMonitoringAlert({
      clientId: row.client_id,
      equipmentId: row.id,
      equipmentFamily: "ordinateurs",
      equipmentName,
      monitorStatus: status,
      source: "rmm",
      details: { agentOnline: online, lastSeenAt: row.last_seen_at },
    }).catch((err) => {
      console.error("[rmm] evaluateMonitoringAlert:", err.message);
    });
  }

  return { checked: result.rows.length, updated };
}

async function syncRmmServersOfflineStatus() {
  const tableCheck = await pool.query(
    `SELECT to_regclass('public.v_b_clients_m_servers') AS reg`
  );
  if (!tableCheck.rows[0]?.reg) {
    return { updated: 0, skipped: true };
  }

  const colCheck = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'v_b_clients_m_servers' AND column_name = 'agent_id'
     LIMIT 1`
  );
  if (!colCheck.rows.length) {
    return { updated: 0, skipped: true };
  }

  const result = await pool.query(
    `SELECT s.id, s.client_id, s.name, s.data, a.last_seen_at
     FROM v_b_clients_m_servers s
     INNER JOIN v_b_rmm_agents a ON a.id = s.agent_id
     WHERE a.status = 'active' AND s.is_active IS DISTINCT FROM false`
  );

  let updated = 0;
  const thresholdCache = new Map();
  for (const row of result.rows) {
    let threshold = thresholdCache.get(row.client_id);
    if (threshold == null) {
      const settings = await fetchRmmSettings(row.client_id);
      threshold = settings.offlineThresholdMinutes;
      thresholdCache.set(row.client_id, threshold);
    }
    const online = isAgentOnline(row.last_seen_at, threshold);
    const currentData = row.data && typeof row.data === "object" ? row.data : {};
    const status = online ? "ok" : "offline";
    const equipmentName = row.name || currentData.nom || currentData.hostname || "Serveur";

    if (currentData.agentOnline !== online) {
      await pool.query(
        `UPDATE v_b_clients_m_servers
         SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{agentOnline}', $1::jsonb, true),
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(online), row.id]
      );
      updated += 1;
    }

    evaluateMonitoringAlert({
      clientId: row.client_id,
      equipmentId: row.id,
      equipmentFamily: "servers",
      equipmentName,
      monitorStatus: status,
      source: "rmm",
      details: { agentOnline: online, lastSeenAt: row.last_seen_at },
    }).catch((err) => {
      console.error("[rmm] evaluateMonitoringAlert (serveur):", err.message);
    });
  }

  return { checked: result.rows.length, updated };
}

export async function syncAllRmmAgentOfflineStatus() {
  const [ordinateurs, serveurs] = await Promise.all([
    syncRmmAgentOfflineStatus(),
    syncRmmServersOfflineStatus(),
  ]);
  return {
    ordinateurs,
    serveurs,
    updated: (ordinateurs.updated || 0) + (serveurs.updated || 0),
  };
}
