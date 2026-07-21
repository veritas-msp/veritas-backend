import { pool } from "../database/db.js";
import { handleTicketStatusCreditChange } from "./supportCredits.js";
import { dispatchNotificationEvent } from "./notificationDispatcher.js";
import { notifyInAppTicketStatusChanged } from "./userNotificationService.js";
export const RESOLUTION_COMMENT_PREFIX = "[Resolution]";
export const RESOLUTION_AUTO_CLOSE_PREFIX = "[Resolution auto-close]";
export const RESOLUTION_CLIENT_REJECTION_PREFIX = "[Resolution client]";
export const RESOLUTION_CLIENT_ACCEPT_PREFIX = "[Resolution client accepted]";
export const LEGACY_RESOLUTION_PREFIXES = ["[Resolution auto-clôture]", "[Resolution client acceptée]"];
export const VALIDATION_AUTO_CLOSE_HOURS = 48;
let validationTableExistsCache = null;
export async function hasResolutionValidationTable() {
  if (validationTableExistsCache !== null) return validationTableExistsCache;
  const result = await pool.query(`SELECT to_regclass('v_b_ticket_resolution_validations') IS NOT NULL AS has_table`);
  validationTableExistsCache = Boolean(result.rows?.[0]?.has_table);
  return validationTableExistsCache;
}
function mapValidationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ticketId: row.ticket_id,
    resolutionReason: row.resolution_reason || "",
    interventionType: row.intervention_type || "",
    actionType: row.action_type || "",
    resolutionCommentId: row.resolution_comment_id || null,
    requestedAt: row.requested_at,
    autoCloseAt: row.auto_close_at,
    respondedAt: row.responded_at || null,
    outcome: row.outcome || "pending",
    rejectionMessage: row.rejection_message || "",
    respondedByUserId: row.responded_by_user_id || null,
    resolvedByUserId: row.resolved_by_user_id || null,
    isPending: String(row.outcome || "") === "pending"
  };
}
export async function getTicketResolutionValidation(ticketId) {
  if (!(await hasResolutionValidationTable())) return null;
  const result = await pool.query(`SELECT id, ticket_id, resolution_reason, intervention_type, action_type,
            resolution_comment_id, requested_at, auto_close_at, responded_at, outcome,
            rejection_message, responded_by_user_id, resolved_by_user_id
     FROM v_b_ticket_resolution_validations
     WHERE ticket_id = $1
     LIMIT 1`, [ticketId]);
  return mapValidationRow(result.rows[0] || null);
}
export async function ensureTicketStatusMatchesValidation(ticketId) {
  if (!(await hasResolutionValidationTable())) return false;
  const validation = await getTicketResolutionValidation(ticketId);
  if (!validation || validation.isPending) return false;
  if (!["accepted", "auto_closed"].includes(String(validation.outcome || ""))) return false;
  const ticketResult = await pool.query(`SELECT id, status FROM v_b_tickets WHERE id = $1 LIMIT 1`, [ticketId]);
  const ticket = ticketResult.rows[0];
  if (!ticket) return false;
  if (String(ticket.status || "").toLowerCase() === "closed") return false;
  const userId = validation.respondedByUserId || validation.resolvedByUserId || null;
  const note = validation.outcome === "auto_closed" ? "Synchronization — automatic closure after client validation" : "Synchronization — client validation accepted";
  await changeTicketStatus(ticketId, "closed", userId, note);
  return true;
}
export async function markResolutionValidationReopened(ticketId) {
  if (!(await hasResolutionValidationTable())) return false;
  const result = await pool.query(`DELETE FROM v_b_ticket_resolution_validations
     WHERE ticket_id = $1
       AND outcome IN ('pending', 'accepted', 'auto_closed')`, [ticketId]);
  return Number(result.rowCount || 0) > 0;
}
async function insertStatusHistory(ticketId, oldStatus, newStatus, userId, note) {
  await pool.query(`INSERT INTO v_b_ticket_status_history (ticket_id, old_status, new_status, changed_by, note, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`, [ticketId, oldStatus || null, newStatus, userId || null, note]);
}
async function addPublicComment(ticketId, userId, content) {
  const result = await pool.query(`INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
     VALUES ($1, $2, $3, false, NOW())
     RETURNING id, ticket_id, author_user_id, content, is_internal, created_at`, [ticketId, userId || null, content]);
  await pool.query("UPDATE v_b_tickets SET updated_at = NOW() WHERE id = $1", [ticketId]);
  return result.rows[0];
}
async function changeTicketStatus(ticketId, newStatus, userId, note) {
  const existing = await pool.query(`SELECT id, status, client_id, ticket_number, title
     FROM v_b_tickets WHERE id = $1 LIMIT 1`, [ticketId]);
  const ticket = existing.rows[0];
  if (!ticket) return null;
  const oldStatus = String(ticket.status || "").toLowerCase();
  const normalizedNewStatus = String(newStatus || "").toLowerCase();
  if (oldStatus === normalizedNewStatus) return ticket;
  const result = await pool.query(`UPDATE v_b_tickets
     SET status = $1::varchar,
         resolved_at = CASE WHEN $1::varchar = 'resolved' THEN COALESCE(resolved_at, NOW()) ELSE resolved_at END,
         closed_at = CASE WHEN $1::varchar = 'closed' THEN COALESCE(closed_at, NOW()) ELSE closed_at END,
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`, [normalizedNewStatus, ticketId]);
  await insertStatusHistory(ticketId, oldStatus, normalizedNewStatus, userId, note);
  await dispatchNotificationEvent({
    source: "tickets",
    element: normalizedNewStatus === "resolved" ? "resolved" : "updated",
    enterpriseId: String(ticket.client_id || ""),
    context: {
      ticket: result.rows[0],
      entreprise: {
        id: String(ticket.client_id || "")
      }
    }
  }).catch(() => {});
  await notifyInAppTicketStatusChanged({
    ticketId,
    newStatus: normalizedNewStatus,
    changedByUserId: userId || null
  }).catch(() => {});
  return result.rows[0];
}
export async function resolveTicketWithClientValidation({
  ticketId,
  userId,
  reason,
  interventionType = "",
  actionType = "",
  consumeSupportCredit = false,
  supportCreditDebits = null
}) {
  if (!(await hasResolutionValidationTable())) {
    const err = new Error("VALIDATION_UNAVAILABLE");
    throw err;
  }
  const trimmedReason = String(reason || "").trim();
  const trimmedIntervention = String(interventionType || "").trim();
  const trimmedAction = String(actionType || "").trim();
  if (!trimmedReason) {
    const err = new Error("REASON_REQUIRED");
    throw err;
  }
  if (!trimmedIntervention) {
    const err = new Error("INTERVENTION_TYPE_REQUIRED");
    throw err;
  }
  if (!trimmedAction) {
    const err = new Error("ACTION_TYPE_REQUIRED");
    throw err;
  }
  const ticketResult = await pool.query(`SELECT id, status, client_id, ticket_number, title
     FROM v_b_tickets WHERE id = $1 LIMIT 1`, [ticketId]);
  const ticket = ticketResult.rows[0];
  if (!ticket) return null;
  const status = String(ticket.status || "").toLowerCase();
  if (status === "closed") {
    const err = new Error("TICKET_ALREADY_CLOSED");
    throw err;
  }
  const existingValidation = await getTicketResolutionValidation(ticketId);
  if (existingValidation?.isPending) {
    const err = new Error("VALIDATION_ALREADY_PENDING");
    throw err;
  }
  if (status !== "resolved") {
    try {
      await handleTicketStatusCreditChange({
        ticketId,
        oldStatus: ticket.status,
        newStatus: "resolved",
        userId: userId || null,
        consumeSupportCredit: Boolean(consumeSupportCredit),
        supportCreditDebits: Array.isArray(supportCreditDebits) ? supportCreditDebits : null,
        refundSupportCredit: false
      });
    } catch (creditErr) {
      if (creditErr?.code === "INSUFFICIENT_SUPPORT_CREDITS") {
        creditErr.status = creditErr.status || 402;
        throw creditErr;
      }
      throw creditErr;
    }
  }
  const commentContent = `${RESOLUTION_COMMENT_PREFIX} [${trimmedIntervention}] [${trimmedAction}] ${trimmedReason}`;
  const comment = await addPublicComment(ticketId, userId, commentContent);
  if (status !== "resolved") {
    await pool.query(`UPDATE v_b_tickets
       SET status = 'resolved', resolved_at = COALESCE(resolved_at, NOW()), updated_at = NOW()
       WHERE id = $1`, [ticketId]);
    await insertStatusHistory(ticketId, ticket.status, "resolved", userId, "Resolution with client validation");
    await dispatchNotificationEvent({
      source: "tickets",
      element: "resolved",
      enterpriseId: String(ticket.client_id || ""),
      context: {
        ticket: {
          id: ticketId
        },
        entreprise: {
          id: String(ticket.client_id || "")
        }
      }
    }).catch(() => {});
    await notifyInAppTicketStatusChanged({
      ticketId,
      newStatus: "resolved",
      changedByUserId: userId || null
    }).catch(() => {});
  }
  const autoCloseAt = new Date(Date.now() + VALIDATION_AUTO_CLOSE_HOURS * 60 * 60 * 1000);
  const validationResult = await pool.query(`INSERT INTO v_b_ticket_resolution_validations
      (ticket_id, resolution_reason, intervention_type, action_type, resolution_comment_id,
       requested_at, auto_close_at, outcome, resolved_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6, 'pending', $7, NOW(), NOW())
     ON CONFLICT (ticket_id) DO UPDATE SET
       resolution_reason = EXCLUDED.resolution_reason,
       intervention_type = EXCLUDED.intervention_type,
       action_type = EXCLUDED.action_type,
       resolution_comment_id = EXCLUDED.resolution_comment_id,
       requested_at = NOW(),
       auto_close_at = EXCLUDED.auto_close_at,
       responded_at = NULL,
       outcome = 'pending',
       rejection_message = NULL,
       responded_by_user_id = NULL,
       resolved_by_user_id = EXCLUDED.resolved_by_user_id,
       updated_at = NOW()
     RETURNING id, ticket_id, resolution_reason, intervention_type, action_type,
               resolution_comment_id, requested_at, auto_close_at, responded_at, outcome,
               rejection_message, responded_by_user_id, resolved_by_user_id`, [ticketId, trimmedReason, trimmedIntervention, trimmedAction, comment?.id || null, autoCloseAt.toISOString(), userId || null]);
  return {
    ticket: {
      ...ticket,
      status: "resolved"
    },
    validation: mapValidationRow(validationResult.rows[0]),
    comment
  };
}
export async function submitPortalResolutionValidation({
  clientId,
  ticketId,
  userId,
  accepted,
  message = ""
}) {
  if (!(await hasResolutionValidationTable())) {
    const err = new Error("VALIDATION_UNAVAILABLE");
    throw err;
  }
  const ticketResult = await pool.query(`SELECT id, status, client_id, ticket_number, title
     FROM v_b_tickets
     WHERE id = $1 AND client_id = $2
     LIMIT 1`, [ticketId, clientId]);
  const ticket = ticketResult.rows[0];
  if (!ticket) return null;
  if (String(ticket.status || "").toLowerCase() !== "resolved") {
    const err = new Error("TICKET_NOT_AWAITING_VALIDATION");
    throw err;
  }
  const validation = await getTicketResolutionValidation(ticketId);
  if (!validation?.isPending) {
    const err = new Error("VALIDATION_NOT_PENDING");
    throw err;
  }
  const trimmedMessage = String(message || "").trim().slice(0, 2000);
  const now = new Date();
  if (accepted) {
    const acceptComment = trimmedMessage ? `${RESOLUTION_CLIENT_ACCEPT_PREFIX} ${trimmedMessage}` : `${RESOLUTION_CLIENT_ACCEPT_PREFIX} The client confirmed that the proposed solution meets their request.`;
    const db = await pool.connect();
    let closedTicket = null;
    try {
      await db.query("BEGIN");
      await db.query(`INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
         VALUES ($1, $2, $3, false, NOW())`, [ticketId, userId || null, acceptComment]);
      const lockedTicket = await db.query(`SELECT id, status, client_id, ticket_number, title
         FROM v_b_tickets
         WHERE id = $1
         FOR UPDATE`, [ticketId]);
      const currentTicket = lockedTicket.rows[0];
      if (!currentTicket) {
        const err = new Error("TICKET_NOT_FOUND");
        throw err;
      }
      const oldStatus = String(currentTicket.status || "").toLowerCase();
      const statusUpdate = await db.query(`UPDATE v_b_tickets
         SET status = 'closed',
             closed_at = COALESCE(closed_at, NOW()),
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, status, client_id, ticket_number, title`, [ticketId]);
      closedTicket = statusUpdate.rows[0];
      if (String(closedTicket?.status || "").toLowerCase() !== "closed") {
        const err = new Error("FAILED_TO_CLOSE_TICKET");
        throw err;
      }
      await db.query(`UPDATE v_b_ticket_resolution_validations
         SET outcome = 'accepted',
             responded_at = NOW(),
             responded_by_user_id = $2,
             rejection_message = NULL,
             updated_at = NOW()
         WHERE ticket_id = $1`, [ticketId, userId || null]);
      if (oldStatus !== "closed") {
        await db.query(`INSERT INTO v_b_ticket_status_history (ticket_id, old_status, new_status, changed_by, note, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`, [ticketId, oldStatus || null, "closed", userId || null, "Client validation — solution accepted"]);
      }
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
    await dispatchNotificationEvent({
      source: "tickets",
      element: "updated",
      enterpriseId: String(closedTicket?.client_id || ticket.client_id || ""),
      context: {
        ticket: closedTicket,
        entreprise: {
          id: String(closedTicket?.client_id || ticket.client_id || "")
        }
      }
    }).catch(() => {});
    await notifyInAppTicketStatusChanged({
      ticketId,
      newStatus: "closed",
      changedByUserId: userId || null
    }).catch(() => {});
    return {
      outcome: "accepted",
      status: "closed",
      validation: {
        ...validation,
        outcome: "accepted",
        isPending: false,
        respondedAt: now
      }
    };
  }
  const rejectionText = trimmedMessage || "The client reports that the issue is not resolved and requests further assistance.";
  await addPublicComment(ticketId, userId, `${RESOLUTION_CLIENT_REJECTION_PREFIX} ${rejectionText}`);
  await pool.query(`UPDATE v_b_ticket_resolution_validations
     SET outcome = 'rejected',
         responded_at = NOW(),
         responded_by_user_id = $2,
         rejection_message = $3,
         updated_at = NOW()
     WHERE ticket_id = $1`, [ticketId, userId || null, rejectionText]);
  await changeTicketStatus(ticketId, "in_progress", userId, "Client validation — solution rejected");
  return {
    outcome: "rejected",
    status: "in_progress",
    validation: {
      ...validation,
      outcome: "rejected",
      isPending: false,
      respondedAt: now,
      rejectionMessage: rejectionText
    }
  };
}
export async function autoCloseExpiredResolutionValidations() {
  if (!(await hasResolutionValidationTable())) {
    return {
      closed: 0
    };
  }
  const pendingResult = await pool.query(`SELECT v.ticket_id, v.auto_close_at, t.status, t.client_id
     FROM v_b_ticket_resolution_validations v
     JOIN v_b_tickets t ON t.id = v.ticket_id
     WHERE v.outcome = 'pending'
       AND v.auto_close_at <= NOW()
       AND t.status = 'resolved'`);
  let closed = 0;
  for (const row of pendingResult.rows) {
    try {
      await addPublicComment(row.ticket_id, null, `${RESOLUTION_AUTO_CLOSE_PREFIX} The ticket was closed automatically because the client did not respond within ${VALIDATION_AUTO_CLOSE_HOURS} hours.`);
      await pool.query(`UPDATE v_b_ticket_resolution_validations
         SET outcome = 'auto_closed', responded_at = NOW(), updated_at = NOW()
         WHERE ticket_id = $1 AND outcome = 'pending'`, [row.ticket_id]);
      await changeTicketStatus(row.ticket_id, "closed", null, "Automatic closure — client validation expired (48 h)");
      closed += 1;
    } catch (err) {
      console.error(`[resolution-validation] Auto-close ticket ${row.ticket_id}:`, err.message);
    }
  }
  return {
    closed
  };
}
