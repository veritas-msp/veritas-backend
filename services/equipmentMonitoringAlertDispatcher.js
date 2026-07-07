import { pool } from "../database/db.js";
import { dispatchNotificationEvent } from "./notificationDispatcher.js";
import {
  areMonitoringAlertsEnabled,
  getEquipmentAlertSettings,
  isAlertableMonitorStatus,
  isAlertSuspensionActive,
  touchEquipmentAlertState,
} from "../utils/equipmentMonitoringAlerts.js";
import { isSupervisionAlertAllowed } from "../utils/supervisionAlertRules.js";

const STATUS_LABELS = {
  critical: "Critique",
  warning: "Warning",
  offline: "Hors ligne",
  ok: "OK",
};

const EQUIPMENT_FAMILY_LABELS = {
  servers: "Serveurs",
  ordinateurs: "Ordinateurs",
  internet: "Internet",
  stockage: "Stockage",
  nas: "Stockage",
  firewalls: "Firewalls",
  firewall: "Firewalls",
  switch: "Switch",
  switches: "Switch",
  bornewifi: "Borne WiFi",
  wifi: "Borne WiFi",
};

function resolveEquipmentTypeLabel(family) {
  const raw = String(family || "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase();
  return EQUIPMENT_FAMILY_LABELS[key] || raw;
}

function buildLinkedEquipmentComment({ equipmentId, equipmentName, equipmentFamily, clientId }) {
  const safeName = String(equipmentName || "Matériel").replace(/[\\\]]/g, "");
  const safeType = String(resolveEquipmentTypeLabel(equipmentFamily) || "").replace(/[\\\]]/g, "");
  const safeClientId = String(clientId || "").replace(/[\\\]]/g, "");
  return (
    `[Linked equipment] [event:added] [equipment_id:${equipmentId}] [name:${safeName}] ` +
    `[type:${safeType}] [client_id:${safeClientId}] [warranty:] [licenses:]`
  );
}

function buildAlertDescription({ equipmentName, equipmentFamily, monitorStatus, source, details }) {
  const lines = [
    "Alerte automatique de surveillance Veritas.",
    "",
    `Périphérique : ${equipmentName || "Sans nom"}`,
    `Famille : ${equipmentFamily}`,
    `Statut détecté : ${STATUS_LABELS[monitorStatus] || monitorStatus}`,
    `Source : ${source === "rmm" ? "Agent RMM" : "CheckMK"}`,
  ];

  if (details && typeof details === "object") {
    if (details.critServices > 0) lines.push(`Services critiques : ${details.critServices}`);
    if (details.warnServices > 0) lines.push(`Services warning : ${details.warnServices}`);
    if (details.recentCritAlerts > 0) lines.push(`Alertes critiques récentes : ${details.recentCritAlerts}`);
    if (details.recentWarnAlerts > 0) lines.push(`Alertes warning récentes : ${details.recentWarnAlerts}`);
  }

  lines.push("", "Ce ticket a été créé automatiquement car le périphérique est sorti du lot de surveillance.");
  return lines.join("\n");
}

function resolveTicketPriority(monitorStatus) {
  if (monitorStatus === "critical" || monitorStatus === "offline") return "high";
  if (monitorStatus === "warning") return "normal";
  return "normal";
}

