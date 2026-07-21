const PRIORITY_KEYS = ["urgent", "high", "normal", "low"];
import { pool } from "../database/db.js";
import { computeSlaDueAt } from "./slaBusinessTime.js";
import { loadSlaSettings } from "./slaSettingsStore.js";
export const DEFAULT_SLA_BY_PRIORITY = {
  urgent: {
    firstResponseHours: 1,
    resolutionHours: 4
  },
  high: {
    firstResponseHours: 2,
    resolutionHours: 8
  },
  normal: {
    firstResponseHours: 4,
    resolutionHours: 24
  },
  low: {
    firstResponseHours: 8,
    resolutionHours: 48
  }
};
function parseJsonObject(value, fallback = {}) {
  if (!value) return {
    ...fallback
  };
  if (typeof value === "object") return {
    ...fallback,
    ...value
  };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? {
      ...fallback,
      ...parsed
    } : {
      ...fallback
    };
  } catch {
    return {
      ...fallback
    };
  }
}
function normalizePriority(priority) {
  const key = String(priority || "normal").toLowerCase();
  return PRIORITY_KEYS.includes(key) ? key : "normal";
}
export function parseClientSla(contrat) {
  const contratObj = parseJsonObject(contrat, {});
  const sla = parseJsonObject(contratObj.sla, {});
  const byPriority = {
    ...DEFAULT_SLA_BY_PRIORITY
  };
  const sourceByPriority = parseJsonObject(sla.byPriority, {});
  for (const key of PRIORITY_KEYS) {
    const row = parseJsonObject(sourceByPriority[key], {});
    byPriority[key] = {
      firstResponseHours: Number(row.firstResponseHours ?? byPriority[key].firstResponseHours),
      resolutionHours: Number(row.resolutionHours ?? byPriority[key].resolutionHours)
    };
  }
  return {
    enabled: Boolean(sla.enabled),
    byPriority
  };
}
export function getSlaHoursForPriority(clientSla, priority) {
  const key = normalizePriority(priority);
  if (clientSla?.enabled) {
    return clientSla.byPriority[key] || clientSla.byPriority.normal;
  }
  return DEFAULT_SLA_BY_PRIORITY[key] || DEFAULT_SLA_BY_PRIORITY.normal;
}
function addHours(baseDate, hours, slaSettings) {
  if (!slaSettings || slaSettings.timeMode === "calendar") {
    const date = new Date(baseDate);
    if (Number.isNaN(date.getTime())) return null;
    date.setTime(date.getTime() + Number(hours || 0) * 60 * 60 * 1000);
    return date;
  }
  return computeSlaDueAt({
    startDate: baseDate,
    amount: hours,
    settingsInput: slaSettings
  });
}
function normalizeTicketStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "open") return "new";
  return value;
}
function isNewTicketStatus(status) {
  const key = normalizeTicketStatus(status);
  return key === "new" || key === "";
}
export function findFirstTakeoverAtFromHistory(statusHistory = []) {
  const rows = Array.isArray(statusHistory) ? statusHistory : [];
  const match = rows.map(row => ({
    at: row?.created_at,
    atMs: new Date(row?.created_at).getTime(),
    oldStatus: row?.old_status,
    newStatus: row?.new_status
  })).filter(row => !Number.isNaN(row.atMs) && isNewTicketStatus(row.oldStatus) && row.newStatus && !isNewTicketStatus(row.newStatus)).sort((a, b) => a.atMs - b.atMs)[0];
  return match?.at || null;
}
function applyTakeoverToSlaInfo(sla, takeoverAt, slaSettings) {
  if (!sla?.enabled || !takeoverAt) return sla;
  const at = new Date(takeoverAt);
  if (Number.isNaN(at.getTime())) return sla;
  const resolutionHours = Number(sla.policy?.resolutionHours || 0);
  const resolutionDueAt = resolutionHours > 0 ? addHours(at, resolutionHours, slaSettings) : null;
  const firstResponseBreached = sla.firstResponseDueAt ? at.getTime() > new Date(sla.firstResponseDueAt).getTime() : false;
  return {
    ...sla,
    firstResponseAt: at.toISOString(),
    firstResponseBreached,
    resolutionDueAt: resolutionDueAt ? resolutionDueAt.toISOString() : null
  };
}
export function buildSlaInfoForTicketSync({
  clientContrat,
  priority,
  createdAt = new Date(),
  slaSettings
}) {
  const clientSla = parseClientSla(clientContrat);
  const hours = getSlaHoursForPriority(clientSla, priority);
  if (!hours || !slaSettings) return {
    enabled: false
  };
  const firstResponseDueAt = addHours(createdAt, hours.firstResponseHours, slaSettings);
  if (!firstResponseDueAt) return {
    enabled: false
  };
  return {
    enabled: true,
    priority: normalizePriority(priority),
    firstResponseDueAt: firstResponseDueAt.toISOString(),
    resolutionDueAt: null,
    firstResponseAt: null,
    firstResponseBreached: false,
    resolutionBreached: false,
    policy: hours,
    timeMode: slaSettings.timeMode
  };
}
export async function buildSlaInfoForTicket({
  clientContrat,
  priority,
  createdAt = new Date(),
  slaSettings
}) {
  const resolvedSettings = slaSettings ?? (await loadSlaSettings());
  return buildSlaInfoForTicketSync({
    clientContrat,
    priority,
    createdAt,
    slaSettings: resolvedSettings
  });
}
export function parseSlaInfo(raw) {
  return parseJsonObject(raw, {
    enabled: false
  });
}
function isSlaInfoReadyForDisplay(sla, ticket) {
  if (!sla?.enabled || !sla.firstResponseDueAt) return false;
  const status = normalizeTicketStatus(ticket?.status);
  if (isTicketClosed(status) || isNewTicketStatus(status)) {
    return true;
  }
  return Boolean(sla.firstResponseAt && sla.resolutionDueAt);
}
export function resolveTicketSlaInfo(ticket, {
  clientContrat,
  slaSettings
} = {}) {
  const resolvedContrat = clientContrat ?? ticket?.client_contrat ?? null;
  const existing = parseSlaInfo(ticket?.sla_info);
  const takeoverAt = ticket?.first_takeover_at || findFirstTakeoverAtFromHistory(ticket?.statusHistory) || existing.firstResponseAt || null;
  const refreshFirstResponse = isNewTicketStatus(ticket?.status) && !takeoverAt && !existing.firstResponseAt;
  if (isSlaInfoReadyForDisplay(existing, ticket) && !refreshFirstResponse) {
    return existing;
  }
  let sla = existing;
  if ((!existing.enabled || !existing.firstResponseDueAt || refreshFirstResponse) && slaSettings) {
    const built = buildSlaInfoForTicketSync({
      clientContrat: resolvedContrat,
      priority: ticket?.priority,
      createdAt: ticket?.created_at || new Date(),
      slaSettings: refreshFirstResponse ? {
        ...slaSettings,
        timeMode: "calendar"
      } : slaSettings
    });
    if (built.enabled) {
      sla = refreshFirstResponse ? {
        ...existing,
        ...built,
        resolutionDueAt: null,
        firstResponseAt: null,
        firstResponseBreached: false
      } : built;
    }
  }
  if (!sla.enabled) return sla;
  if (takeoverAt && !isNewTicketStatus(ticket?.status)) {
    if (sla.firstResponseAt && sla.resolutionDueAt) return sla;
    return applyTakeoverToSlaInfo(sla, takeoverAt, slaSettings);
  }
  if (isNewTicketStatus(ticket?.status)) {
    return {
      ...sla,
      firstResponseAt: null,
      resolutionDueAt: null,
      firstResponseBreached: false
    };
  }
  return sla;
}
export async function persistTicketSlaInfoIfMissing(ticketId, slaInfo) {
  if (!ticketId || !slaInfo?.enabled) return;
  await pool.query(`UPDATE v_b_tickets
     SET sla_info = $1::jsonb
     WHERE id = $2
       AND COALESCE((sla_info->>'enabled')::boolean, false) = false`, [JSON.stringify(slaInfo), ticketId]);
}
export async function ensureTicketSlaInfoStored(ticketId) {
  const result = await pool.query(`SELECT t.id, t.priority, t.created_at, t.sla_info, t.client_id, c.contrat AS client_contrat
     FROM v_b_tickets t
     LEFT JOIN v_b_clients c ON c.id = t.client_id
     WHERE t.id = $1`, [ticketId]);
  if (!result.rows.length) return;
  const ticket = result.rows[0];
  if (parseSlaInfo(ticket.sla_info).enabled) return;
  const slaSettings = await loadSlaSettings();
  const historyResult = await pool.query(`SELECT old_status, new_status, created_at
     FROM v_b_ticket_status_history
     WHERE ticket_id = $1
     ORDER BY created_at ASC`, [ticketId]);
  const resolved = resolveTicketSlaInfo({
    ...ticket,
    statusHistory: historyResult.rows
  }, {
    clientContrat: ticket.client_contrat,
    slaSettings
  });
  await persistTicketSlaInfoIfMissing(ticketId, resolved);
}
function formatSlaRemainingLabel(remainingMs) {
  if (remainingMs == null || Number.isNaN(remainingMs)) return "—";
  const overdue = remainingMs <= 0;
  const absMs = Math.abs(remainingMs);
  if (!overdue && absMs < 60000) {
    return "<1m";
  }
  const totalMinutes = overdue ? Math.max(1, Math.ceil(absMs / 60000)) : Math.max(0, Math.floor(absMs / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor(totalMinutes % (60 * 24) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}j${hours}h` : `${days}j`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h${String(minutes).padStart(2, "0")}` : `${hours}h`;
  }
  return `${totalMinutes}m`;
}
function isTicketClosed(status) {
  const normalized = normalizeTicketStatus(status);
  return normalized === "resolved" || normalized === "closed";
}
export function computeSlaDisplay(ticket, now = Date.now()) {
  const sla = parseSlaInfo(ticket?.sla_info);
  if (!sla.enabled) {
    return {
      sla_status: "none",
      sla_label: "—",
      sla_tone: "neutral",
      sla_phase: null,
      sla_remaining_ms: null
    };
  }
  const status = normalizeTicketStatus(ticket?.status);
  const closed = isTicketClosed(status);
  const isNew = isNewTicketStatus(status);
  const firstResponseDue = sla.firstResponseDueAt ? new Date(sla.firstResponseDueAt).getTime() : null;
  const resolutionDue = sla.resolutionDueAt ? new Date(sla.resolutionDueAt).getTime() : null;
  const firstResponseAt = sla.firstResponseAt ? new Date(sla.firstResponseAt).getTime() : null;
  const resolvedAt = ticket?.resolved_at ? new Date(ticket.resolved_at).getTime() : null;
  if (closed) {
    const firstOk = !firstResponseDue || (firstResponseAt ? firstResponseAt <= firstResponseDue : true);
    const resolutionOk = !resolutionDue || (resolvedAt ? resolvedAt <= resolutionDue : true);
    const ok = firstOk && resolutionOk;
    return {
      sla_status: ok ? "met" : "breached",
      sla_label: ok ? "OK" : "Overdue",
      sla_tone: ok ? "ok" : "breach",
      sla_phase: "closed",
      sla_remaining_ms: null
    };
  }
  if (isNew && firstResponseDue) {
    const remaining = firstResponseDue - now;
    const warningMs = Math.max(15 * 60 * 1000, (sla.policy?.firstResponseHours || 4) * 60 * 60 * 1000 * 0.2);
    return {
      sla_status: remaining <= 0 ? "breached" : remaining <= warningMs ? "warning" : "active",
      sla_label: formatSlaRemainingLabel(remaining),
      sla_tone: remaining <= 0 ? "breach" : remaining <= warningMs ? "warning" : "ok",
      sla_phase: "first_response",
      sla_remaining_ms: remaining
    };
  }
  if (!isNew && resolutionDue) {
    const remaining = resolutionDue - now;
    const warningMs = Math.max(30 * 60 * 1000, (sla.policy?.resolutionHours || 24) * 60 * 60 * 1000 * 0.2);
    return {
      sla_status: remaining <= 0 ? "breached" : remaining <= warningMs ? "warning" : "active",
      sla_label: formatSlaRemainingLabel(remaining),
      sla_tone: remaining <= 0 ? "breach" : remaining <= warningMs ? "warning" : "ok",
      sla_phase: "resolution",
      sla_remaining_ms: remaining
    };
  }
  return {
    sla_status: "none",
    sla_label: "—",
    sla_tone: "neutral",
    sla_phase: null,
    sla_remaining_ms: null
  };
}
export function enrichTicketWithSla(ticket, ctx = {}) {
  if (!ticket || typeof ticket !== "object") return ticket;
  const resolvedSlaInfo = resolveTicketSlaInfo(ticket, {
    ...ctx,
    clientContrat: ctx.clientContrat ?? ticket.client_contrat ?? null
  });
  const {
    client_contrat: _clientContrat,
    first_public_comment_at: _firstCommentAt,
    ...publicTicket
  } = ticket;
  const ticketWithSla = {
    ...publicTicket,
    sla_info: resolvedSlaInfo
  };
  const slaView = computeSlaDisplay(ticketWithSla);
  return {
    ...ticketWithSla,
    ...slaView,
    sla: {
      ...resolvedSlaInfo,
      ...slaView
    }
  };
}
export async function loadClientContrat(clientId) {
  if (!clientId) return null;
  const result = await pool.query("SELECT contrat FROM v_b_clients WHERE id = $1", [clientId]);
  if (!result.rows.length) return null;
  return result.rows[0].contrat;
}
export async function maybeRecordTakeoverSla(ticketId, oldStatus, newStatus) {
  if (!ticketId || !isNewTicketStatus(oldStatus) || isNewTicketStatus(newStatus)) return;
  await ensureTicketSlaInfoStored(ticketId);
  const ticketResult = await pool.query(`SELECT t.sla_info, t.priority, t.created_at, c.contrat AS client_contrat
     FROM v_b_tickets t
     LEFT JOIN v_b_clients c ON c.id = t.client_id
     WHERE t.id = $1`, [ticketId]);
  if (!ticketResult.rows.length) return;
  const sla = parseSlaInfo(ticketResult.rows[0].sla_info);
  if (!sla.enabled) return;
  if (sla.firstResponseAt && sla.resolutionDueAt) return;
  const historyResult = await pool.query(`SELECT old_status, new_status, created_at
     FROM v_b_ticket_status_history
     WHERE ticket_id = $1
     ORDER BY created_at ASC`, [ticketId]);
  const takeoverAt = findFirstTakeoverAtFromHistory(historyResult.rows) || sla.firstResponseAt || null;
  if (!takeoverAt) return;
  const slaSettings = await loadSlaSettings();
  const nextSla = applyTakeoverToSlaInfo(sla, takeoverAt, slaSettings);
  await pool.query("UPDATE v_b_tickets SET sla_info = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(nextSla), ticketId]);
}
