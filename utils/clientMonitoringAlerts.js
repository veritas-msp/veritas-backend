import { pool } from "../database/db.js";
import { isAlertSuspensionActive } from "./equipmentMonitoringAlerts.js";

function mapClientPolicyRow(row) {
  if (!row) return null;
  return {
    clientId: row.id,
    clientName: row.name || null,
    suspensionType: row.monitoring_alerts_suspension_type || null,
    suspendedUntil: row.monitoring_alerts_suspended_until || null,
    suspendedAt: row.monitoring_alerts_suspended_at || null,
    suspendedBy: row.monitoring_alerts_suspended_by || null,
    suspensionReason: row.monitoring_alerts_suspension_reason || null,
  };
}

export function isClientMonitoringAlertsSuspended(policy) {
  if (!policy) return false;
  return isAlertSuspensionActive({
    suspensionType: policy.suspensionType,
    suspendedUntil: policy.suspendedUntil,
  });
}

export async function getClientMonitoringAlertPolicy(clientId) {
  const id = Number(clientId);
  if (!id) return null;

  const result = await pool.query(
    `SELECT id, name,
            monitoring_alerts_suspension_type,
            monitoring_alerts_suspended_until,
            monitoring_alerts_suspended_at,
            monitoring_alerts_suspended_by,
            monitoring_alerts_suspension_reason
     FROM v_b_clients
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  const policy = mapClientPolicyRow(result.rows[0]);
  if (!policy) return null;

  // Auto-clear expired temporary suspension
  if (
    policy.suspensionType === "temporary" &&
    policy.suspendedUntil &&
    new Date(policy.suspendedUntil).getTime() <= Date.now()
  ) {
    return clearClientMonitoringAlertSuspension(id);
  }

  return {
    ...policy,
    suspended: isClientMonitoringAlertsSuspended(policy),
  };
}

export async function clearClientMonitoringAlertSuspension(clientId) {
  const id = Number(clientId);
  const result = await pool.query(
    `UPDATE v_b_clients
     SET monitoring_alerts_suspension_type = NULL,
         monitoring_alerts_suspended_until = NULL,
         monitoring_alerts_suspended_at = NULL,
         monitoring_alerts_suspended_by = NULL,
         monitoring_alerts_suspension_reason = NULL
     WHERE id = $1
     RETURNING id, name,
               monitoring_alerts_suspension_type,
               monitoring_alerts_suspended_until,
               monitoring_alerts_suspended_at,
               monitoring_alerts_suspended_by,
               monitoring_alerts_suspension_reason`,
    [id]
  );
  const policy = mapClientPolicyRow(result.rows[0]);
  return policy
    ? { ...policy, suspended: false }
    : null;
}

export async function setClientMonitoringAlertSuspension({
  clientId,
  suspensionType,
  suspendedUntil = null,
  suspendedBy = null,
  suspensionReason = null,
}) {
  const id = Number(clientId);
  const normalized =
    suspensionType === "permanent" || suspensionType === "temporary" ? suspensionType : null;

  if (!normalized) {
    return clearClientMonitoringAlertSuspension(id);
  }

  const result = await pool.query(
    `UPDATE v_b_clients
     SET monitoring_alerts_suspension_type = $2,
         monitoring_alerts_suspended_until = $3,
         monitoring_alerts_suspended_at = NOW(),
         monitoring_alerts_suspended_by = $4,
         monitoring_alerts_suspension_reason = $5
     WHERE id = $1
     RETURNING id, name,
               monitoring_alerts_suspension_type,
               monitoring_alerts_suspended_until,
               monitoring_alerts_suspended_at,
               monitoring_alerts_suspended_by,
               monitoring_alerts_suspension_reason`,
    [
      id,
      normalized,
      normalized === "temporary" ? suspendedUntil : null,
      suspendedBy,
      suspensionReason || null,
    ]
  );

  const policy = mapClientPolicyRow(result.rows[0]);
  return policy
    ? {
        ...policy,
        suspended: isClientMonitoringAlertsSuspended(policy),
      }
    : null;
}
