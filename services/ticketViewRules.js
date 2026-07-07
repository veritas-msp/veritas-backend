const TICKET_VIEW_FIELDS = new Set([
  "title",
  "description",
  "type",
  "category",
  "status",
  "priority",
  "channel",
  "client_id",
  "assigned",
  "assigned_user_id",
  "requester_contact_id",
  "requester_user_id",
  "ticket_number",
  "tags",
]);

const TICKET_VIEW_OPERATORS = new Set([
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "starts_with",
  "ends_with",
  "in",
  "not_in",
  "is_empty",
  "is_not_empty",
]);

import {
  normalizeFilterRoot,
  ticketMatchesFilterRoot,
  validateFilterTreeNodes,
  collectRuleNodes,
} from "./ticketViewFilterTree.js";

function normalizeRules(rules = {}) {
  const raw = rules && typeof rules === "object" ? rules : {};
  const filterRoot = normalizeFilterRoot(raw.filterRoot, raw);
  const legacyCriteria = collectRuleNodes(filterRoot).map(({ field, operator, value }) => ({
    field,
    operator,
    value,
  }));
  const criteriaFromRaw = Array.isArray(raw.criteria) ? raw.criteria.filter(Boolean) : [];
  const hasFilterTreeRules = (filterRoot?.children || []).length > 0;
  const criteria = hasFilterTreeRules
    ? legacyCriteria
    : criteriaFromRaw.length > 0
      ? criteriaFromRaw
      : legacyCriteria;
  return {
    matchMode: raw.matchMode === "any" ? "any" : "all",
    viewMode: raw.viewMode === "trash" ? "trash" : "active",
    filterRoot,
    criteria,
  };
}

function normalizeIncomingStatus(status) {
  return status === "open" ? "new" : status;
}

function normalizeStatusCriterionValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "open") return "new";
  return normalized;
}

function getAssignedUserIds(ticket) {
  const ids = new Set();
  if (ticket?.assigned_user_id) ids.add(String(ticket.assigned_user_id));
  if (ticket?.assignedUserId) ids.add(String(ticket.assignedUserId));
  if (Array.isArray(ticket?.assignees)) {
    ticket.assignees.forEach((entry) => {
      if (entry?.user_id) ids.add(String(entry.user_id));
      if (entry?.userId) ids.add(String(entry.userId));
    });
  }
  return [...ids];
}

function getAssignedSearchText(ticket, context = {}) {
  const parts = [
    context.assigneeLabel,
    ticket?.assigned_email,
    ticket?.assignedEmail,
  ];
  if (Array.isArray(ticket?.assignees)) {
    ticket.assignees.forEach((entry) => {
      parts.push(entry?.email, entry?.name, entry?.username);
    });
  }
  return parts.filter(Boolean).join(" ");
}

function getFieldValue(ticket, field, context = {}) {
  const key = String(field || "").trim();
  if (!key) return "";

  if (key === "client_name") {
    return String(context.clientLabel || ticket?.client_name || ticket?.client_nom || "");
  }
  if (key === "requester") {
    return String(context.requesterLabel || ticket?.requester_name || ticket?.requester_email || "");
  }
  if (key === "assigned") {
    return String(getAssignedSearchText(ticket, context)).toLowerCase().trim();
  }
  if (key === "assigned_user_id") {
    return getAssignedUserIds(ticket).join(",");
  }

  let value = ticket?.[key];
  if (value === undefined && key.includes("_")) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    value = ticket?.[camel];
  }

  if (key === "status") {
    return normalizeIncomingStatus(value);
  }

  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join(",");
  return String(value);
}

