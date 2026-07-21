import { isCommunity } from "./edition.js";
import { isSalesTicket } from "../services/supportCredits.js";
export const COMMUNITY_SALES_TICKET_SQL = `NOT (LOWER(t.type) = 'demande' AND (t.category LIKE 'prestation-%' OR t.category LIKE 'installation-%'))`;
export const COMMUNITY_SALES_TICKET_SQL_PLAIN = `NOT (LOWER(type) = 'demande' AND (category LIKE 'prestation-%' OR category LIKE 'installation-%'))`;
export function appendCommunityTicketFilters(where) {
  if (!isCommunity()) return;
  where.push(COMMUNITY_SALES_TICKET_SQL);
}
export function sendProSalesTicketError(res) {
  return res.status(403).json({
    error: "Service and installation ticketing is reserved for Veritas Pro",
    code: "PRO_FEATURE_REQUIRED"
  });
}
export function rejectCommunitySalesTicketCreate(req, res) {
  if (!isCommunity()) return false;
  if (req.body?.salesFormData) {
    sendProSalesTicketError(res);
    return true;
  }
  const type = req.body?.type ?? "incident";
  const category = req.body?.category ?? "";
  if (isSalesTicket(type, category)) {
    sendProSalesTicketError(res);
    return true;
  }
  return false;
}
export function rejectCommunitySalesTicketUpdate(req, res, existingTicket) {
  if (!isCommunity()) return false;
  const nextType = Object.prototype.hasOwnProperty.call(req.body, "type") ? req.body.type : existingTicket?.type;
  const nextCategory = Object.prototype.hasOwnProperty.call(req.body, "category") ? req.body.category : existingTicket?.category;
  if (isSalesTicket(existingTicket?.type, existingTicket?.category) || isSalesTicket(nextType, nextCategory)) {
    sendProSalesTicketError(res);
    return true;
  }
  return false;
}
export function isSalesTicketRow(ticket) {
  return isSalesTicket(ticket?.type, ticket?.category);
}
