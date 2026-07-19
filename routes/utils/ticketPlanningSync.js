import { pool } from "../../database/db.js";
import { resolveEventsSchema } from "../../services/ensureEventsSchema.js";

export async function resolveClientIdFromRequesterContact(contactId) {
  if (!contactId) return null;
  const { rows } = await pool.query(
    "SELECT client_id FROM v_b_contacts WHERE id = $1 LIMIT 1",
    [contactId]
  );
  const clientId = rows[0]?.client_id;
  return clientId != null ? Number(clientId) : null;
}

/** Aligns planning reminder client_id with ticket support. */
export async function syncTicketPlanningEventClient(ticketId, clientId) {
  if (!ticketId) return 0;
  const schema = await resolveEventsSchema();
  if (!schema.hasTicketId) return 0;
  const { rowCount } = await pool.query(
    `UPDATE v_b_events
     SET client_id = $1, updated_at = NOW()
     WHERE ticket_id = $2`,
    [clientId ?? null, ticketId]
  );
  return rowCount;
}

export function shouldSyncTicketPlanningEvents(body, oldTicket, updatedTicket) {
  if (!updatedTicket?.id) return false;
  if (Object.prototype.hasOwnProperty.call(body, "requesterContactId")) return true;
  if (Object.prototype.hasOwnProperty.call(body, "clientId")) return true;
  if (Object.prototype.hasOwnProperty.call(body, "requesterUserId")) return true;
  return (
    String(oldTicket?.client_id ?? "") !== String(updatedTicket?.client_id ?? "") ||
    String(oldTicket?.requester_contact_id ?? "") !==
      String(updatedTicket?.requester_contact_id ?? "")
  );
}
