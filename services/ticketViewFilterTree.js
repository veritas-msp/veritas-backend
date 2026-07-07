export const FILTER_CONNECTORS = [
  { value: "and", label: "ET" },
  { value: "or", label: "OU" },
];

export function createFilterId(prefix = "node") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function buildDefaultRule({ connector = "and", includeConnector = false } = {}) {
  const rule = {
    type: "rule",
    id: createFilterId("rule"),
    field: "title",
    operator: "contains",
    value: "",
  };
  if (includeConnector) rule.connector = connector === "or" ? "or" : "and";
  return rule;
}

export function buildDefaultGroup({ connector = "and", includeConnector = false } = {}) {
  const group = {
    type: "group",
    id: createFilterId("group"),
    children: [buildDefaultRule()],
  };
  if (includeConnector) group.connector = connector === "or" ? "or" : "and";
  return group;
}

export function buildEmptyFilterRoot() {
  return {
    type: "group",
    id: createFilterId("root"),
    children: [],
  };
}

function normalizeConnector(value) {
  return value === "or" ? "or" : "and";
}

function normalizeRuleNode(raw, index) {
  if (!raw || raw.type === "group") return null;
  const rule = {
    type: "rule",
    id: String(raw.id || createFilterId("rule")),
    field: String(raw.field || "title").trim(),
    operator: String(raw.operator || "contains").trim(),
    value: raw.value ?? "",
  };
  if (index > 0) rule.connector = normalizeConnector(raw.connector);
  return rule;
}

function normalizeGroupNode(raw, { isRoot = false } = {}) {
  if (!raw || typeof raw !== "object") return buildEmptyFilterRoot();
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

export function legacyRulesToFilterRoot(rules = {}) {
  const criteria = Array.isArray(rules?.criteria) ? rules.criteria : [];
  const connector = rules?.matchMode === "any" ? "or" : "and";
  return {
    type: "group",
    id: createFilterId("root"),
    children: criteria.map((criterion, index) => {
      const rule = normalizeRuleNode(
        {
          ...criterion,
          id: criterion.id || createFilterId("rule"),
        },
        index
      );
      if (index > 0) rule.connector = connector;
      return rule;
    }),
  };
}

export function normalizeFilterRoot(rawRoot, legacyRules = {}) {
  if (rawRoot?.type === "group") {
    return normalizeGroupNode(rawRoot, { isRoot: true });
  }
  return legacyRulesToFilterRoot(legacyRules);
}

export function walkFilterTree(filterRoot, visitor) {
  if (!filterRoot) return;
  if (filterRoot.type === "group") {
    (filterRoot.children || []).forEach((child) => {
      visitor(child, filterRoot);
      if (child.type === "group") walkFilterTree(child, visitor);
    });
  }
}

export function evaluateFilterChain(children, ticket, context, evaluateCriterion) {
  const nodes = (children || []).filter(Boolean);
  if (nodes.length === 0) return true;

  const evalNode = (node) => {
    if (node.type === "group") {
      return evaluateFilterChain(node.children, ticket, context, evaluateCriterion);
    }
    return evaluateCriterion(node, ticket, context);
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

export function ticketMatchesFilterRoot(filterRoot, ticket, context, evaluateCriterion) {
  const root = normalizeFilterRoot(filterRoot);
  if (!root.children?.length) return true;
  return evaluateFilterChain(root.children, ticket, context, evaluateCriterion);
}

export function collectRuleNodes(filterRoot) {
  const rules = [];
  walkFilterTree(filterRoot, (node) => {
    if (node.type === "rule") rules.push(node);
  });
  return rules;
}

export function validateFilterTreeNodes(filterRoot, validateCriterion) {
  const root = normalizeFilterRoot(filterRoot);
  let error = null;
  walkFilterTree(root, (node) => {
    if (error || node.type !== "rule") return;
    error = validateCriterion(node);
  });
  return error;
}
