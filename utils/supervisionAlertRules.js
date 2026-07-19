import { pool } from "../database/db.js";
import { resolveEquipmentFamilyKey } from "./equipmentMonitoringAlerts.js";

const SINGLETON_ID = 1;

const SEVERITIES = new Set(["low", "normal", "high", "urgent"]);

/** Available alert criteria by equipment family. */
export const SUPERVISION_ALERT_CRITERIA = [
  {
    key: "monitor_critical",
    label: "Alerte critique (supervision)",
    description: "État critique remonté par CheckMK ou la supervision.",
    families: ["servers", "stockage", "firewall", "switch", "wifi", "routeur", "internet", "toip", "alimentation"],
    defaultEnabled: true,
    defaultSeverity: "high",
    parameters: [],
  },
  {
    key: "monitor_warning",
    label: "Warning supervision",
    description: "Avertissement remonté par CheckMK ou la supervision.",
    families: ["servers", "stockage", "firewall", "switch", "wifi", "routeur", "internet", "toip", "alimentation"],
    defaultEnabled: true,
    defaultSeverity: "normal",
    parameters: [],
  },
  {
    key: "agent_offline",
    label: "Agent RMM hors ligne",
    description:
      "Poste géré par l'agent RMM sans inventaire depuis le seuil d'alerte (distinct du statut online agent RMM).",
    families: ["ordinateurs"],
    defaultEnabled: true,
    defaultSeverity: "high",
    parameters: [
      {
        key: "minutes",
        type: "number",
        label: "Seuil hors ligne alerte (minutes)",
        min: 15,
        max: 43200,
        default: 2880,
        unit: "min",
      },
    ],
  },
  {
    key: "updates_pending",
    label: "Mises à jour obsolètes",
    description: "Mises à jour Windows en attente sur un poste RMM.",
    families: ["ordinateurs"],
    defaultEnabled: true,
    defaultSeverity: "normal",
    parameters: [
      {
        key: "minPending",
        type: "number",
        label: "Nombre mini. de MAJ en attente",
        min: 1,
        max: 500,
        default: 1,
      },
    ],
  },
  {
    key: "disk_critical",
    label: "Disque critique",
    description: "Espace disque critique sur un poste RMM.",
    families: ["ordinateurs"],
    defaultEnabled: true,
    defaultSeverity: "urgent",
    parameters: [
      {
        key: "percent",
        type: "number",
        label: "Seuil critique (%)",
        min: 1,
        max: 100,
        default: 90,
        unit: "%",
      },
    ],
  },
  {
    key: "disk_warn",
    label: "Disque à surveiller",
    description: "Espace disque élevé sur un poste RMM.",
    families: ["ordinateurs"],
    defaultEnabled: true,
    defaultSeverity: "normal",
    parameters: [
      {
        key: "percent",
        type: "number",
        label: "Seuil warning (%)",
        min: 1,
        max: 100,
        default: 80,
        unit: "%",
      },
    ],
  },
  {
    key: "unmapped",
    label: "Non mappé CheckMK",
    description: "Périphérique éligible à CheckMK sans mapping configuré (alerte de couverture).",
    families: ["servers", "stockage", "firewall", "switch", "wifi", "routeur", "internet", "toip"],
    defaultEnabled: true,
    defaultSeverity: "normal",
    parameters: [],
  },
  {
    key: "no_data",
    label: "Sans données supervision",
    description: "Périphérique mappé CheckMK mais sans données récentes.",
    families: ["servers", "stockage", "firewall", "switch", "wifi", "routeur", "internet", "toip"],
    defaultEnabled: false,
    defaultSeverity: "normal",
    parameters: [],
  },
  {
    key: "warranty_expired",
    label: "Garantie expirée",
    description: "Date de fin de garantie dépassée.",
    families: ["servers", "stockage", "firewall"],
    defaultEnabled: true,
    defaultSeverity: "normal",
    parameters: [],
  },
  {
    key: "warranty_soon",
    label: "Garantie expire bientôt",
    description: "Fin de garantie dans les prochains jours (seuil configurable).",
    families: ["servers", "stockage", "firewall"],
    defaultEnabled: true,
    defaultSeverity: "low",
    parameters: [
      {
        key: "days",
        type: "number",
        label: "Jours avant expiration",
        min: 1,
        max: 365,
        default: 30,
        unit: "j",
      },
    ],
  },
  {
    key: "maintenance_expired",
    label: "Licence maintenance expirée",
    description: "Contrat de maintenance firewall expiré.",
    families: ["firewall"],
    defaultEnabled: true,
    defaultSeverity: "high",
    parameters: [],
  },
  {
    key: "maintenance_soon",
    label: "Licence maintenance bientôt",
    description: "Contrat de maintenance firewall à renouveler.",
    families: ["firewall"],
    defaultEnabled: true,
    defaultSeverity: "normal",
    parameters: [
      {
        key: "days",
        type: "number",
        label: "Jours avant expiration",
        min: 1,
        max: 365,
        default: 30,
        unit: "j",
      },
    ],
  },
  {
    key: "battery_expired",
    label: "Batterie à remplacer",
    description: "Onduleur / batterie hors service.",
    families: ["alimentation"],
    defaultEnabled: true,
    defaultSeverity: "high",
    parameters: [],
  },
  {
    key: "battery_soon",
    label: "Batterie à surveiller",
    description: "Date batterie onduleur proche.",
    families: ["alimentation"],
    defaultEnabled: true,
    defaultSeverity: "normal",
    parameters: [
      {
        key: "days",
        type: "number",
        label: "Jours avant expiration",
        min: 1,
        max: 365,
        default: 30,
        unit: "j",
      },
    ],
  },
  {
    key: "missing_ip",
    label: "IP non renseignée",
    description: "Adresse IP manquante sur un équipement réseau.",
    families: ["servers", "firewall", "switch", "wifi", "routeur", "toip"],
    defaultEnabled: false,
    defaultSeverity: "low",
    parameters: [],
  },
];

