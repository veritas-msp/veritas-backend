import { pool } from "../database/db.js";
import { getCriterionLabel } from "./monitoringTicketAssignment.js";
export async function findOrCreateIncidentGroup({
  clientId,
  criterionKey,
  config,
  parentTicketId = null
}) {
  const correlation = config?.correlation || {};
  if (correlation.enabled === false) return null;
  const windowMinutes = Number(correlation.windowMinutes) || 30;
  const allowedKeys = correlation.criterionKeys;
  if (Array.isArray(allowedKeys) && allowedKeys.length && !allowedKeys.includes(criterionKey)) {
    return null;
  }
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const existing = await pool.query(`SELECT id, parent_ticket_id, equipment_count
     FROM v_b_monitoring_incident_groups
     WHERE client_id = $1
       AND criterion_key = $2
       AND status = 'open'
       AND updated_at >= $3::timestamptz
     ORDER BY updated_at DESC
     LIMIT 1`, [clientId, criterionKey, since]);
  if (existing.rows[0]?.id) {
    const groupId = existing.rows[0].id;
    await pool.query(`UPDATE v_b_monitoring_incident_groups
       SET equipment_count = equipment_count + 1, updated_at = NOW()
       WHERE id = $1`, [groupId]);
    return {
      id: groupId,
      parentTicketId: existing.rows[0].parent_ticket_id,
      isNew: false
    };
  }
  const title = `[Correlation] ${getCriterionLabel(criterionKey)} — client #${clientId}`;
  const inserted = await pool.query(`INSERT INTO v_b_monitoring_incident_groups
       (client_id, title, criterion_key, parent_ticket_id, equipment_count, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4::uuid, 1, 'open', NOW(), NOW())
     RETURNING id`, [clientId, title.slice(0, 255), criterionKey, parentTicketId]);
  return {
    id: inserted.rows[0]?.id || null,
    parentTicketId,
    isNew: true
  };
}
export async function linkTicketToIncidentGroup(ticketId, incidentGroupId) {
  if (!ticketId || !incidentGroupId) return;
  await pool.query(`UPDATE v_b_tickets
     SET monitoring_meta = COALESCE(monitoring_meta, '{}'::jsonb) || $1::jsonb,
         updated_at = NOW()
     WHERE id = $2::uuid`, [JSON.stringify({
    incidentGroupId: String(incidentGroupId)
  }), ticketId]);
}
