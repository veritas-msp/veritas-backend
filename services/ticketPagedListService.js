import { appendCommunityTicketFilters } from "../utils/ticketEditionGuard.js";
import {
  appendSearchWhere,
  appendStatusFilterWhere,
  appendTypeFilterWhere,
  buildOrderBySql,
  buildViewRulesWhere,
} from "./ticketViewSql.js";

const FIRST_TAKEOVER_AT_SQL = `(SELECT h.created_at
           FROM v_b_ticket_status_history h
           WHERE h.ticket_id = t.id
             AND LOWER(COALESCE(h.old_status, '')) IN ('new', 'open', '')
             AND LOWER(COALESCE(h.new_status, '')) NOT IN ('new', 'open', '')
           ORDER BY h.created_at ASC
           LIMIT 1) AS first_takeover_at`;

export const TICKET_SEARCH_MAX_LIMIT = 100;

let schemaCache = null;
let schemaCacheExpiresAt = 0;
const SCHEMA_CACHE_TTL_MS = 30_000;

async function columnExists(pool, tableName, columnName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.oid = to_regclass($1)
         AND a.attname = $2
         AND a.attnum > 0
         AND NOT a.attisdropped
     ) AS has_column`,
    [tableName, columnName]
  );
  return Boolean(result.rows?.[0]?.has_column);
}

async function tableExists(pool, tableName) {
  const result = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS has_table`, [tableName]);
  return Boolean(result.rows?.[0]?.has_table);
}

export async function resolveTicketListSchema(pool, { isCommunityEdition = () => false } = {}) {
  const now = Date.now();
  if (schemaCache && schemaCacheExpiresAt > now) {
    return schemaCache;
  }

  const [
    hasRequesterContact,
    hasTicketAssignees,
    hasSlaInfo,
    hasMajorIncident,
    hasDeletedAt,
    hasIsDeleted,
  ] = await Promise.all([
    columnExists(pool, "v_b_tickets", "requester_contact_id"),
    tableExists(pool, "v_b_ticket_assignees"),
    columnExists(pool, "v_b_tickets", "sla_info"),
    columnExists(pool, "v_b_tickets", "is_major_incident"),
    columnExists(pool, "v_b_tickets", "deleted_at"),
    columnExists(pool, "v_b_tickets", "is_deleted"),
  ]);

  schemaCache = {
    hasRequesterContact,
    hasTicketAssignees,
    hasSlaInfo,
    hasMajorIncident,
    hasDeletedAt,
    hasIsDeleted,
    isCommunity: Boolean(isCommunityEdition()),
  };
  schemaCacheExpiresAt = now + SCHEMA_CACHE_TTL_MS;
  return schemaCache;
}

function appendLifecycleFilters(where, { viewMode, hasDeletedAt, hasIsDeleted }) {
  if (viewMode === "trash") {
    if (hasDeletedAt) {
      where.push("t.deleted_at IS NOT NULL");
    } else if (hasIsDeleted) {
      where.push("COALESCE(t.is_deleted, FALSE) = TRUE");
    } else {
      where.push("1 = 0");
    }
    return;
  }

  if (hasDeletedAt) {
    where.push("t.deleted_at IS NULL");
  } else if (hasIsDeleted) {
    where.push("COALESCE(t.is_deleted, FALSE) = FALSE");
  }
}

export function buildTicketListWhere({
  viewRules = null,
  viewMode = "active",
  status = "",
  ticketType = "",
  search = "",
  schema = {},
} = {}) {
  const values = [];
  const where = [];
  const ctx = {
    hasRequesterContact: Boolean(schema.hasRequesterContact),
    hasTicketAssignees: Boolean(schema.hasTicketAssignees),
  };

  appendLifecycleFilters(where, {
    viewMode,
    hasDeletedAt: schema.hasDeletedAt,
    hasIsDeleted: schema.hasIsDeleted,
  });

  if (schema.isCommunity) {
    appendCommunityTicketFilters(where);
  }

  const viewWhere = buildViewRulesWhere(viewRules, values, ctx);
  if (viewWhere) where.push(`(${viewWhere})`);

  appendStatusFilterWhere(status, where, values);
  appendTypeFilterWhere(ticketType, where, values);
  appendSearchWhere(search, where, values, ctx);

  return {
    whereSql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    values,
    ctx,
  };
}

