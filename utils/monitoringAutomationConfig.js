import { pool } from "../database/db.js";
import {
  getOfflineAlertThresholdMinutesFromRules,
  getSupervisionAlertRules,
} from "./supervisionAlertRules.js";

const AUTOMATION_TABLE = "v_b_monitoring_automation_config";
const RUNBOOKS_TABLE = "v_b_monitoring_runbooks_config";
const SINGLETON_ID = 1;

export const DEFAULT_MONITORING_AUTOMATION_CONFIG = {
  version: 1,
  defaults: {
    alertsEnabledOnEnroll: true,
    alertsEnabledOnNewEquipment: false,
    offlineAlertThresholdMinutes: 2880,
  },
  assignment: {
    defaultAssigneeUserIds: [],
    defaultTeamIds: [],
    clientRules: [],
    criterionRules: [],
  },
  escalation: {
    enabled: true,
    rules: [
      {
        id: "esc-critical",
        criterionKeys: ["monitor_critical", "agent_offline", "disk_critical"],
        unassignedMinutes: 30,
        bumpPriority: "urgent",
      },
      {
        id: "esc-warning",
        criterionKeys: ["monitor_warning", "disk_warn", "updates_pending"],
        unassignedMinutes: 120,
        bumpPriority: "high",
      },
    ],
  },
  autoResolution: {
    enabled: true,
    requireAgentValidation: true,
    addRecoveryComment: true,
    suggestCloseAfterRecoveryMinutes: 60,
  },
  correlation: {
    enabled: true,
    windowMinutes: 30,
    minEquipments: 2,
    criterionKeys: ["monitor_critical", "agent_offline", "no_data"],
  },
  checkmkWebhook: {
    enabled: false,
    secret: null,
    triggerSync: true,
  },
};

