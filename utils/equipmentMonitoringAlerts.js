import { pool } from "../database/db.js";

const ALERTABLE_STATUSES = new Set(["critical", "warning", "offline"]);

export function resolveEquipmentFamilyKey(type) {
  if (!type) return null;
  const raw = String(type).trim();
  if (raw.startsWith("Custom:")) {
    return `custom:${raw.slice("Custom:".length)}`;
  }
  const map = {
    Ordinateurs: "ordinateurs",
    Serveurs: "servers",
    NAS: "stockage",
    Stockage: "stockage",
    Firewalls: "firewall",
    Switch: "switch",
    BorneWifi: "wifi",
    Alimentation: "alimentation",
    Routeur: "routeur",
    TOIP: "toip",
    Internet: "internet",
  };
  return map[raw] || raw.toLowerCase();
}

export function isAlertableMonitorStatus(status) {
  return ALERTABLE_STATUSES.has(String(status || "").toLowerCase());
}

/** Alerts are active only when explicitly enabled and not suspended. */
export function areMonitoringAlertsEnabled(settings) {
  if (!settings?.alertsEnabled) return false;
  if (isAlertSuspensionActive(settings)) return false;
  return true;
}

function mapAlertRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    equipmentId: row.equipment_id,
    equipmentFamily: row.equipment_family,
    equipmentName: row.equipment_name,
    suspensionType: row.suspension_type,
    suspendedUntil: row.suspended_until,
    suspendedAt: row.suspended_at,
    suspendedBy: row.suspended_by,
    suspensionReason: row.suspension_reason,
    alertsEnabled: Boolean(row.alerts_enabled),
    lastKnownStatus: row.last_known_status,
    lastKnownCriteria:
      row.last_known_criteria && typeof row.last_known_criteria === "object"
        ? row.last_known_criteria
        : {},
    lastTicketId: row.last_ticket_id,
    lastAlertAt: row.last_alert_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isAlertSuspensionActive(settings) {
  if (!settings?.suspensionType) return false;
  if (settings.suspensionType === "permanent") return true;
  if (settings.suspensionType === "temporary") {
    if (!settings.suspendedUntil) return true;
    const until = new Date(settings.suspendedUntil).getTime();
    if (!Number.isFinite(until)) return true;
    return until > Date.now();
  }
  return false;
}

export async function getEquipmentAlertSettings(clientId, equipmentId, equipmentFamily) {
  const result = await pool.query(
    `SELECT * FROM v_b_equipment_monitoring_alerts
     WHERE client_id = $1 AND equipment_id = $2::uuid AND equipment_family = $3
     LIMIT 1`,
    [clientId, equipmentId, equipmentFamily]
  );
  const row = mapAlertRow(result.rows[0]);
  if (!row) return null;
  if (row.suspensionType === "temporary" && row.suspendedUntil) {
    const until = new Date(row.suspendedUntil).getTime();
    if (Number.isFinite(until) && until <= Date.now()) {
      await clearEquipmentAlertSuspension(clientId, equipmentId, equipmentFamily);
      return { ...row, suspensionType: null, suspendedUntil: null, suspendedAt: null };
    }
  }
  return row;
}

export async function setEquipmentAlertsEnabled({
  clientId,
  equipmentId,
  equipmentFamily,
  equipmentName,
  alertsEnabled,
}) {
  const result = await pool.query(
    `INSERT INTO v_b_equipment_monitoring_alerts
       (client_id, equipment_id, equipment_family, equipment_name, alerts_enabled, updated_at)
     VALUES ($1, $2::uuid, $3, $4, $5, NOW())
     ON CONFLICT (client_id, equipment_id, equipment_family) DO UPDATE SET
       equipment_name = COALESCE(EXCLUDED.equipment_name, v_b_equipment_monitoring_alerts.equipment_name),
       alerts_enabled = EXCLUDED.alerts_enabled,
       updated_at = NOW()
     RETURNING *`,
    [clientId, equipmentId, equipmentFamily, equipmentName || null, Boolean(alertsEnabled)]
  );
  return mapAlertRow(result.rows[0]);
}

