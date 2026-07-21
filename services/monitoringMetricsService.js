import { pool } from "../database/db.js";
const ALERT_STAT_WINDOWS = [{
  key: "24h",
  days: 1
}, {
  key: "7d",
  days: 7
}, {
  key: "30d",
  days: 30
}];
export async function computeMonitoringMetrics({
  days = 30,
  clientId = null
} = {}) {
  const windowDays = Math.min(365, Math.max(1, Number(days) || 30));
  const values = [windowDays];
  let clientFilter = "";
  if (clientId != null) {
    values.push(Number(clientId));
    clientFilter = ` AND t.client_id = $2`;
  }
  const ticketsResult = await pool.query(`SELECT
        t.id,
        t.status,
        t.priority,
        t.created_at,
        t.resolved_at,
        t.assigned_user_id,
        t.monitoring_meta->>'criterionKey' AS criterion_key,
        t.monitoring_meta->>'equipmentFamily' AS equipment_family
     FROM v_b_tickets t
     WHERE t.channel = 'monitoring'
       AND t.category = 'infrastructure'
       AND t.created_at >= NOW() - ($1::int * INTERVAL '1 day')
       ${clientFilter}`, values);
  const tickets = ticketsResult.rows || [];
  const byCriterion = {};
  const byFamily = {};
  const byPriority = {
    low: 0,
    normal: 0,
    high: 0,
    urgent: 0
  };
  let openCount = 0;
  let assignedCount = 0;
  let resolutionTotalMs = 0;
  let resolutionCount = 0;
  let escalatedCount = 0;
  for (const ticket of tickets) {
    const key = ticket.criterion_key || "unknown";
    if (!byCriterion[key]) {
      byCriterion[key] = {
        total: 0,
        open: 0,
        resolved: 0,
        mttrHoursSum: 0,
        mttrCount: 0
      };
    }
    byCriterion[key].total += 1;
    const family = ticket.equipment_family || "unknown";
    if (!byFamily[family]) {
      byFamily[family] = {
        total: 0,
        open: 0,
        resolved: 0
      };
    }
    byFamily[family].total += 1;
    const status = String(ticket.status || "").toLowerCase();
    if (!["resolved", "closed"].includes(status)) {
      openCount += 1;
      byCriterion[key].open += 1;
      byFamily[family].open += 1;
    } else {
      byCriterion[key].resolved += 1;
      byFamily[family].resolved += 1;
    }
    const priority = String(ticket.priority || "normal").toLowerCase();
    if (byPriority[priority] != null) byPriority[priority] += 1;else byPriority.normal += 1;
    if (ticket.assigned_user_id) assignedCount += 1;
    if (ticket.resolved_at && ticket.created_at) {
      const createdMs = new Date(ticket.created_at).getTime();
      const resolvedMs = new Date(ticket.resolved_at).getTime();
      if (!Number.isNaN(createdMs) && !Number.isNaN(resolvedMs) && resolvedMs >= createdMs) {
        const delta = resolvedMs - createdMs;
        resolutionTotalMs += delta;
        resolutionCount += 1;
        byCriterion[key].mttrHoursSum += delta;
        byCriterion[key].mttrCount += 1;
      }
    }
  }
  const eventsResult = await pool.query(`SELECT event_type, COUNT(*)::int AS count
     FROM v_b_monitoring_events
     WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
     ${clientId != null ? " AND client_id = $2" : ""}
     GROUP BY event_type`, values);
  const eventsByType = Object.fromEntries((eventsResult.rows || []).map(r => [r.event_type, r.count]));
  const eventsTotal = Object.values(eventsByType).reduce((sum, n) => sum + Number(n || 0), 0);
  const escalatedResult = await pool.query(`SELECT COUNT(*)::int AS count
     FROM v_b_tickets
     WHERE channel = 'monitoring'
       AND monitoring_meta->>'escalated' = 'true'
       AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
       ${clientFilter}`, values);
  escalatedCount = escalatedResult.rows[0]?.count || 0;
  const mttrByCriterion = {};
  for (const [key, stats] of Object.entries(byCriterion)) {
    mttrByCriterion[key] = stats.mttrCount > 0 ? Math.round(stats.mttrHoursSum / stats.mttrCount / (1000 * 60 * 60) * 10) / 10 : null;
  }
  const totalTickets = tickets.length;
  const correctiveRatio = totalTickets > 0 ? Math.round(assignedCount / totalTickets * 1000) / 10 : null;
  return {
    windowDays,
    clientId: clientId ?? null,
    tickets: {
      total: totalTickets,
      open: openCount,
      resolved: totalTickets - openCount,
      assigned: assignedCount,
      escalated: escalatedCount,
      byPriority,
      byCriterion,
      byFamily,
      mttrHours: resolutionCount > 0 ? Math.round(resolutionTotalMs / resolutionCount / (1000 * 60 * 60) * 10) / 10 : null,
      mttrByCriterion,
      correctiveAssignmentRatePct: correctiveRatio
    },
    events: eventsByType,
    eventsTotal
  };
}
export async function computeMonitoringAlertStats({
  clientId = null
} = {}) {
  const windows = {};
  for (const window of ALERT_STAT_WINDOWS) {
    windows[window.key] = await computeMonitoringMetrics({
      days: window.days,
      clientId
    });
  }
  return {
    clientId: clientId ?? null,
    windows,
    periods: ALERT_STAT_WINDOWS.map(w => w.key)
  };
}
