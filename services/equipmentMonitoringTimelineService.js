import { pool } from "../database/db.js";
import { loadEquipmentActivity } from "./equipmentActivityService.js";
import { listMonitoringEvents } from "./monitoringEventQueue.js";

export async function loadEquipmentMonitoringTimeline({ equipmentId, clientId, days = 90 } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  const activity = await loadEquipmentActivity({
    equipmentId,
    clientId,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  }).catch(() => ({ tickets: [], events: [], stats: {} }));

  const alertHistory = await pool.query(
    `SELECT last_known_status, last_known_criteria, last_ticket_id, last_alert_at, updated_at
     FROM v_b_equipment_monitoring_alerts
     WHERE client_id = $1 AND equipment_id = $2::uuid
     ORDER BY updated_at DESC
     LIMIT 20`,
    [clientId, equipmentId]
  ).catch(() => ({ rows: [] }));

  const monitoringEvents = await listMonitoringEvents({
    clientId,
    limit: 100,
  }).then((events) =>
    events.filter(
      (e) => String(e.equipment_id || "") === String(equipmentId)
    )
  );

  const monitoringTickets = (activity.tickets || []).filter(
    (t) => t.channel === "monitoring" || String(t.category || "") === "infrastructure"
  );

  return {
    range: activity.range,
    tickets: monitoringTickets,
    planningEvents: activity.events || [],
    alertHistory: alertHistory.rows || [],
    monitoringEvents,
    stats: {
      ...(activity.stats || {}),
      monitoringTickets: monitoringTickets.length,
      monitoringEvents: monitoringEvents.length,
    },
  };
}