export const SUPERVISION_FAMILIES = [
  { key: "ordinateurs", label: "Ordinateurs" },
  { key: "servers", label: "Serveurs" },
  { key: "stockage", label: "Stockage" },
  { key: "firewall", label: "Firewalls" },
  { key: "switch", label: "Switch" },
  { key: "wifi", label: "Borne WiFi" },
  { key: "routeur", label: "Routeur / SD-WAN" },
  { key: "internet", label: "Internet" },
  { key: "toip", label: "TOIP" },
  { key: "alimentation", label: "Alimentation" },
];

const criteriaByKey = new Map(SUPERVISION_ALERT_CRITERIA.map((c) => [c.key, c]));

export function getCriteriaForFamily(familyKey) {
  const key = String(familyKey || "").toLowerCase();
  return SUPERVISION_ALERT_CRITERIA.filter((c) => c.families.includes(key));
}

function defaultParametersForCriterion(meta) {
  const params = {};
  for (const field of meta?.parameters || []) {
    params[field.key] = field.default;
  }
  return params;
}

export function buildDefaultRuleValue(criterionKeyOrMeta) {
  const meta =
    typeof criterionKeyOrMeta === "string"
      ? criteriaByKey.get(criterionKeyOrMeta)
      : criterionKeyOrMeta;
  if (!meta) {
    return { enabled: true, parameters: {}, severity: "normal" };
  }
  return {
    enabled: Boolean(meta.defaultEnabled),
    parameters: defaultParametersForCriterion(meta),
    severity: SEVERITIES.has(meta.defaultSeverity) ? meta.defaultSeverity : "normal",
  };
}

function clampNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) return field.default;
  let out = n;
  if (field.min != null) out = Math.max(field.min, out);
  if (field.max != null) out = Math.min(field.max, out);
  return Math.round(out);
}

export function normalizeRuleValue(raw, criterionKey) {
  const meta = criteriaByKey.get(criterionKey);
  const defaults = buildDefaultRuleValue(meta || criterionKey);

  if (typeof raw === "boolean") {
    return { ...defaults, enabled: raw };
  }

  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const parameters = { ...defaults.parameters };
  for (const field of meta?.parameters || []) {
    if (raw.parameters?.[field.key] != null) {
      parameters[field.key] = clampNumber(raw.parameters[field.key], field);
    } else if (raw[field.key] != null) {
      parameters[field.key] = clampNumber(raw[field.key], field);
    }
  }

  const severity = SEVERITIES.has(String(raw.severity || "").toLowerCase())
    ? String(raw.severity).toLowerCase()
    : defaults.severity;

  return {
    enabled: raw.enabled !== undefined ? Boolean(raw.enabled) : defaults.enabled,
    parameters,
    severity,
  };
}

export function buildDefaultSupervisionAlertRules() {
  const rules = {};
  for (const family of SUPERVISION_FAMILIES) {
    rules[family.key] = {};
    for (const criterion of getCriteriaForFamily(family.key)) {
      rules[family.key][criterion.key] = buildDefaultRuleValue(criterion);
    }
  }
  return rules;
}

function mergeStoredRules(stored) {
  const defaults = buildDefaultSupervisionAlertRules();
  const input = stored && typeof stored === "object" ? stored : {};
  const merged = {};

  for (const family of SUPERVISION_FAMILIES) {
    merged[family.key] = {};
    const inputFamily = input[family.key] && typeof input[family.key] === "object" ? input[family.key] : {};
    for (const criterion of getCriteriaForFamily(family.key)) {
      const raw =
        inputFamily[criterion.key] !== undefined
          ? inputFamily[criterion.key]
          : defaults[family.key][criterion.key];
      merged[family.key][criterion.key] = normalizeRuleValue(raw, criterion.key);
    }
  }
  return merged;
}

