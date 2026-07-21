import { normalizeRules } from "./ticketViewRules.js";
function parseListValue(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim().toLowerCase()).filter(Boolean);
  }
  return String(value || "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
}
function pushParam(values, value) {
  values.push(value);
  return `$${values.length}`;
}
function buildAssignedExpr(ctx) {
  const primaryAssignee = `LOWER(TRIM(COALESCE(ass_u.email, '') || ' ' || COALESCE(ass_u.username, '')))`;
  if (ctx.hasTicketAssignees) {
    return `LOWER(TRIM(${primaryAssignee} || ' ' || COALESCE((
      SELECT STRING_AGG(LOWER(TRIM(COALESCE(u.email, '') || ' ' || COALESCE(u.username, ''))), ' ')
      FROM v_b_ticket_assignees a
      JOIN v_b_users u ON u.id = a.user_id
      WHERE a.ticket_id = t.id
    ), '')))`;
  }
  return primaryAssignee;
}
function normalizeStatusCriterionValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "open") return "new";
  return normalized;
}
function expandStatusList(list) {
  const expanded = new Set();
  for (const item of list) {
    const normalized = normalizeStatusCriterionValue(item);
    expanded.add(normalized);
    if (normalized === "new") {
      expanded.add("open");
    }
  }
  return [...expanded];
}
function buildTagsExistsSql(extraCondition = "") {
  return `EXISTS (
    SELECT 1
    FROM v_b_ticket_tag_links tl
    JOIN v_b_ticket_tags tg ON tg.id = tl.tag_id
    WHERE tl.ticket_id = t.id
    ${extraCondition ? `AND ${extraCondition}` : ""}
  )`;
}
function buildTagsCriterionSql(operator, criterion, values) {
  const noTagsSql = `NOT EXISTS (
    SELECT 1 FROM v_b_ticket_tag_links tl WHERE tl.ticket_id = t.id
  )`;
  const hasTagsSql = `EXISTS (
    SELECT 1 FROM v_b_ticket_tag_links tl WHERE tl.ticket_id = t.id
  )`;
  if (operator === "is_empty") return noTagsSql;
  if (operator === "is_not_empty") return hasTagsSql;
  if (operator === "in" || operator === "not_in") {
    const list = parseListValue(criterion?.value);
    if (list.length === 0) {
      return operator === "in" ? "FALSE" : "TRUE";
    }
    const params = list.map(item => pushParam(values, item));
    const clause = buildTagsExistsSql(`LOWER(TRIM(tg.label)) IN (${params.join(", ")})`);
    return operator === "not_in" ? `NOT (${clause})` : clause;
  }
  const expected = String(criterion?.value ?? "").trim().toLowerCase();
  if (!expected) return "FALSE";
  const param = pushParam(values, expected);
  if (operator === "equals") {
    return buildTagsExistsSql(`LOWER(TRIM(tg.label)) = ${param}`);
  }
  if (operator === "not_equals") {
    return `NOT (${buildTagsExistsSql(`LOWER(TRIM(tg.label)) = ${param}`)})`;
  }
  if (operator === "starts_with") {
    return buildTagsExistsSql(`LOWER(TRIM(tg.label)) LIKE ${param} || '%'`);
  }
  if (operator === "ends_with") {
    return buildTagsExistsSql(`LOWER(TRIM(tg.label)) LIKE '%' || ${param}`);
  }
  if (operator === "not_contains") {
    return `NOT (${buildTagsExistsSql(`LOWER(TRIM(tg.label)) LIKE '%' || ${param} || '%'`)})`;
  }
  return buildTagsExistsSql(`LOWER(TRIM(tg.label)) LIKE '%' || ${param} || '%'`);
}
function buildAssignedUserIdCriterionSql(operator, criterion, values, ctx) {
  const rawValues = operator === "in" || operator === "not_in" ? parseListValue(criterion?.value) : [String(criterion?.value ?? "").trim()].filter(Boolean);
  if (rawValues.length === 0) {
    if (operator === "in") return "FALSE";
    if (operator === "not_in") return "TRUE";
    return "FALSE";
  }
  const normalizedValues = rawValues.map(value => String(value).trim().toLowerCase());
  if (operator === "equals") {
    const param = pushParam(values, normalizedValues[0]);
    if (ctx.hasTicketAssignees) {
      return `(LOWER(t.assigned_user_id::text) = ${param} OR EXISTS (
        SELECT 1 FROM v_b_ticket_assignees a
        WHERE a.ticket_id = t.id AND LOWER(a.user_id::text) = ${param}
      ))`;
    }
    return `(LOWER(t.assigned_user_id::text) = ${param})`;
  }
  if (operator === "not_equals") {
    const param = pushParam(values, normalizedValues[0]);
    if (ctx.hasTicketAssignees) {
      return `(LOWER(COALESCE(t.assigned_user_id::text, '')) <> ${param} AND NOT EXISTS (
        SELECT 1 FROM v_b_ticket_assignees a
        WHERE a.ticket_id = t.id AND LOWER(a.user_id::text) = ${param}
      ))`;
    }
    return `(LOWER(COALESCE(t.assigned_user_id::text, '')) <> ${param})`;
  }
  if (operator === "in") {
    const params = normalizedValues.map(value => pushParam(values, value));
    if (ctx.hasTicketAssignees) {
      return `(
        LOWER(t.assigned_user_id::text) IN (${params.join(", ")})
        OR EXISTS (
          SELECT 1 FROM v_b_ticket_assignees a
          WHERE a.ticket_id = t.id AND LOWER(a.user_id::text) IN (${params.join(", ")})
        )
      )`;
    }
    return `(LOWER(t.assigned_user_id::text) IN (${params.join(", ")}))`;
  }
  if (operator === "not_in") {
    const params = normalizedValues.map(value => pushParam(values, value));
    if (ctx.hasTicketAssignees) {
      return `(
        (t.assigned_user_id IS NULL OR LOWER(t.assigned_user_id::text) NOT IN (${params.join(", ")}))
        AND NOT EXISTS (
          SELECT 1 FROM v_b_ticket_assignees a
          WHERE a.ticket_id = t.id AND LOWER(a.user_id::text) IN (${params.join(", ")})
        )
      )`;
    }
    return `(t.assigned_user_id IS NULL OR LOWER(t.assigned_user_id::text) NOT IN (${params.join(", ")}))`;
  }
  return null;
}
function buildStatusCriterionSql(operator, criterion, values) {
  const rawValue = String(criterion?.value ?? "").trim().toLowerCase();
  if (!rawValue && !["is_empty", "is_not_empty", "in", "not_in"].includes(operator)) {
    return "FALSE";
  }
  if (operator === "is_empty") {
    return `(LOWER(COALESCE(t.status, '')) = '')`;
  }
  if (operator === "is_not_empty") {
    return `(LOWER(COALESCE(t.status, '')) <> '')`;
  }
  if (operator === "in" || operator === "not_in") {
    const list = expandStatusList(parseListValue(criterion?.value));
    if (list.length === 0) {
      return operator === "in" ? "FALSE" : "TRUE";
    }
    const params = list.map(item => pushParam(values, item));
    const clause = `LOWER(COALESCE(t.status, '')) IN (${params.join(", ")})`;
    return operator === "not_in" ? `NOT (${clause})` : clause;
  }
  if (operator === "equals") {
    if (rawValue === "open" || rawValue === "active" || rawValue === "ouverts") {
      return `(LOWER(COALESCE(t.status, '')) NOT IN ('resolved', 'closed'))`;
    }
    if (rawValue === "new") {
      return `(LOWER(COALESCE(t.status, '')) IN ('new', 'open'))`;
    }
    const param = pushParam(values, normalizeStatusCriterionValue(rawValue));
    return `(LOWER(CASE WHEN t.status = 'open' THEN 'new' ELSE COALESCE(t.status, '') END) = ${param})`;
  }
  if (operator === "not_equals") {
    if (rawValue === "open" || rawValue === "active" || rawValue === "ouverts") {
      return `(LOWER(COALESCE(t.status, '')) IN ('resolved', 'closed'))`;
    }
    if (rawValue === "new") {
      return `(LOWER(COALESCE(t.status, '')) NOT IN ('new', 'open'))`;
    }
    const param = pushParam(values, normalizeStatusCriterionValue(rawValue));
    return `(LOWER(CASE WHEN t.status = 'open' THEN 'new' ELSE COALESCE(t.status, '') END) <> ${param})`;
  }
  const param = pushParam(values, normalizeStatusCriterionValue(rawValue));
  const fieldExpr = buildFieldExpr("status", {});
  if (operator === "starts_with") return `(${fieldExpr} LIKE ${param} || '%')`;
  if (operator === "ends_with") return `(${fieldExpr} LIKE '%' || ${param})`;
  if (operator === "not_contains") return `(${fieldExpr} NOT LIKE '%' || ${param} || '%')`;
  return `(${fieldExpr} LIKE '%' || ${param} || '%')`;
}
function buildRequesterExpr(ctx) {
  if (ctx.hasRequesterContact) {
    return `LOWER(TRIM(COALESCE((
      SELECT TRIM(CONCAT(COALESCE(ct.prenom, ''), ' ', COALESCE(ct.nom, '')))
      FROM v_b_contacts ct
      WHERE ct.id = t.requester_contact_id
    ), req_u.email, '')))`;
  }
  return "LOWER(COALESCE(req_u.email, ''))";
}
function buildFieldExpr(field, ctx) {
  const key = String(field || "").trim();
  switch (key) {
    case "title":
      return "LOWER(COALESCE(t.title, ''))";
    case "description":
      return "LOWER(COALESCE(t.description, ''))";
    case "type":
      return "LOWER(CASE WHEN t.type = 'request' THEN 'demande' ELSE COALESCE(t.type, '') END)";
    case "category":
      return "LOWER(COALESCE(t.category, ''))";
    case "status":
      return "LOWER(CASE WHEN t.status = 'open' THEN 'new' ELSE COALESCE(t.status, '') END)";
    case "priority":
      return "LOWER(COALESCE(t.priority, ''))";
    case "channel":
      return "LOWER(COALESCE(t.channel, ''))";
    case "client_id":
      return "LOWER(COALESCE(t.client_id::text, ''))";
    case "assigned_user_id":
      return "LOWER(COALESCE(t.assigned_user_id::text, ''))";
    case "requester_contact_id":
      return ctx.hasRequesterContact ? "LOWER(COALESCE(t.requester_contact_id::text, ''))" : "''";
    case "requester_user_id":
      return "LOWER(COALESCE(t.requester_user_id::text, ''))";
    case "ticket_number":
      return "LOWER(COALESCE(t.ticket_number::text, ''))";
    case "client_name":
      return "LOWER(COALESCE(c.name, ''))";
    case "assigned":
      return buildAssignedExpr(ctx);
    case "requester":
      return buildRequesterExpr(ctx);
    default:
      return "''";
  }
}
function isIdField(field) {
  return ["client_id", "assigned_user_id", "requester_contact_id", "requester_user_id"].includes(String(field || "").trim());
}
function buildCriterionSql(criterion, values, ctx) {
  const operator = String(criterion?.operator || "contains").trim();
  const rawField = String(criterion?.field || "").trim();
  if (rawField === "tags") {
    return buildTagsCriterionSql(operator, criterion, values);
  }
  if (rawField === "assigned_user_id") {
    if (operator === "is_empty") {
      if (ctx.hasTicketAssignees) {
        return `(t.assigned_user_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM v_b_ticket_assignees a WHERE a.ticket_id = t.id
        ))`;
      }
      return "t.assigned_user_id IS NULL";
    }
    if (operator === "is_not_empty") {
      if (ctx.hasTicketAssignees) {
        return `(t.assigned_user_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM v_b_ticket_assignees a WHERE a.ticket_id = t.id
        ))`;
      }
      return "t.assigned_user_id IS NOT NULL";
    }
    const assignedSql = buildAssignedUserIdCriterionSql(operator, criterion, values, ctx);
    if (assignedSql) return assignedSql;
  }
  if (rawField === "status") {
    return buildStatusCriterionSql(operator, criterion, values);
  }
  const fieldExpr = buildFieldExpr(rawField, ctx);
  if (operator === "is_empty") {
    if (isIdField(rawField)) {
      const column = rawField === "requester_contact_id" && !ctx.hasRequesterContact ? null : `t.${rawField}`;
      return column ? `${column} IS NULL` : "TRUE";
    }
    return `(${fieldExpr} = '')`;
  }
  if (operator === "is_not_empty") {
    if (isIdField(rawField)) {
      const column = rawField === "requester_contact_id" && !ctx.hasRequesterContact ? null : `t.${rawField}`;
      return column ? `${column} IS NOT NULL` : "FALSE";
    }
    return `(${fieldExpr} <> '')`;
  }
  if (operator === "in" || operator === "not_in") {
    const list = parseListValue(criterion?.value);
    if (list.length === 0) {
      return operator === "in" ? "FALSE" : "TRUE";
    }
    const params = list.map(item => pushParam(values, item));
    const clause = `${fieldExpr} IN (${params.join(", ")})`;
    return operator === "not_in" ? `NOT (${clause})` : clause;
  }
  let expected = String(criterion?.value ?? "").trim().toLowerCase();
  if (rawField === "status") {
    expected = normalizeStatusCriterionValue(expected);
  }
  if (!expected) return "FALSE";
  const param = pushParam(values, expected);
  if (operator === "equals") return `(${fieldExpr} = ${param})`;
  if (operator === "not_equals") return `(${fieldExpr} <> ${param})`;
  if (operator === "starts_with") return `(${fieldExpr} LIKE ${param} || '%')`;
  if (operator === "ends_with") return `(${fieldExpr} LIKE '%' || ${param})`;
  if (operator === "not_contains") return `(${fieldExpr} NOT LIKE '%' || ${param} || '%')`;
  return `(${fieldExpr} LIKE '%' || ${param} || '%')`;
}
function buildFilterChainSql(children, values, ctx) {
  const nodes = (children || []).filter(Boolean);
  if (nodes.length === 0) return null;
  const parts = [];
  nodes.forEach((node, index) => {
    const fragment = node.type === "group" ? buildFilterGroupSql(node, values, ctx) : buildCriterionSql(node, values, ctx);
    if (!fragment) return;
    if (index === 0) {
      parts.push(`(${fragment})`);
      return;
    }
    const connector = node.connector === "or" ? "OR" : "AND";
    parts.push(`${connector} (${fragment})`);
  });
  return parts.length > 0 ? parts.join(" ") : null;
}
function buildFilterGroupSql(group, values, ctx) {
  return buildFilterChainSql(group?.children, values, ctx);
}
export function buildViewRulesWhere(rulesInput, values, ctx) {
  const rules = normalizeRules(rulesInput);
  if (rules.filterRoot?.children?.length) {
    return buildFilterChainSql(rules.filterRoot.children, values, ctx);
  }
  const criteria = (rules.criteria || []).filter(c => c && String(c.field || "").trim());
  if (criteria.length === 0) return null;
  const fragments = criteria.map(criterion => buildCriterionSql(criterion, values, ctx)).filter(Boolean);
  if (fragments.length === 0) return null;
  const joiner = rules.matchMode === "any" ? " OR " : " AND ";
  return fragments.map(fragment => `(${fragment})`).join(joiner);
}
export function appendStatusFilterWhere(statusFilter, where, values) {
  const normalized = String(statusFilter || "").trim().toLowerCase();
  if (!normalized) return;
  if (normalized === "new") {
    where.push(`t.status IN ('open', 'new')`);
    return;
  }
  where.push(`t.status = ${pushParam(values, normalized)}`);
}
export function appendTypeFilterWhere(typeFilter, where, values) {
  const normalized = String(typeFilter || "").trim().toLowerCase();
  if (!normalized) return;
  if (normalized === "demande") {
    where.push(`LOWER(COALESCE(t.type, '')) IN ('demande', 'request')`);
    return;
  }
  where.push(`LOWER(COALESCE(t.type, '')) = ${pushParam(values, normalized)}`);
}
export function appendSearchWhere(search, where, values, ctx) {
  const term = String(search || "").trim().toLowerCase();
  if (!term) return;
  const param = pushParam(values, `%${term}%`);
  const parts = [`LOWER(COALESCE(t.title, '')) LIKE ${param}`, `LOWER(COALESCE(t.description, '')) LIKE ${param}`, `LOWER(COALESCE(t.ticket_number::text, '')) LIKE ${param}`, `LOWER(COALESCE(t.channel, '')) LIKE ${param}`, `LOWER(COALESCE(c.name, '')) LIKE ${param}`, `LOWER(COALESCE(ass_u.email, '')) LIKE ${param}`, `LOWER(COALESCE(req_u.email, '')) LIKE ${param}`, `LOWER(CASE WHEN t.status = 'open' THEN 'new' ELSE COALESCE(t.status, '') END) LIKE ${param}`, `LOWER(COALESCE(t.priority, '')) LIKE ${param}`, `LOWER(CASE WHEN t.type = 'request' THEN 'demande' ELSE COALESCE(t.type, '') END) LIKE ${param}`, `${buildRequesterExpr(ctx)} LIKE ${param}`, `${buildAssignedExpr(ctx)} LIKE ${param}`, `LOWER(COALESCE((
      SELECT STRING_AGG(LOWER(u.email), ' ')
      FROM v_b_ticket_watchers w
      JOIN v_b_users u ON u.id = w.user_id
      WHERE w.ticket_id = t.id
    ), '')) LIKE ${param}`];
  where.push(`(${parts.join(" OR ")})`);
}
const SORT_COLUMNS = {
  ticket_number: "t.ticket_number",
  title: "LOWER(COALESCE(t.title, ''))",
  channel: "LOWER(COALESCE(t.channel, ''))",
  client: "LOWER(COALESCE(c.name, ''))",
  requester: buildRequesterExpr,
  assigned: buildAssignedExpr,
  followers: `(SELECT COUNT(*)::int FROM v_b_ticket_watchers w WHERE w.ticket_id = t.id)`,
  status: "CASE LOWER(CASE WHEN t.status = 'open' THEN 'new' ELSE COALESCE(t.status, '') END) WHEN 'new' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'pending' THEN 3 WHEN 'resolved' THEN 4 WHEN 'closed' THEN 5 ELSE 99 END",
  type: "LOWER(CASE WHEN t.type = 'request' THEN 'demande' ELSE COALESCE(t.type, '') END)",
  priority: "CASE LOWER(COALESCE(t.priority, '')) WHEN 'low' THEN 1 WHEN 'normal' THEN 2 WHEN 'high' THEN 3 WHEN 'urgent' THEN 4 ELSE 99 END",
  sla: "t.updated_at",
  created_at: "t.created_at",
  updated_at: "t.updated_at"
};
export function buildOrderBySql(sortBy, sortDirection, ctx) {
  const direction = String(sortDirection || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const key = String(sortBy || "updated_at").trim();
  const columnDef = SORT_COLUMNS[key] || SORT_COLUMNS.updated_at;
  const columnExpr = typeof columnDef === "function" ? columnDef(ctx) : columnDef;
  return `${columnExpr} ${direction} NULLS LAST, t.id ${direction}`;
}
