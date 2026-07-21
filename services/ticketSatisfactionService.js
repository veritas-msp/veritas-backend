import { pool } from "../database/db.js";
import { notifyInAppTicketSatisfaction } from "./userNotificationService.js";
import { getTicketResolutionValidation } from "./ticketResolutionValidationService.js";
import { TICKET_SATISFACTION_CRITERIA, computeSatisfactionAverage, normalizeSatisfactionRatingsInput, resolveStoredRatings } from "./ticketSatisfactionCriteria.js";
let satisfactionTableExistsCache = null;
export async function hasSatisfactionTable() {
  if (satisfactionTableExistsCache !== null) return satisfactionTableExistsCache;
  const result = await pool.query(`SELECT to_regclass('v_b_ticket_satisfaction') IS NOT NULL AS has_table`);
  satisfactionTableExistsCache = Boolean(result.rows?.[0]?.has_table);
  return satisfactionTableExistsCache;
}
async function hasRatingsColumn() {
  const result = await pool.query(`SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'v_b_ticket_satisfaction'
       AND column_name = 'ratings'
     LIMIT 1`);
  return result.rows.length > 0;
}
function mapSatisfactionRow(row, authorProfile = null) {
  if (!row) return null;
  const ratings = resolveStoredRatings(row);
  const overallRating = ratings?.overall ?? (Number(row.rating) || 0);
  return {
    id: row.id,
    ticketId: row.ticket_id,
    rating: overallRating,
    ratings,
    averageRating: computeSatisfactionAverage(ratings),
    message: row.message || "",
    authorUserId: row.author_user_id || null,
    authorName: authorProfile?.display_name || row.author_name || "Client",
    createdAt: row.created_at,
    criteria: TICKET_SATISFACTION_CRITERIA
  };
}
export async function getTicketSatisfaction(ticketId) {
  if (!(await hasSatisfactionTable())) return null;
  const ratingsSelect = (await hasRatingsColumn()) ? "s.ratings," : "NULL AS ratings,";
  const result = await pool.query(`SELECT s.id,
            s.ticket_id,
            s.rating,
            ${ratingsSelect}
            s.message,
            s.author_user_id,
            s.created_at,
            COALESCE(NULLIF(TRIM(u.username), ''), u.email, 'Client') AS author_name
     FROM v_b_ticket_satisfaction s
     LEFT JOIN v_b_users u ON u.id = s.author_user_id
     WHERE s.ticket_id = $1
     LIMIT 1`, [ticketId]);
  return mapSatisfactionRow(result.rows[0] || null);
}
export async function getTicketSatisfactionsByTicketIds(ticketIds = []) {
  if (!(await hasSatisfactionTable())) return new Map();
  const ids = [...new Set((ticketIds || []).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const ratingsSelect = (await hasRatingsColumn()) ? "s.ratings," : "NULL AS ratings,";
  const result = await pool.query(`SELECT s.id,
            s.ticket_id,
            s.rating,
            ${ratingsSelect}
            s.message,
            s.author_user_id,
            s.created_at,
            COALESCE(NULLIF(TRIM(u.username), ''), u.email, 'Client') AS author_name
     FROM v_b_ticket_satisfaction s
     LEFT JOIN v_b_users u ON u.id = s.author_user_id
     WHERE s.ticket_id = ANY($1::uuid[])`, [ids]);
  const map = new Map();
  for (const row of result.rows) {
    const mapped = mapSatisfactionRow(row);
    if (mapped) map.set(String(row.ticket_id), mapped);
  }
  return map;
}
export async function enrichTicketRowsWithSatisfaction(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const satisfactionByTicketId = await getTicketSatisfactionsByTicketIds(rows.map(row => row.id));
  if (satisfactionByTicketId.size === 0) return rows;
  return rows.map(row => {
    const satisfaction = satisfactionByTicketId.get(String(row.id));
    return satisfaction ? {
      ...row,
      satisfaction
    } : row;
  });
}
const CLOSED_STATUSES = new Set(["resolved", "closed"]);
export async function submitPortalTicketSatisfaction({
  clientId,
  ticketId,
  userId,
  ratings,
  rating,
  message = ""
}) {
  if (!(await hasSatisfactionTable())) {
    const err = new Error("SATISFACTION_UNAVAILABLE");
    throw err;
  }
  const normalizedRatings = normalizeSatisfactionRatingsInput(ratings) || (Number.isInteger(Number(rating)) && Number(rating) >= 1 && Number(rating) <= 5 ? normalizeSatisfactionRatingsInput(Object.fromEntries(TICKET_SATISFACTION_CRITERIA.map(({
    key
  }) => [key, Number(rating)]))) : null);
  if (!normalizedRatings) {
    const err = new Error("INVALID_RATINGS");
    throw err;
  }
  const overallRating = normalizedRatings.overall;
  const trimmedMessage = String(message || "").trim().slice(0, 2000);
  const ticketResult = await pool.query(`SELECT id, client_id, status, ticket_number, title, assigned_user_id
     FROM v_b_tickets
     WHERE id = $1 AND client_id = $2
     LIMIT 1`, [ticketId, clientId]);
  const ticket = ticketResult.rows[0];
  if (!ticket) return null;
  if (!CLOSED_STATUSES.has(String(ticket.status || "").toLowerCase())) {
    const err = new Error("TICKET_NOT_CLOSED");
    throw err;
  }
  const pendingValidation = await getTicketResolutionValidation(ticketId);
  if (pendingValidation?.isPending) {
    const err = new Error("VALIDATION_PENDING");
    throw err;
  }
  const existing = await pool.query(`SELECT id FROM v_b_ticket_satisfaction WHERE ticket_id = $1 LIMIT 1`, [ticketId]);
  if (existing.rows.length > 0) {
    const err = new Error("ALREADY_SUBMITTED");
    throw err;
  }
  const ratingsColumnExists = await hasRatingsColumn();
  const insertResult = ratingsColumnExists ? await pool.query(`INSERT INTO v_b_ticket_satisfaction (ticket_id, rating, ratings, message, author_user_id, created_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, NOW())
         RETURNING id, ticket_id, rating, ratings, message, author_user_id, created_at`, [ticketId, overallRating, JSON.stringify(normalizedRatings), trimmedMessage || null, userId || null]) : await pool.query(`INSERT INTO v_b_ticket_satisfaction (ticket_id, rating, message, author_user_id, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id, ticket_id, rating, message, author_user_id, created_at`, [ticketId, overallRating, trimmedMessage || null, userId || null]);
  const created = insertResult.rows[0];
  const authorResult = userId ? await pool.query(`SELECT COALESCE(NULLIF(TRIM(username), ''), email, 'Client') AS display_name
         FROM v_b_users WHERE id = $1 LIMIT 1`, [userId]) : {
    rows: []
  };
  const satisfaction = mapSatisfactionRow(created, {
    display_name: authorResult.rows[0]?.display_name || "Client"
  });
  await notifyInAppTicketSatisfaction({
    ticketId,
    rating: overallRating,
    ratings: normalizedRatings,
    averageRating: satisfaction.averageRating,
    message: trimmedMessage,
    authorUserId: userId || null,
    authorName: satisfaction.authorName
  }).catch(() => {});
  return satisfaction;
}
export async function updatePortalTicketSatisfaction({
  clientId,
  ticketId,
  userId,
  ratings,
  rating,
  message = ""
}) {
  if (!(await hasSatisfactionTable())) {
    const err = new Error("SATISFACTION_UNAVAILABLE");
    throw err;
  }
  const normalizedRatings = normalizeSatisfactionRatingsInput(ratings) || (Number.isInteger(Number(rating)) && Number(rating) >= 1 && Number(rating) <= 5 ? normalizeSatisfactionRatingsInput(Object.fromEntries(TICKET_SATISFACTION_CRITERIA.map(({
    key
  }) => [key, Number(rating)]))) : null);
  if (!normalizedRatings) {
    const err = new Error("INVALID_RATINGS");
    throw err;
  }
  const overallRating = normalizedRatings.overall;
  const trimmedMessage = String(message || "").trim().slice(0, 2000);
  const ticketResult = await pool.query(`SELECT id, client_id, status
     FROM v_b_tickets
     WHERE id = $1 AND client_id = $2
     LIMIT 1`, [ticketId, clientId]);
  const ticket = ticketResult.rows[0];
  if (!ticket) return null;
  if (!CLOSED_STATUSES.has(String(ticket.status || "").toLowerCase())) {
    const err = new Error("TICKET_NOT_CLOSED");
    throw err;
  }
  const pendingValidation = await getTicketResolutionValidation(ticketId);
  if (pendingValidation?.isPending) {
    const err = new Error("VALIDATION_PENDING");
    throw err;
  }
  const existingResult = await pool.query(`SELECT id, author_user_id
     FROM v_b_ticket_satisfaction
     WHERE ticket_id = $1
     LIMIT 1`, [ticketId]);
  const existing = existingResult.rows[0];
  if (!existing) {
    const err = new Error("NOT_FOUND");
    throw err;
  }
  if (existing.author_user_id && userId && String(existing.author_user_id) !== String(userId)) {
    const err = new Error("NOT_AUTHOR");
    throw err;
  }
  const ratingsColumnExists = await hasRatingsColumn();
  const updateResult = ratingsColumnExists ? await pool.query(`UPDATE v_b_ticket_satisfaction
         SET rating = $2,
             ratings = $3::jsonb,
             message = $4,
             author_user_id = COALESCE(author_user_id, $5)
         WHERE ticket_id = $1
         RETURNING id, ticket_id, rating, ratings, message, author_user_id, created_at`, [ticketId, overallRating, JSON.stringify(normalizedRatings), trimmedMessage || null, userId || null]) : await pool.query(`UPDATE v_b_ticket_satisfaction
         SET rating = $2,
             message = $3,
             author_user_id = COALESCE(author_user_id, $4)
         WHERE ticket_id = $1
         RETURNING id, ticket_id, rating, message, author_user_id, created_at`, [ticketId, overallRating, trimmedMessage || null, userId || null]);
  const updated = updateResult.rows[0];
  const authorResult = userId ? await pool.query(`SELECT COALESCE(NULLIF(TRIM(username), ''), email, 'Client') AS display_name
         FROM v_b_users WHERE id = $1 LIMIT 1`, [userId]) : {
    rows: []
  };
  return mapSatisfactionRow(updated, {
    display_name: authorResult.rows[0]?.display_name || "Client"
  });
}
export { TICKET_SATISFACTION_CRITERIA };
let assigneesTableExistsCache = null;
async function hasAssigneesTable() {
  if (assigneesTableExistsCache !== null) return assigneesTableExistsCache;
  const result = await pool.query(`SELECT to_regclass('v_b_ticket_assignees') IS NOT NULL AS has_table`);
  assigneesTableExistsCache = Boolean(result.rows?.[0]?.has_table);
  return assigneesTableExistsCache;
}
async function hasTicketSoftDeleteColumns() {
  const result = await pool.query(`SELECT
       EXISTS (
         SELECT 1 FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.oid = to_regclass('v_b_tickets')
           AND a.attname = 'deleted_at' AND a.attnum > 0 AND NOT a.attisdropped
       ) AS has_deleted_at,
       EXISTS (
         SELECT 1 FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.oid = to_regclass('v_b_tickets')
           AND a.attname = 'is_deleted' AND a.attnum > 0 AND NOT a.attisdropped
       ) AS has_is_deleted`);
  return {
    hasDeletedAt: Boolean(result.rows?.[0]?.has_deleted_at),
    hasIsDeleted: Boolean(result.rows?.[0]?.has_is_deleted)
  };
}
function buildSatisfactionListWhere({
  userId,
  scope,
  search,
  sentiment,
  communityFilter = false,
  hasAssignees = false
}) {
  const params = [];
  const where = ["1=1"];
  if (communityFilter) {
    where.push(`NOT (LOWER(t.type) = 'demande' AND (t.category LIKE 'prestation-%' OR t.category LIKE 'installation-%'))`);
  }
  if (scope === "mine" && userId) {
    params.push(userId);
    const userParam = `$${params.length}`;
    if (hasAssignees) {
      where.push(`(t.assigned_user_id = ${userParam}::uuid OR EXISTS (
           SELECT 1 FROM v_b_ticket_assignees a
           WHERE a.ticket_id = t.id AND a.user_id = ${userParam}::uuid
         ))`);
    } else {
      where.push(`t.assigned_user_id = ${userParam}::uuid`);
    }
  }
  if (search) {
    params.push(`%${String(search).trim()}%`);
    const p = `$${params.length}`;
    where.push(`(t.title ILIKE ${p} OR CAST(t.ticket_number AS TEXT) ILIKE ${p} OR s.message ILIKE ${p} OR c.name ILIKE ${p})`);
  }
  if (sentiment === "positive") {
    where.push("s.rating >= 4");
  } else if (sentiment === "negative") {
    where.push("s.rating <= 2");
  } else if (sentiment === "neutral") {
    where.push("s.rating = 3");
  }
  return {
    where,
    params
  };
}
async function applySoftDeleteClauses(where, params, alias = "t") {
  const {
    hasDeletedAt,
    hasIsDeleted
  } = await hasTicketSoftDeleteColumns();
  if (hasDeletedAt) where.push(`${alias}.deleted_at IS NULL`);
  if (hasIsDeleted) where.push(`COALESCE(${alias}.is_deleted, false) = false`);
}
function mapSatisfactionListRow(row, assignees = []) {
  const satisfaction = mapSatisfactionRow(row, {
    display_name: row.author_name
  });
  return {
    ...satisfaction,
    ticket: {
      id: row.ticket_id,
      ticketNumber: row.ticket_number,
      title: row.title || "",
      status: row.status === "open" ? "new" : row.status,
      priority: row.priority || "normal",
      clientId: row.client_id ?? null,
      clientName: row.client_name || "",
      assignedUserId: row.assigned_user_id || null,
      assignedUserName: row.assigned_user_name || ""
    },
    assignees
  };
}
export async function countTicketSatisfactions({
  userId,
  scope = "mine",
  search = "",
  sentiment = "",
  communityFilter = false
} = {}) {
  if (!(await hasSatisfactionTable())) return 0;
  const hasAssignees = await hasAssigneesTable();
  const {
    where,
    params
  } = buildSatisfactionListWhere({
    userId,
    scope,
    search,
    sentiment,
    communityFilter,
    hasAssignees
  });
  await applySoftDeleteClauses(where, params);
  const {
    rows
  } = await pool.query(`SELECT COUNT(*)::int AS total
     FROM v_b_ticket_satisfaction s
     INNER JOIN v_b_tickets t ON t.id = s.ticket_id
     LEFT JOIN v_b_clients c ON c.id = t.client_id
     WHERE ${where.join(" AND ")}`, params);
  return Number(rows[0]?.total) || 0;
}
export async function listTicketSatisfactions({
  userId,
  scope = "mine",
  search = "",
  sentiment = "",
  sortBy = "created_at",
  sortDirection = "desc",
  limit = 25,
  offset = 0,
  communityFilter = false
} = {}) {
  if (!(await hasSatisfactionTable())) {
    return {
      items: [],
      total: 0,
      limit,
      offset
    };
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const direction = String(sortDirection).toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortColumn = sortBy === "rating" ? "s.rating" : sortBy === "ticket_number" ? "t.ticket_number" : sortBy === "updated_at" ? "t.updated_at" : "s.created_at";
  const hasAssignees = await hasAssigneesTable();
  const {
    where,
    params
  } = buildSatisfactionListWhere({
    userId,
    scope,
    search,
    sentiment,
    communityFilter,
    hasAssignees
  });
  await applySoftDeleteClauses(where, params);
  const ratingsSelect = (await hasRatingsColumn()) ? "s.ratings," : "NULL AS ratings,";
  const countParams = [...params];
  const listParams = [...params, safeLimit, safeOffset];
  const baseFrom = `
    FROM v_b_ticket_satisfaction s
    INNER JOIN v_b_tickets t ON t.id = s.ticket_id
    LEFT JOIN v_b_clients c ON c.id = t.client_id
    LEFT JOIN v_b_users author_u ON author_u.id = s.author_user_id
    LEFT JOIN v_b_users assigned_u ON assigned_u.id = t.assigned_user_id`;
  const [{
    rows: countRows
  }, {
    rows
  }] = await Promise.all([pool.query(`SELECT COUNT(*)::int AS total ${baseFrom} WHERE ${where.join(" AND ")}`, countParams), pool.query(`SELECT s.id,
              s.ticket_id,
              s.rating,
              ${ratingsSelect}
              s.message,
              s.author_user_id,
              s.created_at,
              t.ticket_number,
              t.title,
              t.status,
              t.priority,
              t.client_id,
              t.assigned_user_id,
              t.updated_at,
              c.name AS client_name,
              COALESCE(NULLIF(TRIM(author_u.username), ''), author_u.email, 'Client') AS author_name,
              COALESCE(NULLIF(TRIM(assigned_u.username), ''), assigned_u.email, '') AS assigned_user_name
       ${baseFrom}
       WHERE ${where.join(" AND ")}
       ORDER BY ${sortColumn} ${direction} NULLS LAST, s.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams)]);
  const ticketIds = rows.map(row => row.ticket_id).filter(Boolean);
  const assigneesByTicket = new Map();
  if (ticketIds.length > 0 && (await hasAssigneesTable())) {
    const assigneeResult = await pool.query(`SELECT a.ticket_id,
              a.user_id,
              COALESCE(NULLIF(TRIM(u.username), ''), u.email, '') AS name
       FROM v_b_ticket_assignees a
       LEFT JOIN v_b_users u ON u.id = a.user_id
       WHERE a.ticket_id = ANY($1::uuid[])
       ORDER BY a.created_at ASC`, [ticketIds]);
    assigneeResult.rows.forEach(row => {
      const key = String(row.ticket_id);
      if (!assigneesByTicket.has(key)) assigneesByTicket.set(key, []);
      assigneesByTicket.get(key).push({
        userId: row.user_id,
        name: row.name || ""
      });
    });
  }
  const items = rows.map(row => mapSatisfactionListRow(row, assigneesByTicket.get(String(row.ticket_id)) || []));
  return {
    items,
    total: Number(countRows[0]?.total) || 0,
    limit: safeLimit,
    offset: safeOffset
  };
}
