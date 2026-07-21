import { pool } from "../database/db.js";
import { ensureEventsSchema } from "./ensureEventsSchema.js";
import { normalizePlanningEventDateInput } from "../routes/utils/planningEventDateTime.js";
function formatEventRowForApi(row) {
  if (!row) return row;
  const start = normalizePlanningEventDateInput(row.start);
  const end = normalizePlanningEventDateInput(row.end);
  return {
    ...row,
    start: start ? start.replace(" ", "T") : row.start,
    end: end ? end.replace(" ", "T") : row.end
  };
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let equipmentInfoColumnCache = null;
async function hasEquipmentInfoColumn() {
  if (equipmentInfoColumnCache !== null) return equipmentInfoColumnCache;
  const result = await pool.query(`SELECT EXISTS (
       SELECT 1
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.oid = to_regclass('public.v_b_tickets')
         AND a.attname = 'equipment_info'
         AND NOT a.attisdropped
     ) AS has_column`);
  equipmentInfoColumnCache = Boolean(result.rows?.[0]?.has_column);
  return equipmentInfoColumnCache;
}
async function hasTicketDeletedColumns() {
  const result = await pool.query(`SELECT
       EXISTS (
         SELECT 1 FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.oid = to_regclass('public.v_b_tickets')
           AND a.attname = 'deleted_at' AND NOT a.attisdropped
       ) AS has_deleted_at,
       EXISTS (
         SELECT 1 FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.oid = to_regclass('public.v_b_tickets')
           AND a.attname = 'is_deleted' AND NOT a.attisdropped
       ) AS has_is_deleted`);
  return {
    hasDeletedAt: Boolean(result.rows?.[0]?.has_deleted_at),
    hasIsDeleted: Boolean(result.rows?.[0]?.has_is_deleted)
  };
}
export function parseEquipmentActivityId(raw) {
  const value = String(raw || "").trim();
  return UUID_RE.test(value) ? value : null;
}
export function parseActivityDateInput(raw, {
  endOfDay = false
} = {}) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const normalized = text.includes("T") ? text : `${text}${endOfDay ? "T23:59:59" : "T00:00:00"}`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}
export function resolveActivityDateRange(startDate, endDate) {
  const end = parseActivityDateInput(endDate, {
    endOfDay: true
  }) || new Date();
  const start = parseActivityDateInput(startDate, {
    endOfDay: false
  }) || new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (start > end) {
    return {
      start: end,
      end: start
    };
  }
  return {
    start,
    end
  };
}
function appendEquipmentTicketLinkFilter(where, values, equipmentId, startIndex, hasEquipmentInfo) {
  const id = String(equipmentId);
  const pattern = `%[equipment_id:${id}]%`;
  const parts = [];
  let index = startIndex;
  if (hasEquipmentInfo) {
    parts.push(`(
      COALESCE(t.equipment_info->>'concerned', 'false') IN ('true', 't')
      AND (
        t.equipment_info->>'equipmentId' = $${index}
        OR t.equipment_info->>'equipment_id' = $${index}
      )
    )`);
    values.push(id);
    index += 1;
  }
  parts.push(`EXISTS (
    SELECT 1 FROM v_b_ticket_comments c_add
    WHERE c_add.ticket_id = t.id
      AND c_add.content LIKE '[Linked equipment] [event:added]%'
      AND c_add.content LIKE $${index}
      AND NOT EXISTS (
        SELECT 1 FROM v_b_ticket_comments c_rem
        WHERE c_rem.ticket_id = t.id
          AND c_rem.content LIKE '[Linked equipment] [event:removed]%'
          AND c_rem.content LIKE $${index}
          AND c_rem.created_at > c_add.created_at
      )
  )`);
  values.push(pattern);
  index += 1;
  where.push(`(${parts.join(" OR ")})`);
  return index;
}
function normalizeTicketStatusKey(status) {
  const key = String(status || "").toLowerCase();
  return key === "open" ? "new" : key;
}
function buildStatsFromTickets(tickets) {
  const byStatus = {
    new: 0,
    in_progress: 0,
    pending: 0,
    resolved: 0,
    closed: 0
  };
  const byPriority = {
    low: 0,
    normal: 0,
    high: 0,
    urgent: 0
  };
  let resolutionTotalMs = 0;
  let resolutionCount = 0;
  for (const ticket of tickets) {
    const statusKey = normalizeTicketStatusKey(ticket.status);
    if (byStatus[statusKey] !== undefined) byStatus[statusKey] += 1;
    const priorityKey = String(ticket.priority || "normal").toLowerCase();
    if (byPriority[priorityKey] !== undefined) byPriority[priorityKey] += 1;else byPriority.normal += 1;
    if (ticket.resolved_at && ticket.created_at) {
      const createdMs = new Date(ticket.created_at).getTime();
      const resolvedMs = new Date(ticket.resolved_at).getTime();
      if (!Number.isNaN(createdMs) && !Number.isNaN(resolvedMs) && resolvedMs >= createdMs) {
        resolutionTotalMs += resolvedMs - createdMs;
        resolutionCount += 1;
      }
    }
  }
  return {
    ticketsTotal: tickets.length,
    ticketsOpen: byStatus.new + byStatus.in_progress + byStatus.pending,
    ticketsByStatus: byStatus,
    ticketsByPriority: byPriority,
    avgResolutionHours: resolutionCount > 0 ? Math.round(resolutionTotalMs / resolutionCount / (1000 * 60 * 60) * 10) / 10 : null
  };
}
function buildStatsFromEvents(events) {
  const now = Date.now();
  let upcoming = 0;
  let past = 0;
  const byType = {};
  for (const event of events) {
    const endMs = new Date(event.end || event.start).getTime();
    if (!Number.isNaN(endMs) && endMs >= now) upcoming += 1;else past += 1;
    const typeKey = String(event.type || "other").toLowerCase();
    byType[typeKey] = (byType[typeKey] || 0) + 1;
  }
  return {
    eventsTotal: events.length,
    eventsUpcoming: upcoming,
    eventsPast: past,
    eventsByType: byType
  };
}
async function fetchPlanningEvents({
  equipmentId,
  clientId,
  start,
  end
}) {
  const schema = await ensureEventsSchema();
  const values = [equipmentId, Number(clientId), start.toISOString(), end.toISOString()];
  const ticketFields = schema.hasTicketId ? `e.ticket_id,
        t.ticket_number,
        t.type AS ticket_type` : `NULL::uuid AS ticket_id,
        NULL::text AS ticket_number,
        NULL::text AS ticket_type`;
  const ticketJoins = schema.hasTicketId ? `LEFT JOIN v_b_tickets t ON t.id = e.ticket_id` : "";
  const result = await pool.query(`SELECT
        e.id,
        e.title,
        e.type,
        to_char(e.start, 'YYYY-MM-DD"T"HH24:MI:SS') AS start,
        to_char(e."end", 'YYYY-MM-DD"T"HH24:MI:SS') AS "end",
        e.description,
        e.client_id,
        e.equipment_id,
        e.assigned_user_id,
        ${ticketFields},
        e.created_at,
        e.updated_at
      FROM v_b_events e
      ${ticketJoins}
      WHERE e.equipment_id::text = $1
        AND e.client_id = $2
        AND e.start <= $4::timestamptz
        AND e."end" >= $3::timestamptz
      ORDER BY e.start DESC
      LIMIT 200`, values);
  return (result.rows || []).map(row => formatEventRowForApi(row));
}
async function fetchLinkedTickets({
  equipmentId,
  clientId,
  start,
  end
}) {
  const hasEquipmentInfo = await hasEquipmentInfoColumn();
  const {
    hasDeletedAt,
    hasIsDeleted
  } = await hasTicketDeletedColumns();
  const where = [`t.client_id = $1`];
  const values = [Number(clientId)];
  let index = 2;
  index = appendEquipmentTicketLinkFilter(where, values, equipmentId, index, hasEquipmentInfo);
  where.push(`(COALESCE(t.updated_at, t.created_at) >= $${index} AND COALESCE(t.updated_at, t.created_at) <= $${index + 1})`);
  values.push(start.toISOString(), end.toISOString());
  index += 2;
  if (hasDeletedAt) {
    where.push("t.deleted_at IS NULL");
  } else if (hasIsDeleted) {
    where.push("COALESCE(t.is_deleted, FALSE) = FALSE");
  }
  const equipmentInfoSelect = hasEquipmentInfo ? "t.equipment_info," : "";
  const result = await pool.query(`SELECT
        t.id,
        t.ticket_number,
        t.title,
        t.status,
        t.priority,
        t.type,
        t.category,
        t.client_id,
        t.created_at,
        t.updated_at,
        t.resolved_at,
        ${equipmentInfoSelect}
        c.name AS client_name
      FROM v_b_tickets t
      LEFT JOIN v_b_clients c ON c.id = t.client_id
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(t.updated_at, t.created_at) DESC
      LIMIT 200`, values);
  return result.rows || [];
}
export async function loadEquipmentActivity({
  equipmentId,
  clientId,
  startDate,
  endDate
}) {
  const parsedEquipmentId = parseEquipmentActivityId(equipmentId);
  if (!parsedEquipmentId) {
    const error = new Error("Invalid equipment ID");
    error.statusCode = 400;
    throw error;
  }
  const parsedClientId = Number(clientId);
  if (!parsedClientId || Number.isNaN(parsedClientId)) {
    const error = new Error("clientId is required");
    error.statusCode = 400;
    throw error;
  }
  const {
    start,
    end
  } = resolveActivityDateRange(startDate, endDate);
  const [events, tickets] = await Promise.all([fetchPlanningEvents({
    equipmentId: parsedEquipmentId,
    clientId: parsedClientId,
    start,
    end
  }), fetchLinkedTickets({
    equipmentId: parsedEquipmentId,
    clientId: parsedClientId,
    start,
    end
  })]);
  const ticketStats = buildStatsFromTickets(tickets);
  const eventStats = buildStatsFromEvents(events);
  return {
    range: {
      start: start.toISOString(),
      end: end.toISOString()
    },
    events,
    tickets,
    stats: {
      ...ticketStats,
      ...eventStats
    }
  };
}