export async function upsertEquipmentAlertSuspension({
  clientId,
  equipmentId,
  equipmentFamily,
  equipmentName,
  suspensionType,
  suspendedUntil = null,
  suspendedBy = null,
  suspensionReason = null,
}) {
  const normalizedType =
    suspensionType === "permanent" || suspensionType === "temporary" ? suspensionType : null;

  const result = await pool.query(
    `INSERT INTO v_b_equipment_monitoring_alerts
       (client_id, equipment_id, equipment_family, equipment_name, alerts_enabled,
        suspension_type, suspended_until, suspended_at, suspended_by, suspension_reason, updated_at)
     VALUES ($1, $2::uuid, $3, $4, true, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (client_id, equipment_id, equipment_family) DO UPDATE SET
       equipment_name = COALESCE(EXCLUDED.equipment_name, v_b_equipment_monitoring_alerts.equipment_name),
       alerts_enabled = true,
       suspension_type = EXCLUDED.suspension_type,
       suspended_until = EXCLUDED.suspended_until,
       suspended_at = EXCLUDED.suspended_at,
       suspended_by = EXCLUDED.suspended_by,
       suspension_reason = EXCLUDED.suspension_reason,
       updated_at = NOW()
     RETURNING *`,
    [
      clientId,
      equipmentId,
      equipmentFamily,
      equipmentName || null,
      normalizedType,
      normalizedType === "temporary" ? suspendedUntil : null,
      normalizedType ? new Date().toISOString() : null,
      suspendedBy,
      suspensionReason || null,
    ]
  );
  return mapAlertRow(result.rows[0]);
}

export async function clearEquipmentAlertSuspension(clientId, equipmentId, equipmentFamily) {
  const result = await pool.query(
    `UPDATE v_b_equipment_monitoring_alerts
     SET suspension_type = NULL,
         suspended_until = NULL,
         suspended_at = NULL,
         suspended_by = NULL,
         suspension_reason = NULL,
         updated_at = NOW()
     WHERE client_id = $1 AND equipment_id = $2::uuid AND equipment_family = $3
     RETURNING *`,
    [clientId, equipmentId, equipmentFamily]
  );
  return mapAlertRow(result.rows[0]);
}

export async function touchEquipmentAlertState({
  clientId,
  equipmentId,
  equipmentFamily,
  equipmentName,
  monitorStatus,
  lastKnownCriteria = null,
  ticketId = null,
  alertAt = null,
}) {
  const criteriaJson =
    lastKnownCriteria && typeof lastKnownCriteria === "object"
      ? JSON.stringify(lastKnownCriteria)
      : null;

  const result = criteriaJson
    ? await pool.query(
        `INSERT INTO v_b_equipment_monitoring_alerts
           (client_id, equipment_id, equipment_family, equipment_name, last_known_status,
            last_known_criteria, last_ticket_id, last_alert_at, updated_at)
         VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::uuid, $8, NOW())
         ON CONFLICT (client_id, equipment_id, equipment_family) DO UPDATE SET
           equipment_name = COALESCE(EXCLUDED.equipment_name, v_b_equipment_monitoring_alerts.equipment_name),
           last_known_status = EXCLUDED.last_known_status,
           last_known_criteria = EXCLUDED.last_known_criteria,
           last_ticket_id = COALESCE(EXCLUDED.last_ticket_id, v_b_equipment_monitoring_alerts.last_ticket_id),
           last_alert_at = COALESCE(EXCLUDED.last_alert_at, v_b_equipment_monitoring_alerts.last_alert_at),
           updated_at = NOW()
         RETURNING *`,
        [
          clientId,
          equipmentId,
          equipmentFamily,
          equipmentName || null,
          monitorStatus || "ok",
          criteriaJson,
          ticketId,
          alertAt,
        ]
      )
    : await pool.query(
        `INSERT INTO v_b_equipment_monitoring_alerts
           (client_id, equipment_id, equipment_family, equipment_name, last_known_status, last_ticket_id, last_alert_at, updated_at)
         VALUES ($1, $2::uuid, $3, $4, $5, $6::uuid, $7, NOW())
         ON CONFLICT (client_id, equipment_id, equipment_family) DO UPDATE SET
           equipment_name = COALESCE(EXCLUDED.equipment_name, v_b_equipment_monitoring_alerts.equipment_name),
           last_known_status = EXCLUDED.last_known_status,
           last_ticket_id = COALESCE(EXCLUDED.last_ticket_id, v_b_equipment_monitoring_alerts.last_ticket_id),
           last_alert_at = COALESCE(EXCLUDED.last_alert_at, v_b_equipment_monitoring_alerts.last_alert_at),
           updated_at = NOW()
         RETURNING *`,
        [
          clientId,
          equipmentId,
          equipmentFamily,
          equipmentName || null,
          monitorStatus || "ok",
          ticketId,
          alertAt,
        ]
      );
  return mapAlertRow(result.rows[0]);
}
