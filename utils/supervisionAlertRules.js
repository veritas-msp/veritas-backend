import { pool } from "../database/db.js";
import { resolveEquipmentFamilyKey } from "./equipmentMonitoringAlerts.js";

const SINGLETON_ID = 1;

/** Critères d'alerte disponibles par famille d'équipement. */
export const SUPERVISION_ALERT_CRITERIA = [
  {
    key: "monitor_critical",
    label: "Alerte critique (supervision)",
    description: "État critique remonté par CheckMK ou la supervision.",
    families: ["servers", "stockage", "firewall", "switch", "wifi", "routeur", "internet", "toip", "alimentation"],
    defaultEnabled: true,
  },
  {
    key: "monitor_warning",
    label: "Warning supervision",
    description: "Avertissement remonté par CheckMK ou la supervision.",
    families: ["servers", "stockage", "firewall", "switch", "wifi", "routeur", "internet", "toip", "alimentation"],
    defaultEnabled: true,
  },
  {
    key: "agent_offline",
    label: "Agent RMM hors ligne",
    description: "Poste géré par l'agent RMM sans signe de vie récent.",
    families: ["ordinateurs"],
    defaultEnabled: false,
  },
  {
    key: "updates_pending",
    label: "Mises à jour obsolètes",
    description: "Mises à jour Windows en attente sur un poste RMM.",
    families: ["ordinateurs"],
    defaultEnabled: true,
  },
  {
    key: "disk_critical",
    label: "Disque critique (≥ 90 %)",
    description: "Espace disque critique sur un poste RMM.",
    families: ["ordinateurs"],
    defaultEnabled: true,
  },
  {
    key: "disk_warn",
    label: "Disque à surveiller (≥ 80 %)",
    description: "Espace disque élevé sur un poste RMM.",
    families: ["ordinateurs"],
    defaultEnabled: true,
  },
  {
    key: "unmapped",
    label: "Non mappé CheckMK",
    description: "Périphérique éligible à CheckMK sans mapping configuré.",
    families: ["servers", "stockage", "firewall", "switch", "wifi", "routeur", "internet", "toip"],
    defaultEnabled: true,
  },
  {
    key: "no_data",
    label: "Sans données supervision",
    description: "Périphérique mappé CheckMK mais sans données récentes.",
    families: ["servers", "stockage", "firewall", "switch", "wifi", "routeur", "internet", "toip"],
    defaultEnabled: false,
  },
  {
    key: "warranty_expired",
    label: "Garantie expirée",
    description: "Date de fin de garantie dépassée.",
    families: ["servers", "stockage", "firewall"],
    defaultEnabled: true,
  },
  {
    key: "warranty_soon",
    label: "Garantie expire bientôt",
    description: "Fin de garantie dans les prochains mois.",
    families: ["servers", "stockage", "firewall"],
    defaultEnabled: true,
  },
  {
    key: "maintenance_expired",
    label: "Licence maintenance expirée",
    description: "Contrat de maintenance firewall expiré.",
    families: ["firewall"],
    defaultEnabled: true,
  },
  {
    key: "maintenance_soon",
    label: "Licence maintenance bientôt",
    description: "Contrat de maintenance firewall à renouveler.",
    families: ["firewall"],
    defaultEnabled: true,
  },
  {
    key: "battery_expired",
    label: "Batterie à remplacer",
    description: "Onduleur / batterie hors service.",
    families: ["alimentation"],
    defaultEnabled: true,
  },
  {
    key: "battery_soon",
    label: "Batterie à surveiller",
    description: "Date batterie onduleur proche.",
    families: ["alimentation"],
    defaultEnabled: true,
  },
  {
    key: "missing_ip",
    label: "IP non renseignée",
    description: "Adresse IP manquante sur un équipement réseau.",
    families: ["servers", "firewall", "switch", "wifi", "routeur", "toip"],
    defaultEnabled: false,
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

export function buildDefaultSupervisionAlertRules() {
  const rules = {};
  for (const family of SUPERVISION_FAMILIES) {
    rules[family.key] = {};
    for (const criterion of getCriteriaForFamily(family.key)) {
      rules[family.key][criterion.key] = criterion.defaultEnabled;
    }
  }
  return rules;
}

function mergeStoredRules(stored) {
  const defaults = buildDefaultSupervisionAlertRules();
  const input = stored && typeof stored === "object" ? stored : {};
  const merged = { ...defaults };

  for (const [familyKey, familyRules] of Object.entries(input)) {
    if (!merged[familyKey] || typeof familyRules !== "object") continue;
    for (const [criterionKey, enabled] of Object.entries(familyRules)) {
      if (merged[familyKey][criterionKey] === undefined) continue;
      merged[familyKey][criterionKey] = Boolean(enabled);
    }
  }
  return merged;
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

export function isSupervisionCriterionEnabled(familyKey, criterionKey, rules) {
  const family = String(familyKey || "").toLowerCase();
  const criterion = String(criterionKey || "");
  const familyRules = rules?.[family];
  if (familyRules && familyRules[criterion] !== undefined) {
    return Boolean(familyRules[criterion]);
  }
  const meta = criteriaByKey.get(criterion);
  if (!meta) return true;
  return Boolean(meta.defaultEnabled);
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