export const DEFAULT_MONITORING_RUNBOOKS = [
  {
    id: "rb-monitor_critical",
    criterionKey: "monitor_critical",
    enabled: true,
    title: "Incident critique supervision",
    checklist: [
      "Consulter l'état des services sur la plateforme de supervision",
      "Identifier le service ou composant en cause",
      "Vérifier s'il s'agit d'un incident connu ou planifié",
      "Appliquer la procédure de remédiation adaptée",
      "Confirmer le retour à l'état nominal",
    ],
    docLinks: [],
    macroId: null,
    tags: ["surveillance", "critique"],
    priority: "high",
  },
  {
    id: "rb-monitor_warning",
    criterionKey: "monitor_warning",
    enabled: true,
    title: "Avertissement supervision",
    checklist: [
      "Analyser l'avertissement remonté",
      "Évaluer l'impact client",
      "Planifier une action corrective si nécessaire",
    ],
    docLinks: [],
    macroId: null,
    tags: ["surveillance", "warning"],
    priority: "normal",
  },
  {
    id: "rb-agent_offline",
    criterionKey: "agent_offline",
    enabled: true,
    title: "Agent RMM hors ligne",
    checklist: [
      "Vérifier l'alimentation et la connectivité réseau",
      "Contrôler le service agent sur le poste/serveur",
      "Contacter l'utilisateur si le poste est éteint",
      "Réinstaller l'agent si nécessaire",
    ],
    docLinks: [],
    macroId: null,
    tags: ["surveillance", "rmm"],
    priority: "high",
  },
  {
    id: "rb-disk_critical",
    criterionKey: "disk_critical",
    enabled: true,
    title: "Espace disque critique",
    checklist: [
      "Identifier le volume concerné",
      "Libérer de l'espace (temp, logs, corbeille)",
      "Planifier extension ou remplacement si récurrent",
    ],
    docLinks: [],
    macroId: null,
    tags: ["surveillance", "disque"],
    priority: "high",
  },
  {
    id: "rb-disk_warn",
    criterionKey: "disk_warn",
    enabled: true,
    title: "Espace disque à surveiller",
    checklist: [
      "Analyser la consommation disque",
      "Proposer un nettoyage ou une extension",
    ],
    docLinks: [],
    macroId: null,
    tags: ["surveillance", "disque"],
    priority: "normal",
  },
  {
    id: "rb-updates_pending",
    criterionKey: "updates_pending",
    enabled: true,
    title: "Mises à jour en attente",
    checklist: [
      "Vérifier les mises à jour en attente",
      "Planifier une fenêtre de maintenance",
      "Appliquer les correctifs selon la politique client",
    ],
    docLinks: [],
    macroId: null,
    tags: ["surveillance", "patching"],
    priority: "normal",
  },
  {
    id: "rb-unmapped",
    criterionKey: "unmapped",
    enabled: true,
    title: "Équipement non mappé supervision",
    checklist: [
      "Identifier l'hôte correspondant dans la supervision",
      "Configurer le mapping équipement ↔ hôte",
      "Valider la remontée des données",
    ],
    docLinks: [],
    macroId: null,
    tags: ["surveillance", "onboarding"],
    priority: "normal",
  },
  {
    id: "rb-no_data",
    criterionKey: "no_data",
    enabled: true,
    title: "Sans données supervision",
    checklist: [
      "Vérifier la connectivité vers la plateforme de supervision",
      "Contrôler le mapping et la dernière synchronisation",
      "Relancer une sync si nécessaire",
    ],
    docLinks: [],
    macroId: null,
    tags: ["surveillance"],
    priority: "normal",
  },
  {
    id: "rb-warranty_expired",
    criterionKey: "warranty_expired",
    enabled: true,
    title: "Garantie expirée",
    checklist: [
      "Vérifier la date de fin de garantie",
      "Proposer un renouvellement ou contrat de maintenance",
      "Mettre à jour la fiche équipement",
    ],
    docLinks: [],
    macroId: null,
    tags: ["préventif", "garantie"],
    priority: "normal",
  },
  {
    id: "rb-warranty_soon",
    criterionKey: "warranty_soon",
    enabled: true,
    title: "Garantie à renouveler",
    checklist: [
      "Anticiper le renouvellement avec le client",
      "Mettre à jour le contrat si renouvelé",
    ],
    docLinks: [],
    macroId: null,
    tags: ["préventif", "garantie"],
    priority: "low",
  },
  {
    id: "rb-maintenance_expired",
    criterionKey: "maintenance_expired",
    enabled: true,
    title: "Licence maintenance expirée",
    checklist: [
      "Vérifier le contrat de maintenance firewall",
      "Contacter le client pour renouvellement",
    ],
    docLinks: [],
    macroId: null,
    tags: ["préventif", "licence"],
    priority: "high",
  },
  {
    id: "rb-maintenance_soon",
    criterionKey: "maintenance_soon",
    enabled: true,
    title: "Licence maintenance à renouveler",
    checklist: [
      "Planifier le renouvellement avec le client",
    ],
    docLinks: [],
    macroId: null,
    tags: ["préventif", "licence"],
    priority: "normal",
  },
  {
    id: "rb-battery_expired",
    criterionKey: "battery_expired",
    enabled: true,
    title: "Batterie onduleur à remplacer",
    checklist: [
      "Planifier le remplacement de batterie",
      "Commander la pièce si nécessaire",
    ],
    docLinks: [],
    macroId: null,
    tags: ["préventif", "onduleur"],
    priority: "high",
  },
  {
    id: "rb-battery_soon",
    criterionKey: "battery_soon",
    enabled: true,
    title: "Batterie onduleur à surveiller",
    checklist: [
      "Anticiper le remplacement batterie",
    ],
    docLinks: [],
    macroId: null,
    tags: ["préventif", "onduleur"],
    priority: "normal",
  },
  {
    id: "rb-missing_ip",
    criterionKey: "missing_ip",
    enabled: true,
    title: "Adresse IP manquante",
    checklist: [
      "Compléter la fiche équipement avec l'adresse IP",
      "Vérifier la cohérence avec l'inventaire réseau",
    ],
    docLinks: [],
    macroId: null,
    tags: ["hygiène", "inventaire"],
    priority: "low",
  },
];

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object") {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

