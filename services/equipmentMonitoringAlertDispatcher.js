import { pool } from "../database/db.js";
import { dispatchNotificationEvent } from "./notificationDispatcher.js";
import { areMonitoringAlertsEnabled, getEquipmentAlertSettings, touchEquipmentAlertState } from "../utils/equipmentMonitoringAlerts.js";
import { getClientMonitoringAlertPolicy, isClientMonitoringAlertsSuspended } from "../utils/clientMonitoringAlerts.js";
import { getSupervisionAlertRules, getSupervisionCriterionSeverity, isSupervisionAlertAllowed, SUPERVISION_ALERT_CRITERIA } from "../utils/supervisionAlertRules.js";
import { getMonitoringAutomationConfig } from "../utils/monitoringAutomationConfig.js";
import { applyMonitoringTicketAssignment, getCriterionLabel } from "./monitoringTicketAssignment.js";
import { buildRunbookComment, resolveRunbookForCriterion, resolveRunbookTicketPriority, resolveRunbookTags } from "./monitoringRunbooks.js";
import { enrichAlertRunbook } from "./llmClient.js";
import { findOrCreateIncidentGroup, linkTicketToIncidentGroup } from "./monitoringIncidentCorrelation.js";
import { recordMonitoringEvent } from "./monitoringEventQueue.js";
import { criteriaToActiveMap, diffCriteriaTransitions, evaluateEquipmentSupervisionCriteria } from "../utils/equipmentSupervisionEvaluator.js";
import { getSettingsMap } from "../utils/settingsHelper.js";
import { ALLOWED_LOCALES, GENERAL_SETTING_KEYS } from "../utils/generalSettings.js";
const CRITERION_LABELS = new Map(SUPERVISION_ALERT_CRITERIA.map(c => [c.key, c.label]));
const EQUIPMENT_FAMILY_LABELS = {
  servers: "Servers",
  ordinateurs: "Computers",
  internet: "Internet",
  stockage: "Storage",
  firewall: "Firewalls",
  switch: "Switch",
  wifi: "Wi-Fi access point",
  routeur: "Router",
  toip: "TOIP",
  alimentation: "Power supply"
};
function resolveEquipmentTypeLabel(family) {
  const key = String(family || "").trim().toLowerCase();
  return EQUIPMENT_FAMILY_LABELS[key] || family || "";
}
function buildLinkedEquipmentComment({
  equipmentId,
  equipmentName,
  equipmentFamily,
  clientId
}) {
  const safeName = String(equipmentName || "Equipment").replace(/[\\\]]/g, "");
  const safeType = String(resolveEquipmentTypeLabel(equipmentFamily) || "").replace(/[\\\]]/g, "");
  const safeClientId = String(clientId || "").replace(/[\\\]]/g, "");
  return `[Linked equipment] [event:added] [equipment_id:${equipmentId}] [name:${safeName}] ` + `[type:${safeType}] [client_id:${safeClientId}] [warranty:] [licenses:]`;
}
function buildCriterionDescription({
  equipmentName,
  equipmentFamily,
  criterionKey,
  source,
  detail
}) {
  const label = getCriterionLabel(criterionKey) || CRITERION_LABELS.get(criterionKey) || criterionKey;
  const lines = ["Automatic Veritas monitoring alert.", "", `Criterion: ${label}`, `Equipment: ${equipmentName || "Unnamed"}`, `Family: ${equipmentFamily}`, `Source: ${source === "rmm" ? "RMM agent" : source === "external" ? "External event" : "Monitoring"}`];
  if (detail && typeof detail === "object") {
    if (detail.pendingCount) lines.push(`Pending updates: ${detail.pendingCount}`);
    if (detail.pct != null) lines.push(`Disk usage: ${detail.pct}%`);
    if (detail.drive) lines.push(`Drive: ${detail.drive}`);
    if (detail.critServices > 0) lines.push(`Critical services: ${detail.critServices}`);
    if (detail.warnServices > 0) lines.push(`Warning services: ${detail.warnServices}`);
  }
  lines.push("", "This ticket was created automatically following a monitoring criterion.");
  return lines.join("\n");
}
function resolveCriterionPriority(criterionKey, runbook, ruleSeverity = null) {
  if (ruleSeverity && ["low", "normal", "high", "urgent"].includes(ruleSeverity)) {
    return ruleSeverity;
  }
  const fromRunbook = resolveRunbookTicketPriority(runbook, null);
  if (fromRunbook) return fromRunbook;
  if (["monitor_critical", "agent_offline", "disk_critical", "maintenance_expired", "battery_expired"].includes(criterionKey)) {
    return "high";
  }
  if (["monitor_warning", "disk_warn", "updates_pending"].includes(criterionKey)) {
    return "normal";
  }
  return "normal";
}
async function hasTicketColumn(columnName) {
  const result = await pool.query(`SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'v_b_tickets' AND column_name = $1 LIMIT 1`, [columnName]);
  return result.rows.length > 0;
}
async function createCriterionAlertTicket({
  clientId,
  equipmentId,
  equipmentFamily,
  equipmentName,
  criterionKey,
  source,
  detail,
  runbook,
  incidentGroupId = null,
  ruleSeverity = null
}) {
  const label = getCriterionLabel(criterionKey) || criterionKey;
  const title = `[Monitoring] ${equipmentName || "Equipment"} — ${label}`;
  const description = buildCriterionDescription({
    equipmentName,
    equipmentFamily,
    criterionKey,
    source,
    detail
  });
  const priority = resolveCriterionPriority(criterionKey, runbook, ruleSeverity);
  const equipmentTypeLabel = resolveEquipmentTypeLabel(equipmentFamily);
  const equipmentInfo = {
    concerned: true,
    source: "veritas",
    equipmentId: String(equipmentId),
    name: equipmentName || "",
    type: equipmentTypeLabel,
    clientId: String(clientId)
  };
  const monitoringMeta = {
    criterionKey,
    source,
    equipmentId: String(equipmentId),
    equipmentFamily: String(equipmentFamily || ""),
    incidentGroupId: incidentGroupId ? String(incidentGroupId) : null,
    autoResolutionPending: false
  };
  const hasEquipmentInfo = await hasTicketColumn("equipment_info");
  const hasMonitoringMeta = await hasTicketColumn("monitoring_meta");
  const cols = ["title", "description", "status", "priority", "type", "category", "channel", "client_id"];
  const vals = [title.slice(0, 255), description, "open", priority, "incident", "infrastructure", "monitoring", clientId];
  let paramIndex = vals.length + 1;
  if (hasEquipmentInfo) {
    cols.push("equipment_info");
    vals.push(JSON.stringify(equipmentInfo));
    paramIndex += 1;
  }
  if (hasMonitoringMeta) {
    cols.push("monitoring_meta");
    vals.push(JSON.stringify(monitoringMeta));
    paramIndex += 1;
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`);
  const result = await pool.query(`INSERT INTO v_b_tickets (${cols.join(", ")}, created_at, updated_at)
     VALUES (${placeholders.join(", ")}, NOW(), NOW())
     RETURNING id, ticket_number, title`, hasEquipmentInfo && hasMonitoringMeta ? vals : hasEquipmentInfo ? vals : hasMonitoringMeta ? vals : vals);
  const ticket = result.rows[0];
  if (!ticket?.id) return null;
  const tags = resolveRunbookTags(runbook);
  if (tags.length) {
    await pool.query(`UPDATE v_b_tickets SET tags = $1::text[], updated_at = NOW() WHERE id = $2::uuid`, [tags, ticket.id]).catch(() => {});
  }
  await pool.query(`INSERT INTO v_b_ticket_status_history (ticket_id, old_status, new_status, changed_by, note, created_at)
     VALUES ($1, NULL, 'open', NULL, $2, NOW())`, [ticket.id, "Automatic creation — monitoring alert"]);
  await pool.query(`INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
     VALUES ($1, NULL, $2, TRUE, NOW())`, [ticket.id, buildLinkedEquipmentComment({
    equipmentId,
    equipmentName,
    equipmentFamily,
    clientId
  })]);
  let runbookForComment = runbook ? {
    ...runbook
  } : null;
  let aiNotes = null;
  let locale = "fr";
  try {
    const settings = await getSettingsMap([GENERAL_SETTING_KEYS.defaultLocale]);
    const rawLocale = String(settings[GENERAL_SETTING_KEYS.defaultLocale] || "fr").toLowerCase().slice(0, 2);
    locale = ALLOWED_LOCALES.includes(rawLocale) ? rawLocale : "fr";
  } catch {
    locale = "fr";
  }
  try {
    const enriched = await enrichAlertRunbook({
      criterionKey,
      criterionLabel: label,
      equipmentName,
      equipmentFamily,
      source,
      detail,
      baseRunbook: runbook,
      ticketTitle: title,
      ticketDescription: description,
      locale
    });
    if (enriched?.checklist?.length) {
      runbookForComment = {
        ...(runbookForComment || {
          title: label,
          priority: "normal",
          tags: []
        }),
        checklist: enriched.checklist,
        title: enriched.title || runbookForComment?.title || label
      };
      aiNotes = enriched.notes || null;
    }
  } catch (err) {
    console.warn("[monitoring] AI runbook enrich skipped:", err.message);
  }
  if (runbookForComment) {
    const runbookComment = buildRunbookComment(runbookForComment, {
      criterionKey,
      equipmentName,
      aiNotes,
      locale
    });
    if (runbookComment) {
      await pool.query(`INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
         VALUES ($1, NULL, $2, TRUE, NOW())`, [ticket.id, runbookComment]);
    }
  }
  const config = await getMonitoringAutomationConfig();
  await applyMonitoringTicketAssignment({
    ticketId: ticket.id,
    clientId,
    criterionKey,
    config
  });
  await dispatchNotificationEvent({
    source: "tickets",
    element: "created",
    enterpriseId: String(clientId),
    context: {
      ticket,
      entreprise: {
        id: String(clientId)
      }
    }
  }).catch(() => {});
  return ticket;
}
export async function evaluateEquipmentCriteriaAlerts({
  clientId,
  equipmentId,
  equipmentFamily,
  equipmentName,
  activeCriteria = [],
  source = "checkmk",
  previousCriteriaMap = null
}) {
  if (!clientId || !equipmentId || !equipmentFamily) {
    return {
      skipped: true,
      reason: "missing_params"
    };
  }
  const settings = await getEquipmentAlertSettings(clientId, equipmentId, equipmentFamily);
  const previousMap = previousCriteriaMap || (settings?.lastKnownCriteria && typeof settings.lastKnownCriteria === "object" ? settings.lastKnownCriteria : {});
  const activeMap = criteriaToActiveMap(activeCriteria);
  const {
    activated,
    resolved
  } = diffCriteriaTransitions(previousMap, activeMap);
  const clientPolicy = await getClientMonitoringAlertPolicy(clientId);
  if (isClientMonitoringAlertsSuspended(clientPolicy)) {
    await touchEquipmentAlertState({
      clientId,
      equipmentId,
      equipmentFamily,
      equipmentName,
      monitorStatus: Object.keys(activeMap).length ? "warning" : "ok",
      lastKnownCriteria: activeMap
    });
    return {
      skipped: true,
      reason: "client_suspended",
      activated: [],
      resolved
    };
  }
  if (!areMonitoringAlertsEnabled(settings)) {
    await touchEquipmentAlertState({
      clientId,
      equipmentId,
      equipmentFamily,
      equipmentName,
      monitorStatus: Object.keys(activeMap).length ? "warning" : "ok",
      lastKnownCriteria: activeMap
    });
    return {
      skipped: true,
      reason: "disabled",
      activated: [],
      resolved
    };
  }
  const config = await getMonitoringAutomationConfig();
  const rules = await getSupervisionAlertRules();
  const createdTickets = [];
  const skipped = [];
  for (const criterionKey of activated) {
    const allowed = await isSupervisionAlertAllowed({
      equipmentFamily,
      monitorStatus: null,
      source,
      criterionKey
    });
    if (!allowed) {
      skipped.push({
        criterionKey,
        reason: "global_rule_disabled"
      });
      continue;
    }
    const detail = activeCriteria.find(c => c.key === criterionKey)?.detail || null;
    const runbook = await resolveRunbookForCriterion(criterionKey);
    const ruleSeverity = getSupervisionCriterionSeverity(equipmentFamily, criterionKey, rules);
    const incidentGroup = await findOrCreateIncidentGroup({
      clientId,
      criterionKey,
      config,
      parentTicketId: null
    });
    const ticket = await createCriterionAlertTicket({
      clientId,
      equipmentId,
      equipmentFamily,
      equipmentName,
      criterionKey,
      source,
      detail,
      runbook,
      incidentGroupId: incidentGroup?.id || null,
      ruleSeverity
    });
    if (ticket?.id) {
      if (incidentGroup?.id) {
        await linkTicketToIncidentGroup(ticket.id, incidentGroup.id);
      }
      createdTickets.push({
        ticketId: ticket.id,
        ticketNumber: ticket.ticket_number,
        criterionKey
      });
      await recordMonitoringEvent({
        source: "monitoring_scan",
        eventType: "criterion_activated",
        clientId,
        equipmentId,
        equipmentFamily,
        criterionKey,
        payload: {
          detail
        },
        ticketId: ticket.id,
        incidentGroupId: incidentGroup?.id || null
      });
    }
  }
  for (const criterionKey of resolved) {
    await handleCriterionRecovery({
      clientId,
      equipmentId,
      equipmentFamily,
      equipmentName,
      criterionKey,
      config
    });
  }
  const aggregateStatus = activeMap.monitor_critical || activeMap.agent_offline || activeMap.disk_critical ? "critical" : Object.keys(activeMap).length ? "warning" : "ok";
  await touchEquipmentAlertState({
    clientId,
    equipmentId,
    equipmentFamily,
    equipmentName,
    monitorStatus: aggregateStatus,
    lastKnownCriteria: activeMap,
    ticketId: createdTickets[0]?.ticketId || settings?.lastTicketId || null,
    alertAt: createdTickets.length ? new Date().toISOString() : settings?.lastAlertAt || null
  });
  return {
    created: createdTickets.length,
    createdTickets,
    resolved,
    skipped,
    activeMap
  };
}
async function handleCriterionRecovery({
  clientId,
  equipmentId,
  equipmentFamily,
  criterionKey,
  config
}) {
  const autoRes = config?.autoResolution || {};
  if (autoRes.enabled === false) return;
  const label = getCriterionLabel(criterionKey) || criterionKey;
  const comment = ["✅ Automatic recovery detected", "", `The “${label}” criterion is no longer active on this equipment.`, autoRes.requireAgentValidation ? "Please validate the resolution and close the ticket if the work is complete." : "The ticket can be closed if no further action is required."].join("\n");
  const openTickets = await pool.query(`SELECT id, ticket_number, monitoring_meta, equipment_info
     FROM v_b_tickets
     WHERE client_id = $1
       AND channel = 'monitoring'
       AND status NOT IN ('resolved', 'closed')
       AND monitoring_meta->>'criterionKey' = $2
     ORDER BY created_at DESC
     LIMIT 5`, [clientId, criterionKey]);
  for (const ticket of openTickets.rows) {
    const linkedEquipmentId = ticket.equipment_info?.equipmentId || ticket.equipment_info?.equipment_id || ticket.monitoring_meta?.equipmentId || null;
    if (linkedEquipmentId && String(linkedEquipmentId) !== String(equipmentId)) continue;
    await pool.query(`INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
       VALUES ($1, NULL, $2, TRUE, NOW())`, [ticket.id, comment]);
    if (autoRes.requireAgentValidation) {
      await pool.query(`UPDATE v_b_tickets
         SET monitoring_meta = COALESCE(monitoring_meta, '{}'::jsonb) || '{"autoResolutionPending":true}'::jsonb,
             updated_at = NOW()
         WHERE id = $1`, [ticket.id]);
    } else if (autoRes.suggestCloseAfterRecoveryMinutes == null) {
      await pool.query(`UPDATE v_b_tickets SET status = 'resolved', resolved_at = NOW(), updated_at = NOW() WHERE id = $1`, [ticket.id]);
    }
    await recordMonitoringEvent({
      source: "monitoring_scan",
      eventType: "criterion_resolved",
      clientId,
      equipmentId,
      equipmentFamily,
      criterionKey,
      ticketId: ticket.id,
      payload: {
        autoResolution: true
      }
    });
  }
}
export async function evaluateMonitoringAlert({
  clientId,
  equipmentId,
  equipmentFamily,
  equipmentName,
  monitorStatus,
  source = "checkmk",
  details = null
}) {
  const status = String(monitorStatus || "ok").toLowerCase();
  const activeCriteria = [];
  if (status === "critical") activeCriteria.push({
    key: "monitor_critical",
    detail: details
  });else if (status === "warning") activeCriteria.push({
    key: "monitor_warning",
    detail: details
  });else if (status === "offline") activeCriteria.push({
    key: "agent_offline",
    detail: details
  });else if (status === "unmapped") activeCriteria.push({
    key: "unmapped",
    detail: details
  });else if (status === "no_data") activeCriteria.push({
    key: "no_data",
    detail: details
  });
  return evaluateEquipmentCriteriaAlerts({
    clientId,
    equipmentId,
    equipmentFamily,
    equipmentName,
    activeCriteria,
    source
  });
}
export async function evaluateInventoryItem(item, {
  offlineAlertThresholdMinutes,
  thresholds,
  rules
} = {}) {
  const activeCriteria = evaluateEquipmentSupervisionCriteria({
    equipmentFamily: item.equipmentFamily,
    data: item.data,
    name: item.equipmentName,
    ip: item.ip,
    agentId: item.agentId,
    lastSeenAt: item.lastSeenAt,
    checkmkSummary: item.checkmkSummary,
    isMkMapped: item.isMkMapped,
    offlineAlertThresholdMinutes,
    thresholds
  });
  return evaluateEquipmentCriteriaAlerts({
    clientId: item.clientId,
    equipmentId: item.equipmentId,
    equipmentFamily: item.equipmentFamily,
    equipmentName: item.equipmentName,
    activeCriteria,
    source: item.source || "checkmk"
  });
}
export { evaluateEquipmentSupervisionCriteria };
