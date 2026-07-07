function createFilterId(prefix = "node") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeConnector(value) {
  return value === "or" ? "or" : "and";
}

function normalizeRuleNode(raw, index) {
  if (!raw || raw.type === "group") return null;
  const rule = {
    type: "rule",
    id: String(raw.id || createFilterId("rule")),
    field: String(raw.field || "subject").trim(),
    operator: String(raw.operator || "contains").trim(),
    value: raw.value ?? "",
  };
  if (index > 0) rule.connector = normalizeConnector(raw.connector);
  return rule;
}

function normalizeGroupNode(raw, { isRoot = false } = {}) {
  if (!raw || typeof raw !== "object") {
    return { type: "group", id: createFilterId("root"), children: [] };
  }
  const children = Array.isArray(raw.children) ? raw.children : [];
  const normalizedChildren = children
    .map((child, index) => {
      if (child?.type === "group") {
        const group = normalizeGroupNode(child);
        if (index > 0) group.connector = normalizeConnector(child.connector);
        return group;
      }
      return normalizeRuleNode(child, index);
    })
    .filter(Boolean);

  const group = {
    type: "group",
    id: String(raw.id || createFilterId(isRoot ? "root" : "group")),
    children: normalizedChildren,
  };
  if (!isRoot && raw.connector) group.connector = normalizeConnector(raw.connector);
  return group;
}

export function legacyCriteriaToFilterRoot(rule = {}) {
  const criteria = Array.isArray(rule?.criteria) ? rule.criteria : [];
  const connector = rule?.matchMode === "any" ? "or" : "and";
  return {
    type: "group",
    id: createFilterId("root"),
    children: criteria.map((criterion, index) => {
      const node = normalizeRuleNode(
        {
          ...criterion,
          id: criterion.id || createFilterId("rule"),
        },
        index
      );
      if (index > 0) node.connector = connector;
      return node;
    }),
  };
}

export function normalizeExclusionFilterRoot(rule = {}) {
  if (rule?.filterRoot?.type === "group") {
    return normalizeGroupNode(rule.filterRoot, { isRoot: true });
  }
  return legacyCriteriaToFilterRoot(rule);
}

export function normalizeIngestionAction(action = "") {
  const key = String(action || "create_ticket_support").trim();
  if (key === "create_ticket") return "create_ticket_support";
  if (key === "attach_comment") return "attach_comment";
  if (key === "ignore_mail") return "ignore_mail";
  if (key === "create_ticket_services") return "create_ticket_services";
  return "create_ticket_support";
}

export function buildMailContextFromEnvelope(message = {}) {
  const subject = String(message?.envelope?.subject || "");
  const fromMailbox = message?.envelope?.from?.[0];
  const fromAddress = String(fromMailbox?.address || "").trim();
  const fromName = String(fromMailbox?.name || "").trim();
  const toAddresses = (Array.isArray(message?.envelope?.to) ? message.envelope.to : [])
    .map((item) => String(item?.address || "").trim())
    .filter(Boolean)
    .join(", ");
  const ccAddresses = (Array.isArray(message?.envelope?.cc) ? message.envelope.cc : [])
    .map((item) => String(item?.address || "").trim())
    .filter(Boolean)
    .join(", ");
  const replyToAddress = String(
    (Array.isArray(message?.envelope?.replyTo) ? message.envelope.replyTo[0]?.address : "") || ""
  ).trim();
  const fromDomain = fromAddress.includes("@") ? fromAddress.split("@").slice(1).join("@") : "";
  const isReply = /^(re|fw|fwd)\s*:/i.test(subject) ? "yes" : "no";

  return {
    subject,
    body: "",
    fromAddress,
    fromName,
    toAddresses,
    ccAddresses,
    replyToAddress,
    fromDomain,
    isReply,
  };
}

