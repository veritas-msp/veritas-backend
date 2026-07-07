const CONDITION_OPERATORS = new Set(["equals", "not_equals", "contains", "checked", "not_checked"]);

function normalizeFieldValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function normalizeCondition(raw = {}) {
  const operator = CONDITION_OPERATORS.has(String(raw.operator || "")) ? String(raw.operator) : "equals";
  return {
    fieldKey: String(raw.fieldKey || "").trim(),
    operator,
    value: raw.value === undefined || raw.value === null ? "" : String(raw.value),
  };
}

export function normalizeVisibilityRules(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const conditions = Array.isArray(source.conditions)
    ? source.conditions.map(normalizeCondition).filter((condition) => condition.fieldKey)
    : [];
  return {
    matchMode: source.matchMode === "any" ? "any" : "all",
    conditions,
  };
}

export function evaluateCondition(condition, fieldValues = {}) {
  const fieldKey = String(condition?.fieldKey || "").trim();
  if (!fieldKey) return true;
  const actual = normalizeFieldValue(fieldValues[fieldKey]).trim();
  const expected = normalizeFieldValue(condition?.value).trim();
  const actualLower = actual.toLowerCase();
  const expectedLower = expected.toLowerCase();
  const operator = CONDITION_OPERATORS.has(String(condition?.operator || ""))
    ? String(condition.operator)
    : "equals";

  switch (operator) {
    case "equals":
      return actualLower === expectedLower;
    case "not_equals":
      return actualLower !== expectedLower;
    case "contains":
      return actualLower.includes(expectedLower);
    case "checked":
      return actual === "true" || actual === "1" || actualLower === "oui" || actualLower === "yes";
    case "not_checked":
      return !(actual === "true" || actual === "1" || actualLower === "oui" || actualLower === "yes");
    default:
      return actualLower === expectedLower;
  }
}

export function conditionsMatch(rules = {}, fieldValues = {}) {
  const normalized = normalizeVisibilityRules(rules);
  if (!normalized.conditions.length) return true;
  const results = normalized.conditions.map((condition) => evaluateCondition(condition, fieldValues));
  if (normalized.matchMode === "any") return results.some(Boolean);
  return results.every(Boolean);
}

export function fieldIsVisible(visibilityRules = {}, fieldValues = {}) {
  return conditionsMatch(visibilityRules, fieldValues);
}
