import { pool } from "../database/db.js";
import { conditionsMatch, normalizeVisibilityRules } from "./salesFormConditions.js";
const PRIORITY_VALUES = new Set(["low", "normal", "high", "urgent"]);
const STATUS_VALUES = new Set(["open", "new", "pending", "in_progress", "resolved", "closed"]);
const CONDITION_OPERATORS = new Set(["equals", "not_equals", "contains", "checked", "not_checked"]);
function uniqueIds(list = []) {
  return [...new Set(list.map(id => String(id || "").trim()).filter(Boolean))];
}
function isLegacyFlatTargets(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (Array.isArray(raw.rules)) return false;
  return Object.prototype.hasOwnProperty.call(raw, "priority") || Object.prototype.hasOwnProperty.call(raw, "status") || Object.prototype.hasOwnProperty.call(raw, "assigneeUserIds") || Object.prototype.hasOwnProperty.call(raw, "watcherUserIds") || Object.prototype.hasOwnProperty.call(raw, "teamIds");
}
export function normalizeTicketTargets(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const priority = PRIORITY_VALUES.has(String(source.priority || "")) ? String(source.priority) : null;
  const status = STATUS_VALUES.has(String(source.status || "")) ? String(source.status) : null;
  return {
    priority,
    status,
    assigneeUserIds: uniqueIds(source.assigneeUserIds),
    watcherUserIds: uniqueIds(source.watcherUserIds),
    teamIds: uniqueIds(source.teamIds),
    titleSuffix: String(source.titleSuffix || "").trim() || null,
    categorySlug: String(source.categorySlug || "").trim() || null
  };
}
function normalizeCondition(raw = {}) {
  const operator = CONDITION_OPERATORS.has(String(raw.operator || "")) ? String(raw.operator) : "equals";
  return {
    fieldKey: String(raw.fieldKey || "").trim(),
    operator,
    value: raw.value === undefined || raw.value === null ? "" : String(raw.value)
  };
}
function normalizeRule(raw = {}, index = 0) {
  const conditions = Array.isArray(raw.conditions) ? raw.conditions.map(normalizeCondition).filter(c => c.fieldKey) : [];
  return {
    id: String(raw.id || `rule-${index + 1}`),
    label: String(raw.label || `Ticket ${index + 1}`).trim() || `Ticket ${index + 1}`,
    enabled: raw.enabled !== false,
    always: raw.always === true || conditions.length === 0,
    matchMode: raw.matchMode === "any" ? "any" : "all",
    conditions,
    targets: normalizeTicketTargets(raw.targets)
  };
}
export function normalizeTicketTargetsConfig(raw = {}) {
  if (isLegacyFlatTargets(raw)) {
    return {
      version: 2,
      rules: [normalizeRule({
        id: "default",
        label: "Primary ticket",
        enabled: true,
        always: true,
        conditions: [],
        targets: normalizeTicketTargets(raw)
      }, 0)]
    };
  }
  const source = raw && typeof raw === "object" ? raw : {};
  const rules = Array.isArray(source.rules) ? source.rules.map(normalizeRule) : [];
  if (rules.length === 0) {
    rules.push(normalizeRule({
      id: "default",
      label: "Primary ticket",
      enabled: true,
      always: true,
      conditions: [],
      targets: {}
    }, 0));
  }
  return {
    version: 2,
    rules
  };
}
export function parseTicketTargetsFromRow(row) {
  if (!row) return normalizeTicketTargetsConfig({});
  let raw = row.ticket_targets;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  return normalizeTicketTargetsConfig(raw);
}
export function describeTicketTargets(config = {}) {
  const normalized = normalizeTicketTargetsConfig(config);
  const enabledRules = normalized.rules.filter(rule => rule.enabled);
  if (enabledRules.length === 0) return "No target";
  if (enabledRules.length === 1) {
    const rule = enabledRules[0];
    const parts = [rule.label];
    const targets = rule.targets;
    if (targets.priority) parts.push(`Priority ${targets.priority}`);
    if (targets.assigneeUserIds.length) parts.push(`${targets.assigneeUserIds.length} assignee(s)`);
    return parts.join(" · ");
  }
  return `${enabledRules.length} conditional target(s)`;
}
export function describeTicketTargetRule(rule) {
  if (!rule) return "";
  const parts = [rule.label];
  if (rule.always) {
    parts.push("always");
  } else if (rule.conditions.length) {
    parts.push(`${rule.conditions.length} condition(s)`);
  }
  return parts.join(" · ");
}
export function ruleMatches(rule, fieldValues = {}) {
  if (!rule || rule.enabled === false) return false;
  if (rule.always || !(rule.conditions || []).length) return true;
  return conditionsMatch({
    matchMode: rule.matchMode === "any" ? "any" : "all",
    conditions: rule.conditions || []
  }, fieldValues);
}
export function resolveMatchingRules(config = {}, fieldValues = {}) {
  const normalized = normalizeTicketTargetsConfig(config);
  return normalized.rules.filter(rule => ruleMatches(rule, fieldValues));
}
export async function loadFormTicketTargetsConfig(formId) {
  if (!formId) return normalizeTicketTargetsConfig({});
  try {
    const result = await pool.query(`SELECT ticket_targets FROM v_b_sales_form_definitions WHERE id = $1 AND enabled = TRUE`, [String(formId)]);
    if (!result.rows.length) return normalizeTicketTargetsConfig({});
    return parseTicketTargetsFromRow(result.rows[0]);
  } catch (err) {
    if (String(err?.code) === "42703") return normalizeTicketTargetsConfig({});
    throw err;
  }
}
export async function loadFormTicketTargets(formId) {
  const config = await loadFormTicketTargetsConfig(formId);
  const firstRule = config.rules.find(rule => rule.enabled) || config.rules[0];
  return firstRule?.targets || normalizeTicketTargets({});
}
export async function resolveAssigneeUserIds(targets = {}) {
  const normalized = normalizeTicketTargets(targets);
  const userIds = new Set(normalized.assigneeUserIds);
  if (normalized.teamIds.length > 0) {
    const result = await pool.query(`SELECT DISTINCT user_id
       FROM v_b_team_members
       WHERE team_id = ANY($1::uuid[])`, [normalized.teamIds]);
    for (const row of result.rows || []) {
      if (row.user_id) userIds.add(String(row.user_id));
    }
  }
  return [...userIds];
}
async function hasTicketAssigneesTable() {
  const result = await pool.query(`SELECT to_regclass('public.v_b_ticket_assignees') IS NOT NULL AS ok`);
  return Boolean(result.rows[0]?.ok);
}
async function hasTicketWatchersTable() {
  const result = await pool.query(`SELECT to_regclass('public.v_b_ticket_watchers') IS NOT NULL AS ok`);
  return Boolean(result.rows[0]?.ok);
}
export async function applyFormTicketTargets(ticketId, targets = {}) {
  const normalized = normalizeTicketTargets(targets);
  const assigneeUserIds = await resolveAssigneeUserIds(normalized);
  const watcherUserIds = normalized.watcherUserIds;
  const hasAssignees = await hasTicketAssigneesTable();
  if (hasAssignees && assigneeUserIds.length > 0) {
    await pool.query("DELETE FROM v_b_ticket_assignees WHERE ticket_id = $1", [ticketId]);
    for (const userId of assigneeUserIds) {
      await pool.query(`INSERT INTO v_b_ticket_assignees (ticket_id, user_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (ticket_id, user_id) DO NOTHING`, [ticketId, userId]);
    }
    await pool.query(`UPDATE v_b_tickets SET assigned_user_id = $1, updated_at = NOW() WHERE id = $2`, [assigneeUserIds[0], ticketId]);
  }
  const hasWatchers = await hasTicketWatchersTable();
  if (hasWatchers && watcherUserIds.length > 0) {
    for (const userId of watcherUserIds) {
      await pool.query(`INSERT INTO v_b_ticket_watchers (ticket_id, user_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (ticket_id, user_id) DO NOTHING`, [ticketId, userId]);
    }
  }
  return {
    assigneeUserIds,
    watcherUserIds
  };
}
export function mergeCreateOptionsFromTargets(targets = {}, options = {}) {
  const normalized = normalizeTicketTargets(targets);
  return {
    priority: normalized.priority || options.priority || "normal",
    status: normalized.status || options.status || "new"
  };
}
export function buildTicketTitle(baseTitle, rule) {
  const suffix = rule?.targets?.titleSuffix || rule?.label;
  if (!suffix || suffix === "Primary ticket") return baseTitle;
  if (baseTitle.includes(suffix)) return baseTitle;
  return `${baseTitle} — ${suffix}`;
}