function buildTicketListSelectSql(schema) {
  const {
    hasRequesterContact,
    hasTicketAssignees,
    hasSlaInfo,
    hasMajorIncident,
  } = schema;

  return `SELECT
          t.id,
          t.ticket_number,
          t.title,
          t.description,
          t.status,
          t.priority,
          t.type,
          t.category,
          t.channel,
          t.client_id,
          ${hasRequesterContact ? "t.requester_contact_id," : ""}
          t.requester_user_id,
          t.assigned_user_id,
          t.created_at,
          t.updated_at,
          t.resolved_at,
          ${hasSlaInfo ? "t.sla_info," : ""}
          c.contrat AS client_contrat,
          ${FIRST_TAKEOVER_AT_SQL},
          ${hasSlaInfo ? `(SELECT MIN(cm.created_at) FROM v_b_ticket_comments cm WHERE cm.ticket_id = t.id AND COALESCE(cm.is_internal, FALSE) = FALSE) AS first_public_comment_at,` : ""}
          ${hasMajorIncident ? "t.is_major_incident," : ""}
          c.name AS client_name,
          c.name AS client_nom,
          req_u.email AS requester_email,
          ass_u.email AS assigned_email,
          COALESCE(
            (
              SELECT json_agg(
                json_build_object(
                  'user_id', w.user_id,
                  'created_at', w.created_at
                )
                ORDER BY w.created_at ASC
              )
              FROM v_b_ticket_watchers w
              WHERE w.ticket_id = t.id
            ),
            '[]'::json
          ) AS watchers,
          ${
            hasTicketAssignees
              ? `COALESCE(
            (
              SELECT json_agg(
                json_build_object(
                  'user_id', a.user_id,
                  'created_at', a.created_at
                )
                ORDER BY a.created_at ASC
              )
              FROM v_b_ticket_assignees a
              WHERE a.ticket_id = t.id
            ),
            '[]'::json
          ) AS assignees,`
              : "'[]'::json AS assignees,"
          }
          COALESCE((SELECT COUNT(*) FROM v_b_ticket_watchers w2 WHERE w2.ticket_id = t.id), 0) AS followers_count,
          ${
            hasTicketAssignees
              ? "COALESCE((SELECT COUNT(*) FROM v_b_ticket_assignees a2 WHERE a2.ticket_id = t.id), 0) AS assignees_count,"
              : "0 AS assignees_count,"
          }
          (SELECT COUNT(*) FROM v_b_ticket_comments cm WHERE cm.ticket_id = t.id) AS comments_count
         FROM v_b_tickets t
         LEFT JOIN v_b_clients c ON c.id = t.client_id
         LEFT JOIN v_b_users req_u ON req_u.id = t.requester_user_id
         LEFT JOIN v_b_users ass_u ON ass_u.id = t.assigned_user_id`;
}

export async function countTickets(pool, filterOptions, schema) {
  const { whereSql, values } = buildTicketListWhere({ ...filterOptions, schema });
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM v_b_tickets t
     LEFT JOIN v_b_clients c ON c.id = t.client_id
     LEFT JOIN v_b_users req_u ON req_u.id = t.requester_user_id
     LEFT JOIN v_b_users ass_u ON ass_u.id = t.assigned_user_id
     ${whereSql}`,
    values
  );
  return Number(result.rows?.[0]?.total || 0);
}

export async function countTicketsByStatus(pool, filterOptions, schema) {
  const { whereSql, values } = buildTicketListWhere({ ...filterOptions, schema });
  const result = await pool.query(
    `SELECT
       CASE WHEN t.status = 'open' THEN 'new' ELSE t.status END AS status_key,
       COUNT(*)::int AS count
     FROM v_b_tickets t
     LEFT JOIN v_b_clients c ON c.id = t.client_id
     LEFT JOIN v_b_users req_u ON req_u.id = t.requester_user_id
     LEFT JOIN v_b_users ass_u ON ass_u.id = t.assigned_user_id
     ${whereSql}
     GROUP BY 1`,
    values
  );

  const counts = { new: 0, in_progress: 0, pending: 0, resolved: 0, closed: 0 };
  for (const row of result.rows || []) {
    const key = String(row.status_key || "").trim();
    if (counts[key] !== undefined) counts[key] = Number(row.count || 0);
  }
  return counts;
}

export async function searchTicketsPaged(
  pool,
  {
    viewRules = null,
    viewMode = "active",
    status = "",
    ticketType = "",
    search = "",
    sortBy = "updated_at",
    sortDirection = "desc",
    limit = 25,
    offset = 0,
  },
  schema
) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), TICKET_SEARCH_MAX_LIMIT);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const { whereSql, values, ctx } = buildTicketListWhere({
    viewRules,
    viewMode,
    status,
    ticketType,
    search,
    schema,
  });

  const orderBySql = buildOrderBySql(sortBy, sortDirection, ctx);
  const listValues = [...values, safeLimit, safeOffset];
  const limitParam = `$${listValues.length - 1}`;
  const offsetParam = `$${listValues.length}`;

  const [listResult, total] = await Promise.all([
    pool.query(
      `${buildTicketListSelectSql(schema)}
       ${whereSql}
       ORDER BY ${orderBySql}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      listValues
    ),
    countTickets(pool, { viewRules, viewMode, status, ticketType, search }, schema),
  ]);

  return {
    items: listResult.rows || [],
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}
