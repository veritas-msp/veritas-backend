import { pool } from "../database/db.js";
import { getMonitoringAutomationConfig } from "../utils/monitoringAutomationConfig.js";
import { dispatchNotificationEvent } from "./notificationDispatcher.js";

const PRIORITY_RANK = { low: 1, normal: 2, high: 3, urgent: 4 };

function nextPriority(current, bump) {
  const cur = PRIORITY_RANK[String(current || "normal").toLowerCase()] || 2;
  const target = PRIORITY_RANK[String(bump || "urgent").toLowerCase()] || 4;
  if (target <= cur) {
    const entry = Object.entries(PRIORITY_RANK).find(([, v]) => v === Math.min(4, cur + 1));
    return entry?.[0] || "urgent";
  }
  return bump;
}

/**
 * Escalates unassigned monitoring tickets after X minutes.
 */
export async function runMonitoringEscalationScan() {
  const config = await getMonitoringAutomationConfig();
  const escalation = config?.escalation || {};
  if (escalation.enabled === false) return { escalated: 0 };

  const rules = Array.isArray(escalation.rules) ? escalation.rules : [];
  if (!rules.length) return { escalated: 0 };

  let escalated = 0;

  for (const rule of rules) {
    const minutes = Number(rule.unassignedMinutes) || 30;
    const criterionKeys = Array.isArray(rule.criterionKeys) ? rule.criterionKeys : [];
    if (!criterionKeys.length) continue;

    const result = await pool.query(
      `SELECT id, ticket_number, title, priority, client_id, monitoring_meta, created_at
       FROM v_b_tickets
       WHERE channel = 'monitoring'
         AND category = 'infrastructure'
         AND status IN ('open', 'new', 'pending')
         AND assigned_user_id IS NULL
         AND created_at <= NOW() - ($1::int * INTERVAL '1 minute')
         AND monitoring_meta->>'criterionKey' = ANY($2::text[])
         AND COALESCE(monitoring_meta->>'escalated', 'false') <> 'true'`,
      [minutes, criterionKeys]
    );

    for (const ticket of result.rows) {
      const newPriority = nextPriority(ticket.priority, rule.bumpPriority);
      await pool.query(
        `UPDATE v_b_tickets
         SET priority = $1,
             monitoring_meta = COALESCE(monitoring_meta, '{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
         WHERE id = $3::uuid`,
        [
          newPriority,
          JSON.stringify({ escalated: true, escalatedAt: new Date().toISOString(), escalationRuleId: rule.id }),
          ticket.id,
        ]
      );

      await pool.query(
        `INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
         VALUES ($1, NULL, $2, TRUE, NOW())`,
        [
          ticket.id,
          `⚠️ Escalade automatique : ticket non assigné depuis plus de ${minutes} minutes. Priorité relevée.`,
        ]
      );

      await dispatchNotificationEvent({
        source: "tickets",
        element: "updated",
        enterpriseId: String(ticket.client_id),
        context: { ticket },
      }).catch(() => {});

      escalated += 1;
    }
  }

  return { escalated };
}
