import { pool } from "../database/db.js";
import { getMonitoringAutomationConfig } from "../utils/monitoringAutomationConfig.js";

/**
 * Automatically closes monitoring tickets pending validation after a configurable delay.
 */
export async function runMonitoringAutoResolutionScan() {
  const config = await getMonitoringAutomationConfig();
  const autoRes = config?.autoResolution || {};
  if (autoRes.enabled === false || autoRes.requireAgentValidation === false) {
    return { closed: 0 };
  }

  const minutes = Number(autoRes.suggestCloseAfterRecoveryMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { closed: 0 };
  }

  const result = await pool.query(
    `SELECT id, client_id
     FROM v_b_tickets
     WHERE channel = 'monitoring'
       AND status IN ('open', 'new', 'pending', 'in_progress')
       AND monitoring_meta->>'autoResolutionPending' = 'true'
       AND updated_at <= NOW() - ($1::int * INTERVAL '1 minute')`,
    [minutes]
  );

  let closed = 0;
  for (const ticket of result.rows) {
    await pool.query(
      `UPDATE v_b_tickets
       SET status = 'resolved',
           resolved_at = NOW(),
           monitoring_meta = COALESCE(monitoring_meta, '{}'::jsonb) || '{"autoResolutionPending":false}'::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [ticket.id]
    );

    await pool.query(
      `INSERT INTO v_b_ticket_status_history (ticket_id, old_status, new_status, changed_by, note, created_at)
       VALUES ($1, 'open', 'resolved', NULL, $2, NOW())`,
      [ticket.id, "Résolution automatique — critère rétabli"]
    );

    closed += 1;
  }

  return { closed };
}