async function readJsonSingleton(tableName, fallback) {
  const result = await pool.query(`SELECT data FROM ${tableName} WHERE id = $1 LIMIT 1`, [SINGLETON_ID]);
  const raw = result.rows[0]?.data;
  if (!raw || typeof raw !== "object") return fallback;
  return deepMerge(fallback, raw);
}

async function writeJsonSingleton(tableName, data) {
  await pool.query(
    `INSERT INTO ${tableName} (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [SINGLETON_ID, JSON.stringify(data)]
  );
}

let configCache = null;
let configCacheAt = 0;
const CACHE_TTL_MS = 5000;

export async function getMonitoringAutomationConfig({ fresh = false } = {}) {
  if (!fresh && configCache && Date.now() - configCacheAt < CACHE_TTL_MS) {
    return configCache;
  }
  const merged = await readJsonSingleton(AUTOMATION_TABLE, DEFAULT_MONITORING_AUTOMATION_CONFIG);
  configCache = merged;
  configCacheAt = Date.now();
  return merged;
}

export async function saveMonitoringAutomationConfig(patch = {}) {
  const current = await getMonitoringAutomationConfig({ fresh: true });
  const merged = deepMerge(current, patch);
  await writeJsonSingleton(AUTOMATION_TABLE, merged);
  configCache = merged;
  configCacheAt = Date.now();
  return merged;
}

export async function getMonitoringRunbooks({ fresh = false } = {}) {
  const stored = await readJsonSingleton(RUNBOOKS_TABLE, DEFAULT_MONITORING_RUNBOOKS);
  if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_MONITORING_RUNBOOKS;
  return stored;
}

export async function saveMonitoringRunbooks(runbooks = []) {
  const list = Array.isArray(runbooks) ? runbooks : [];
  await writeJsonSingleton(RUNBOOKS_TABLE, list);
  return list;
}

export function getOfflineAlertThresholdMinutes(config) {
  const minutes = Number(config?.defaults?.offlineAlertThresholdMinutes);
  if (Number.isFinite(minutes) && minutes > 0) return minutes;
  return DEFAULT_MONITORING_AUTOMATION_CONFIG.defaults.offlineAlertThresholdMinutes;
}

/** Prefer threshold defined in Alert Rules; fallback to automation (legacy). */
export async function resolveOfflineAlertThresholdMinutes() {
  try {
    const rules = await getSupervisionAlertRules();
    return getOfflineAlertThresholdMinutesFromRules(rules);
  } catch {
    const config = await getMonitoringAutomationConfig();
    return getOfflineAlertThresholdMinutes(config);
  }
}

export function resolveMonitoringAssignees({ config, clientId, criterionKey }) {
  const assignment = config?.assignment || {};
  const clientRules = Array.isArray(assignment.clientRules) ? assignment.clientRules : [];
  const criterionRules = Array.isArray(assignment.criterionRules) ? assignment.criterionRules : [];

  const clientRule = clientRules.find((r) => String(r.clientId) === String(clientId));
  if (clientRule?.assigneeUserIds?.length) {
    const keys = clientRule.criterionKeys;
    if (!keys?.length || keys.includes(criterionKey)) {
      return { assigneeUserIds: clientRule.assigneeUserIds, teamIds: clientRule.teamIds || [] };
    }
  }

  const critRule = criterionRules.find((r) => r.criterionKey === criterionKey);
  if (critRule?.assigneeUserIds?.length) {
    return { assigneeUserIds: critRule.assigneeUserIds, teamIds: critRule.teamIds || [] };
  }

  return {
    assigneeUserIds: assignment.defaultAssigneeUserIds || [],
    teamIds: assignment.defaultTeamIds || [],
  };
}