export function evaluateMailCriterion(criterion = {}, context = {}) {
  const field = String(criterion?.field || "subject");
  const operator = String(criterion?.operator || "contains");
  const rawExpected = criterion?.value ?? "";
  const expected = String(rawExpected).trim().toLowerCase();
  const actual = String(context?.[field] ?? "").toLowerCase();

  if (operator === "is_empty") return actual.length === 0;
  if (operator === "is_not_empty") return actual.length > 0;
  if (operator === "equals") return actual === expected;
  if (operator === "not_equals") return actual !== expected;
  if (operator === "starts_with") return expected ? actual.startsWith(expected) : false;
  if (operator === "ends_with") return expected ? actual.endsWith(expected) : false;
  if (operator === "not_contains") return expected ? !actual.includes(expected) : false;
  if (operator === "in") {
    const list = String(rawExpected)
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    return list.length > 0 && list.some((item) => actual.includes(item));
  }
  if (operator === "not_in") {
    const list = String(rawExpected)
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    return list.length === 0 || !list.some((item) => actual.includes(item));
  }
  if (!expected) return false;
  return actual.includes(expected);
}

function evaluateFilterChain(children, context) {
  const nodes = (children || []).filter(Boolean);
  if (nodes.length === 0) return true;

  const evalNode = (node) => {
    if (node.type === "group") {
      return evaluateFilterChain(node.children, context);
    }
    return evaluateMailCriterion(node, context);
  };

  let acc = evalNode(nodes[0]);
  for (let i = 1; i < nodes.length; i += 1) {
    const node = nodes[i];
    const next = evalNode(node);
    const connector = normalizeConnector(node.connector);
    acc = connector === "or" ? acc || next : acc && next;
  }
  return acc;
}

export function mailMatchesFilterRoot(filterRoot, context = {}) {
  const root = normalizeExclusionFilterRoot({ filterRoot });
  if (!root.children?.length) return true;
  return evaluateFilterChain(root.children, context);
}

export function exclusionRuleMatchesContext(rule = {}, context = {}) {
  if (rule?.enabled === false) return false;
  const filterRoot = normalizeExclusionFilterRoot(rule);
  return mailMatchesFilterRoot(filterRoot, context);
}

export function findMatchingExclusionRule(rules = [], context = {}) {
  const enabledRules = (Array.isArray(rules) ? rules : []).filter((rule) => rule?.enabled !== false);
  for (const rule of enabledRules) {
    if (exclusionRuleMatchesContext(rule, context)) return rule;
  }
  return null;
}

export function getAllMatchingExclusionRules(rules = [], context = {}) {
  const enabledRules = (Array.isArray(rules) ? rules : []).filter((rule) => rule?.enabled !== false);
  return enabledRules.filter((rule) => exclusionRuleMatchesContext(rule, context));
}

export function normalizeExclusionRule(row, idx = 0) {
  const legacyCriteria = Array.isArray(row?.criteria)
    ? row.criteria
    : row?.type || row?.value
      ? [
          {
            id: `criterion-legacy-${Date.now()}-${idx}`,
            field:
              String(row?.type || "title_contains").trim() === "requester_email"
                ? "fromAddress"
                : String(row?.type || "title_contains").trim() === "field_contains"
                  ? "body"
                  : "subject",
            operator: "contains",
            value: String(row?.value || "").trim(),
          },
        ]
      : [];
  const filterRoot = normalizeExclusionFilterRoot({
    ...row,
    criteria: legacyCriteria,
  });
  return {
    id: row?.id || `exclude-${Date.now()}-${idx}`,
    name: String(row?.name || "").trim() || `Règle ${idx + 1}`,
    collectorId: String(row?.collectorId || "").trim(),
    filterRoot,
    criteria: legacyCriteria.map((criterion, criterionIdx) => ({
      id: String(criterion?.id || `criterion-${Date.now()}-${idx}-${criterionIdx}`),
      field: String(criterion?.field || "subject").trim() || "subject",
      operator: String(criterion?.operator || "contains").trim() || "contains",
      value: String(criterion?.value ?? "").trim(),
    })),
    action: normalizeIngestionAction(row?.action),
    actionTemplate: String(row?.actionTemplate || "").trim(),
    archiveOnMatch: row?.archiveOnMatch !== false,
    enabled: row?.enabled !== false,
  };
}
