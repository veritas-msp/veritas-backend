import { pool } from "../database/db.js";
import { ensureTicketActivitySchema } from "./ensureTicketActivitySchema.js";

const FIELD_KEYS = [{
  body: "title",
  db: "title"
}, {
  body: "description",
  db: "description"
}, {
  body: "priority",
  db: "priority"
}, {
  body: "type",
  db: "type"
}, {
  body: "category",
  db: "category"
}, {
  body: "channel",
  db: "channel"
}, {
  body: "clientId",
  db: "client_id"
}, {
  body: "requesterUserId",
  db: "requester_user_id"
}, {
  body: "requesterContactId",
  db: "requester_contact_id"
}, {
  body: "assignedUserId",
  db: "assigned_user_id"
}, {
  body: "isMajorIncident",
  db: "is_major_incident"
}];

function normalizeActivityValue(value) {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  const text = String(value).trim();
  return text === "" ? null : text;
}

function valuesEqual(a, b) {
  return normalizeActivityValue(a) === normalizeActivityValue(b);
}

export async function logTicketActivity({
  ticketId,
  action,
  field = null,
  oldValue = null,
  newValue = null,
  actorUserId = null,
  meta = null
} = {}) {
  if (!ticketId || !action) return null;
  const ready = await ensureTicketActivitySchema();
  if (!ready) return null;
  try {
    const result = await pool.query(`INSERT INTO v_b_ticket_activity
         (ticket_id, action, field, old_value, new_value, meta, actor_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
       RETURNING id, ticket_id, action, field, old_value, new_value, meta, actor_user_id, created_at`, [ticketId, String(action).slice(0, 48), field ? String(field).slice(0, 64) : null, normalizeActivityValue(oldValue), normalizeActivityValue(newValue), meta == null ? null : JSON.stringify(meta), actorUserId || null]);
    return result.rows[0] || null;
  } catch (err) {
    console.error("[ticket-activity] Failed to log activity:", err.message);
    return null;
  }
}

export async function logTicketFieldChanges({
  ticketId,
  oldTicket,
  newTicket,
  actorUserId = null,
  bodyKeys = null
} = {}) {
  if (!ticketId || !oldTicket || !newTicket) return [];
  const keys = Array.isArray(bodyKeys) && bodyKeys.length > 0 ? FIELD_KEYS.filter(item => bodyKeys.includes(item.body) || bodyKeys.includes(item.db)) : FIELD_KEYS;
  const logged = [];
  for (const {
    db: field
  } of keys) {
    const oldValue = oldTicket[field];
    const newValue = newTicket[field];
    if (valuesEqual(oldValue, newValue)) continue;
    // Status is already audited in v_b_ticket_status_history
    if (field === "status") continue;
    const row = await logTicketActivity({
      ticketId,
      action: "field_changed",
      field,
      oldValue,
      newValue,
      actorUserId
    });
    if (row) logged.push(row);
  }
  return logged;
}

export async function listTicketActivity(ticketId) {
  if (!ticketId) return [];
  const ready = await ensureTicketActivitySchema();
  if (!ready) return [];
  try {
    const result = await pool.query(`SELECT id, ticket_id, action, field, old_value, new_value, meta, actor_user_id, created_at
       FROM v_b_ticket_activity
       WHERE ticket_id = $1
       ORDER BY created_at DESC`, [ticketId]);
    return result.rows;
  } catch (err) {
    console.error("[ticket-activity] Failed to list activity:", err.message);
    return [];
  }
}
