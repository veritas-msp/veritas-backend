import { pool } from "../database/db.js";
import { getOfflineAlertThresholdMinutesFromRules, getSupervisionAlertRules } from "./supervisionAlertRules.js";
const AUTOMATION_TABLE = "v_b_monitoring_automation_config";
const RUNBOOKS_TABLE = "v_b_monitoring_runbooks_config";
const SINGLETON_ID = 1;
export const DEFAULT_MONITORING_AUTOMATION_CONFIG = {
  version: 1,
  defaults: {
    alertsEnabledOnEnroll: true,
    alertsEnabledOnNewEquipment: false,
    offlineAlertThresholdMinutes: 2880
  },
  assignment: {
    defaultAssigneeUserIds: [],
    defaultTeamIds: [],
    clientRules: [],
    criterionRules: []
  },
  escalation: {
    enabled: true,
    rules: [{
      id: "esc-critical",
      criterionKeys: ["monitor_critical", "agent_offline", "disk_critical"],
      unassignedMinutes: 30,
      bumpPriority: "urgent"
    }, {
      id: "esc-warning",
      criterionKeys: ["monitor_warning", "disk_warn", "updates_pending"],
      unassignedMinutes: 120,
      bumpPriority: "high"
    }]
  },
  autoResolution: {
    enabled: true,
    requireAgentValidation: true,
    addRecoveryComment: true,
    suggestCloseAfterRecoveryMinutes: 60
  },
  correlation: {
    enabled: true,
    windowMinutes: 30,
    minEquipments: 2,
    criterionKeys: ["monitor_critical", "agent_offline", "no_data"]
  },
  checkmkWebhook: {
    enabled: false,
    secret: null,
    triggerSync: true
  }
};
export const DEFAULT_MONITORING_RUNBOOKS = [{
  id: "rb-monitor_critical",
  criterionKey: "monitor_critical",
  enabled: true,
  title: "Critical monitoring incident",
  checklist: ["Review service status on the monitoring platform", "Identify the affected service or component", "Check whether the incident is known or planned", "Apply the appropriate remediation procedure", "Confirm the return to normal status"],
  docLinks: [],
  macroId: null,
  tags: ["surveillance", "critique"],
  priority: "high"
}, {
  id: "rb-monitor_warning",
  criterionKey: "monitor_warning",
  enabled: true,
  title: "Monitoring warning",
  checklist: ["Analyze the reported warning", "Assess the customer impact", "Plan corrective action if needed"],
  docLinks: [],
  macroId: null,
  tags: ["surveillance", "warning"],
  priority: "normal"
}, {
  id: "rb-agent_offline",
  criterionKey: "agent_offline",
  enabled: true,
  title: "RMM agent offline",
  checklist: ["Check power and network connectivity", "Check the agent service on the workstation/server", "Contact the user if the workstation is powered off", "Reinstall the agent if needed"],
  docLinks: [],
  macroId: null,
  tags: ["surveillance", "rmm"],
  priority: "high"
}, {
  id: "rb-disk_critical",
  criterionKey: "disk_critical",
  enabled: true,
  title: "Critical disk space",
  checklist: ["Identify the affected volume", "Free up space (temporary files, logs, recycle bin)", "Plan an expansion or replacement if recurring"],
  docLinks: [],
  macroId: null,
  tags: ["surveillance", "disque"],
  priority: "high"
}, {
  id: "rb-disk_warn",
  criterionKey: "disk_warn",
  enabled: true,
  title: "Disk space to monitor",
  checklist: ["Analyze disk usage", "Propose cleanup or expansion"],
  docLinks: [],
  macroId: null,
  tags: ["surveillance", "disque"],
  priority: "normal"
}, {
  id: "rb-updates_pending",
  criterionKey: "updates_pending",
  enabled: true,
  title: "Pending updates",
  checklist: ["Check pending updates", "Schedule a maintenance window", "Apply patches according to the customer policy"],
  docLinks: [],
  macroId: null,
  tags: ["surveillance", "patching"],
  priority: "normal"
}, {
  id: "rb-unmapped",
  criterionKey: "unmapped",
  enabled: true,
  title: "Unmapped monitoring equipment",
  checklist: ["Identify the matching host in monitoring", "Configure the equipment-to-host mapping", "Validate incoming data"],
  docLinks: [],
  macroId: null,
  tags: ["surveillance", "onboarding"],
  priority: "normal"
}, {
  id: "rb-no_data",
  criterionKey: "no_data",
  enabled: true,
  title: "No monitoring data",
  checklist: ["Check connectivity to the monitoring platform", "Check the mapping and latest synchronization", "Run synchronization again if needed"],
  docLinks: [],
  macroId: null,
  tags: ["surveillance"],
  priority: "normal"
}, {
  id: "rb-warranty_expired",
  criterionKey: "warranty_expired",
  enabled: true,
  title: "Warranty expired",
  checklist: ["Check the warranty end date", "Propose a renewal or maintenance contract", "Update the equipment record"],
  docLinks: [],
  macroId: null,
  tags: ["preventive", "warranty"],
  priority: "normal"
}, {
  id: "rb-warranty_soon",
  criterionKey: "warranty_soon",
  enabled: true,
  title: "Warranty due for renewal",
  checklist: ["Plan the renewal with the customer", "Update the contract if renewed"],
  docLinks: [],
  macroId: null,
  tags: ["preventive", "warranty"],
  priority: "low"
}, {
  id: "rb-maintenance_expired",
  criterionKey: "maintenance_expired",
  enabled: true,
  title: "Maintenance license expired",
  checklist: ["Check the firewall maintenance contract", "Contact the customer for renewal"],
  docLinks: [],
  macroId: null,
  tags: ["preventive", "license"],
  priority: "high"
}, {
  id: "rb-maintenance_soon",
  criterionKey: "maintenance_soon",
  enabled: true,
  title: "Maintenance license due for renewal",
  checklist: ["Schedule the renewal with the customer"],
  docLinks: [],
  macroId: null,
  tags: ["preventive", "license"],
  priority: "normal"
}, {
  id: "rb-battery_expired",
  criterionKey: "battery_expired",
  enabled: true,
  title: "UPS battery needs replacement",
  checklist: ["Schedule battery replacement", "Order the part if needed"],
  docLinks: [],
  macroId: null,
  tags: ["preventive", "ups"],
  priority: "high"
}, {
  id: "rb-battery_soon",
  criterionKey: "battery_soon",
  enabled: true,
  title: "UPS battery to monitor",
  checklist: ["Plan the battery replacement"],
  docLinks: [],
  macroId: null,
  tags: ["preventive", "ups"],
  priority: "normal"
}, {
  id: "rb-missing_ip",
  criterionKey: "missing_ip",
  enabled: true,
  title: "Missing IP address",
  checklist: ["Complete the equipment record with the IP address", "Verify consistency with the network inventory"],
  docLinks: [],
  macroId: null,
  tags: ["hygiene", "inventory"],
  priority: "low"
}];
function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = {
    ...base
  };
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
  await pool.query(`INSERT INTO ${tableName} (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [SINGLETON_ID, JSON.stringify(data)]);
}
let configCache = null;
let configCacheAt = 0;
const CACHE_TTL_MS = 5000;
export async function getMonitoringAutomationConfig({
  fresh = false
} = {}) {
  if (!fresh && configCache && Date.now() - configCacheAt < CACHE_TTL_MS) {
    return configCache;
  }
  const merged = await readJsonSingleton(AUTOMATION_TABLE, DEFAULT_MONITORING_AUTOMATION_CONFIG);
  configCache = merged;
  configCacheAt = Date.now();
  return merged;
}
export async function saveMonitoringAutomationConfig(patch = {}) {
  const current = await getMonitoringAutomationConfig({
    fresh: true
  });
  const merged = deepMerge(current, patch);
  await writeJsonSingleton(AUTOMATION_TABLE, merged);
  configCache = merged;
  configCacheAt = Date.now();
  return merged;
}
export async function getMonitoringRunbooks({
  fresh = false
} = {}) {
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
export async function resolveOfflineAlertThresholdMinutes() {
  try {
    const rules = await getSupervisionAlertRules();
    return getOfflineAlertThresholdMinutesFromRules(rules);
  } catch {
    const config = await getMonitoringAutomationConfig();
    return getOfflineAlertThresholdMinutes(config);
  }
}
export function resolveMonitoringAssignees({
  config,
  clientId,
  criterionKey
}) {
  const assignment = config?.assignment || {};
  const clientRules = Array.isArray(assignment.clientRules) ? assignment.clientRules : [];
  const criterionRules = Array.isArray(assignment.criterionRules) ? assignment.criterionRules : [];
  const clientRule = clientRules.find(r => String(r.clientId) === String(clientId));
  if (clientRule?.assigneeUserIds?.length) {
    const keys = clientRule.criterionKeys;
    if (!keys?.length || keys.includes(criterionKey)) {
      return {
        assigneeUserIds: clientRule.assigneeUserIds,
        teamIds: clientRule.teamIds || []
      };
    }
  }
  const critRule = criterionRules.find(r => r.criterionKey === criterionKey);
  if (critRule?.assigneeUserIds?.length) {
    return {
      assigneeUserIds: critRule.assigneeUserIds,
      teamIds: critRule.teamIds || []
    };
  }
  return {
    assigneeUserIds: assignment.defaultAssigneeUserIds || [],
    teamIds: assignment.defaultTeamIds || []
  };
}