async function hasTicketColumn(columnName) {
  const result = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'v_b_tickets' AND column_name = $1
     LIMIT 1`,
    [columnName]
  );
  return result.rows.length > 0;
}

async function createMonitoringAlertTicket({
  clientId,
  equipmentId,
  equipmentFamily,
  equipmentName,
  monitorStatus,
  source,
  details,
}) {
  const title = `[Surveillance] ${equipmentName || "Périphérique"} — ${STATUS_LABELS[monitorStatus] || monitorStatus}`;
  const description = buildAlertDescription({
    equipmentName,
    equipmentFamily,
    monitorStatus,
    source,
    details,
  });
  const priority = resolveTicketPriority(monitorStatus);
  const equipmentTypeLabel = resolveEquipmentTypeLabel(equipmentFamily);
  const equipmentInfo = {
    concerned: true,
    source: "veritas",
    equipmentId: String(equipmentId),
    name: equipmentName || "",
    type: equipmentTypeLabel,
    clientId: String(clientId),
  };

  const hasEquipmentInfo = await hasTicketColumn("equipment_info");
  const result = hasEquipmentInfo
    ? await pool.query(
        `INSERT INTO v_b_tickets
           (title, description, status, priority, type, category, channel, client_id, equipment_info, created_at, updated_at)
         VALUES ($1, $2, 'open', $3, 'incident', 'infrastructure', 'monitoring', $4, $5::jsonb, NOW(), NOW())
         RETURNING id, ticket_number, title`,
        [title.slice(0, 255), description, priority, clientId, JSON.stringify(equipmentInfo)]
      )
    : await pool.query(
        `INSERT INTO v_b_tickets
           (title, description, status, priority, type, category, channel, client_id, created_at, updated_at)
         VALUES ($1, $2, 'open', $3, 'incident', 'infrastructure', 'monitoring', $4, NOW(), NOW())
         RETURNING id, ticket_number, title`,
        [title.slice(0, 255), description, priority, clientId]
      );

  const ticket = result.rows[0];
  if (ticket?.id) {
    await pool.query(
      `INSERT INTO v_b_ticket_status_history (ticket_id, old_status, new_status, changed_by, note, created_at)
       VALUES ($1, NULL, 'open', NULL, $2, NOW())`,
      [ticket.id, "Création automatique — alerte surveillance"]
    );

    await pool.query(
      `INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
       VALUES ($1, NULL, $2, TRUE, NOW())`,
      [
        ticket.id,
        buildLinkedEquipmentComment({
          equipmentId,
          equipmentName,
          equipmentFamily,
          clientId,
        }),
      ]
    );

    await dispatchNotificationEvent({
      source: "tickets",
      element: "created",
      enterpriseId: String(clientId),
      context: {
        ticket,
        entreprise: { id: String(clientId) },
      },
    }).catch(() => {});
  }

  return ticket;
}

/**
 * Évalue un changement de statut surveillance et crée un ticket support si nécessaire.
 * Ne crée un ticket qu'à la transition vers un état alertable (évite les doublons).
 */
export async function evaluateMonitoringAlert({
  clientId,
  equipmentId,
  equipmentFamily,
  equipmentName,
  monitorStatus,
  source = "checkmk",
  details = null,
}) {
  if (!clientId || !equipmentId || !equipmentFamily) {
    return { skipped: true, reason: "missing_params" };
  }

  const normalizedStatus = String(monitorStatus || "ok").toLowerCase();
  const settings = await getEquipmentAlertSettings(clientId, equipmentId, equipmentFamily);
  const previousStatus = String(settings?.lastKnownStatus || "ok").toLowerCase();

  if (!areMonitoringAlertsEnabled(settings)) {
    await touchEquipmentAlertState({
      clientId,
      equipmentId,
      equipmentFamily,
      equipmentName,
      monitorStatus: normalizedStatus,
    });
    const reason = !settings?.alertsEnabled
      ? "disabled"
      : isAlertSuspensionActive(settings)
        ? "suspended"
        : "disabled";
    return { skipped: true, reason };
  }

  const globalAllowed = await isSupervisionAlertAllowed({
    equipmentFamily,
    monitorStatus: normalizedStatus,
    source,
  });
  if (!globalAllowed) {
    await touchEquipmentAlertState({
      clientId,
      equipmentId,
      equipmentFamily,
      equipmentName,
      monitorStatus: normalizedStatus,
    });
    return { skipped: true, reason: "global_rule_disabled" };
  }

  const becameAlertable =
    isAlertableMonitorStatus(normalizedStatus) && !isAlertableMonitorStatus(previousStatus);

  if (!becameAlertable) {
    await touchEquipmentAlertState({
      clientId,
      equipmentId,
      equipmentFamily,
      equipmentName,
      monitorStatus: normalizedStatus,
    });
    return { skipped: true, reason: "no_transition", previousStatus, monitorStatus: normalizedStatus };
  }

  const ticket = await createMonitoringAlertTicket({
    clientId,
    equipmentId,
    equipmentFamily,
    equipmentName,
    monitorStatus: normalizedStatus,
    source,
    details,
  });

  await touchEquipmentAlertState({
    clientId,
    equipmentId,
    equipmentFamily,
    equipmentName,
    monitorStatus: normalizedStatus,
    ticketId: ticket?.id || null,
    alertAt: new Date().toISOString(),
  });

  return {
    created: true,
    ticketId: ticket?.id || null,
    ticketNumber: ticket?.ticket_number || null,
    monitorStatus: normalizedStatus,
    previousStatus,
  };
}
