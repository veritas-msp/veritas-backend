import { pool } from "../database/db.js";
import { SUPERVISION_ALERT_CRITERIA } from "../utils/supervisionAlertRules.js";
import { resolveMonitoringAssignees } from "../utils/monitoringAutomationConfig.js";

const criteriaLabels = new Map(SUPERVISION_ALERT_CRITERIA.map((c) => [c.key, c.label]));

export async function applyMonitoringTicketAssignment({ ticketId, clientId, criterionKey, config }) {
  if (!ticketId) return { assigned: false };

  const { assigneeUserIds, teamIds } = resolveMonitoringAssignees({ config, clientId, criterionKey });
  const userIds = [...new Set((assigneeUserIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!userIds.length) return { assigned: false };

  const primaryId = userIds[0];
  await pool.query(
    `UPDATE v_b_tickets SET assigned_user_id = $1::uuid, updated_at = NOW() WHERE id = $2::uuid`,
    [primaryId, ticketId]
  );

  for (const userId of userIds) {
    await pool.query(
      `INSERT INTO v_b_ticket_assignees (ticket_id, user_id, created_at)
       VALUES ($1::uuid, $2::uuid, NOW())
       ON CONFLICT (ticket_id, user_id) DO NOTHING`,
      [ticketId, userId]
    ).catch(() => {});
  }

  return { assigned: true, assigneeUserIds: userIds, teamIds: teamIds || [] };
}

export function getCriterionLabel(criterionKey) {
  return criteriaLabels.get(criterionKey) || criterionKey;
}