function parseListValue(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function getTicketTagLabels(ticket) {
  const tags = Array.isArray(ticket?.tags) ? ticket.tags : [];
  return tags
    .map((tag) => String(tag?.label ?? tag ?? "").trim().toLowerCase())
    .filter(Boolean);
}

function evaluateTagsCriterion(criterion = {}, ticket = {}) {
  const operator = String(criterion?.operator || "contains").trim();
  const tagLabels = getTicketTagLabels(ticket);
  const expected = String(criterion?.value ?? "").trim().toLowerCase();
  const expectedList = parseListValue(criterion?.value);

  if (operator === "is_empty") return tagLabels.length === 0;
  if (operator === "is_not_empty") return tagLabels.length > 0;

  if (operator === "in") {
    if (expectedList.length === 0) return false;
    return tagLabels.some((label) => expectedList.includes(label));
  }
  if (operator === "not_in") {
    if (expectedList.length === 0) return true;
    return !tagLabels.some((label) => expectedList.includes(label));
  }

  if (!expected) return false;

  const tagMatches = (label) => {
    if (operator === "equals") return label === expected;
    if (operator === "starts_with") return label.startsWith(expected);
    if (operator === "ends_with") return label.endsWith(expected);
    return label.includes(expected);
  };

  if (operator === "not_equals") return !tagLabels.some((label) => label === expected);
  if (operator === "not_contains") return !tagLabels.some((label) => label.includes(expected));
  return tagLabels.some(tagMatches);
}

function evaluateCriterion(criterion = {}, ticket = {}, context = {}) {
  const field = String(criterion?.field || "title").trim();
  const operator = String(criterion?.operator || "contains").trim();

  if (field === "tags") {
    return evaluateTagsCriterion(criterion, ticket);
  }

  const actualRaw = getFieldValue(ticket, field, context);
  const actual = String(actualRaw).toLowerCase().trim();

  if (field === "status") {
    const rawExpected = String(criterion?.value ?? "").trim().toLowerCase();
    const ticketStatus = String(ticket?.status || "").trim().toLowerCase();
    const isActiveTicket = !["resolved", "closed"].includes(ticketStatus);

    if (operator === "equals") {
      if (rawExpected === "open" || rawExpected === "active" || rawExpected === "ouverts") {
        return isActiveTicket;
      }
      if (rawExpected === "new") {
        return ticketStatus === "new" || ticketStatus === "open";
      }
      return normalizeIncomingStatus(ticketStatus) === normalizeStatusCriterionValue(rawExpected);
    }
    if (operator === "not_equals") {
      if (rawExpected === "open" || rawExpected === "active" || rawExpected === "ouverts") {
        return !isActiveTicket;
      }
      if (rawExpected === "new") {
        return ticketStatus !== "new" && ticketStatus !== "open";
      }
      return normalizeIncomingStatus(ticketStatus) !== normalizeStatusCriterionValue(rawExpected);
    }
  }

  if (field === "assigned_user_id") {
    const assignedIds = getAssignedUserIds(ticket);
    const expected = String(criterion?.value ?? "").trim().toLowerCase();
    const expectedList = parseListValue(criterion?.value);

    if (operator === "is_empty") return assignedIds.length === 0;
    if (operator === "is_not_empty") return assignedIds.length > 0;
    if (operator === "equals") return assignedIds.some((id) => id.toLowerCase() === expected);
    if (operator === "not_equals") return !assignedIds.some((id) => id.toLowerCase() === expected);
    if (operator === "in") {
      if (expectedList.length === 0) return false;
      return assignedIds.some((id) => expectedList.includes(id.toLowerCase()));
    }
    if (operator === "not_in") {
      if (expectedList.length === 0) return true;
      return !assignedIds.some((id) => expectedList.includes(id.toLowerCase()));
    }
  }

  if (operator === "is_empty") return actual === "";
  if (operator === "is_not_empty") return actual !== "";

  const expectedList = parseListValue(criterion?.value);
  const expected = String(criterion?.value ?? "").trim().toLowerCase();

  if (operator === "in") {
    if (expectedList.length === 0) return false;
    return expectedList.includes(actual);
  }
  if (operator === "not_in") {
    if (expectedList.length === 0) return true;
    return !expectedList.includes(actual);
  }

  if (!expected && operator !== "is_empty" && operator !== "is_not_empty") return false;

  if (operator === "equals") return actual === expected;
  if (operator === "not_equals") return actual !== expected;
  if (operator === "starts_with") return actual.startsWith(expected);
  if (operator === "ends_with") return actual.endsWith(expected);
  if (operator === "not_contains") return !actual.includes(expected);
  return actual.includes(expected);
}

function ticketMatchesViewRules(ticket, rulesInput = {}, context = {}) {
  const rules = normalizeRules(rulesInput);
  if (rules.filterRoot?.children?.length) {
    return ticketMatchesFilterRoot(rules.filterRoot, ticket, context, evaluateCriterion);
  }
  const criteria = rules.criteria.filter((c) => c && String(c.field || "").trim());
  if (criteria.length === 0) return true;

  const results = criteria.map((criterion) => evaluateCriterion(criterion, ticket, context));
  return rules.matchMode === "any" ? results.some(Boolean) : results.every(Boolean);
}

function validateCriterion(criterion = {}) {
  const field = String(criterion?.field || "").trim();
  const operator = String(criterion?.operator || "contains").trim();
  if (!TICKET_VIEW_FIELDS.has(field)) {
    return `Champ invalide: ${field || "(vide)"}`;
  }
  if (!TICKET_VIEW_OPERATORS.has(operator)) {
    return `Opérateur invalide: ${operator}`;
  }
  if (!["is_empty", "is_not_empty", "in", "not_in"].includes(operator)) {
    if (!String(criterion?.value ?? "").trim()) return "Valeur requise pour ce critère";
  }
  if (["in", "not_in"].includes(operator) && parseListValue(criterion?.value).length === 0) {
    return "Liste de valeurs requise";
  }
  return null;
}

function validateViewRules(rulesInput = {}) {
  const rules = normalizeRules(rulesInput);
  if (rules.filterRoot?.children?.length) {
    return validateFilterTreeNodes(rules.filterRoot, validateCriterion);
  }
  for (const criterion of rules.criteria) {
    const err = validateCriterion(criterion);
    if (err) return err;
  }
  return null;
}

export {
  TICKET_VIEW_FIELDS,
  TICKET_VIEW_OPERATORS,
  normalizeRules,
  getFieldValue,
  evaluateCriterion,
  ticketMatchesViewRules,
  validateViewRules,
  validateCriterion,
};