export function getSupervisionCriterionRule(familyKey, criterionKey, rules) {
  const family = String(familyKey || "").toLowerCase();
  const criterion = String(criterionKey || "");
  const raw = rules?.[family]?.[criterion];
  return normalizeRuleValue(raw, criterion);
}

export function isSupervisionCriterionEnabled(familyKey, criterionKey, rules) {
  return getSupervisionCriterionRule(familyKey, criterionKey, rules).enabled;
}

export function getSupervisionCriterionSeverity(familyKey, criterionKey, rules) {
  return getSupervisionCriterionRule(familyKey, criterionKey, rules).severity;
}

export function getSupervisionCriterionParameters(familyKey, criterionKey, rules) {
  return getSupervisionCriterionRule(familyKey, criterionKey, rules).parameters;
}

/** Offline alert threshold (minutes) from rules — default 2880. */
export function getOfflineAlertThresholdMinutesFromRules(rules) {
  const params = getSupervisionCriterionParameters("ordinateurs", "agent_offline", rules);
  const minutes = Number(params?.minutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 2880;
}

/** Evaluation thresholds derived from rules for a family. */
export function getEvaluationThresholdsFromRules(familyKey, rules) {
  const family = String(familyKey || "").toLowerCase();
  return {
    offlineAlertThresholdMinutes: getOfflineAlertThresholdMinutesFromRules(rules),
    diskCriticalPercent: Number(
      getSupervisionCriterionParameters(family, "disk_critical", rules)?.percent
    ) || 90,
    diskWarnPercent: Number(
      getSupervisionCriterionParameters(family, "disk_warn", rules)?.percent
    ) || 80,
    updatesMinPending: Number(
      getSupervisionCriterionParameters(family, "updates_pending", rules)?.minPending
    ) || 1,
    warrantySoonDays: Number(
      getSupervisionCriterionParameters(family, "warranty_soon", rules)?.days
    ) || 30,
    maintenanceSoonDays: Number(
      getSupervisionCriterionParameters(family, "maintenance_soon", rules)?.days
    ) || 30,
    batterySoonDays: Number(
      getSupervisionCriterionParameters(family, "battery_soon", rules)?.days
    ) || 30,
  };
}

let rulesCache = null;
let rulesCacheAt = 0;
const CACHE_TTL_MS = 5000;

export async function getSupervisionAlertRules({ fresh = false } = {}) {
  if (!fresh && rulesCache && Date.now() - rulesCacheAt < CACHE_TTL_MS) {
    return rulesCache;
  }
  const result = await pool.query(
    `SELECT data FROM v_b_supervision_alert_rules_config WHERE id = $1 LIMIT 1`,
    [SINGLETON_ID]
  );
  const merged = mergeStoredRules(result.rows[0]?.data);
  rulesCache = merged;
  rulesCacheAt = Date.now();
  return merged;
}

export async function saveSupervisionAlertRules(rules) {
  const merged = mergeStoredRules(rules);
  await pool.query(
    `INSERT INTO v_b_supervision_alert_rules_config (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [SINGLETON_ID, JSON.stringify(merged)]
  );
  rulesCache = merged;
  rulesCacheAt = Date.now();
  return merged;
}

export function resolveCriterionFromMonitorStatus(monitorStatus, source = "checkmk") {
  const status = String(monitorStatus || "").toLowerCase();
  if (status === "critical") return "monitor_critical";
  if (status === "warning") return "monitor_warning";
  if (status === "offline") return source === "rmm" ? "agent_offline" : "monitor_critical";
  if (status === "unmapped") return "unmapped";
  if (status === "no_data") return "no_data";
  return null;
}

export function resolveEquipmentFamilyFromType(type) {
  return resolveEquipmentFamilyKey(type);
}

export async function isSupervisionAlertAllowed({
  equipmentFamily,
  monitorStatus,
  source = "checkmk",
  criterionKey = null,
}) {
  const rules = await getSupervisionAlertRules();
  const family = String(equipmentFamily || "").toLowerCase();
  const key = criterionKey || resolveCriterionFromMonitorStatus(monitorStatus, source);
  if (!key) return true;
  return isSupervisionCriterionEnabled(family, key, rules);
}

export function getSupervisionAlertRulesPayload(rules) {
  return {
    families: SUPERVISION_FAMILIES,
    criteria: SUPERVISION_ALERT_CRITERIA,
    rules: rules || buildDefaultSupervisionAlertRules(),
  };
}
