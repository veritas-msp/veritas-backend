import { getSettingsMap } from "./settingsHelper.js";

export const AI_FEATURE_LIMIT_KEYS = {
  suggestReply: "AI_LIMIT_SUGGEST_REPLY",
  suggestResolve: "AI_LIMIT_SUGGEST_RESOLVE",
  generateRunbook: "AI_LIMIT_GENERATE_RUNBOOK",
  enrichMonitoringAlerts: "AI_LIMIT_ENRICH_MONITORING_ALERTS",
  helpMe: "AI_LIMIT_HELP_ME",
  ticketRunbook: "AI_LIMIT_TICKET_RUNBOOK",
  dashboardBriefing: "AI_LIMIT_DASHBOARD_BRIEFING",
  supervisionBriefing: "AI_LIMIT_SUPERVISION_BRIEFING",
  enterpriseSummary: "AI_LIMIT_ENTERPRISE_SUMMARY"
};

/** Maps recorded usage feature → policy/limit key */
export const AI_USAGE_FEATURE_TO_LIMIT_KEY = {
  suggest_reply: "suggestReply",
  suggest_internal_note: "suggestReply",
  suggest_resolve: "suggestResolve",
  generate_runbook: "generateRunbook",
  enrich_alert_runbook: "enrichMonitoringAlerts",
  help_me: "helpMe",
  ticket_runbook: "ticketRunbook",
  dashboard_briefing: "dashboardBriefing",
  supervision_briefing: "supervisionBriefing",
  enterprise_summary: "enterpriseSummary"
};

/** Usage feature codes that share the same daily limit bucket */
export const AI_LIMIT_KEY_TO_USAGE_FEATURES = {
  suggestReply: ["suggest_reply", "suggest_internal_note"],
  suggestResolve: ["suggest_resolve"],
  generateRunbook: ["generate_runbook"],
  enrichMonitoringAlerts: ["enrich_alert_runbook"],
  helpMe: ["help_me"],
  ticketRunbook: ["ticket_runbook"],
  dashboardBriefing: ["dashboard_briefing"],
  supervisionBriefing: ["supervision_briefing"],
  enterpriseSummary: ["enterprise_summary"]
};

export const AI_SETTING_KEYS = ["INTEGRATION_AI_ENABLED", "AI_PROVIDER", "AI_API_KEY", "AI_MODEL", "AI_ENRICH_MONITORING_ALERTS", "AI_FEATURE_SUGGEST_REPLY", "AI_FEATURE_SUGGEST_RESOLVE", "AI_FEATURE_GENERATE_RUNBOOK", "AI_FEATURE_HELP_ME", "AI_FEATURE_TICKET_RUNBOOK", "AI_FEATURE_DASHBOARD_BRIEFING", "AI_FEATURE_SUPERVISION_BRIEFING", "AI_FEATURE_ENTERPRISE_SUMMARY", ...Object.values(AI_FEATURE_LIMIT_KEYS)];

export const AI_PROVIDERS = ["openai", "anthropic", "mammouth"];

const DEFAULTS = {
  provider: "openai",
  modelByProvider: {
    openai: "gpt-4o-mini",
    anthropic: "claude-3-5-haiku-latest",
    mammouth: "mammouth-recommended"
  },
  featureLimits: {
    suggestReply: 100,
    suggestResolve: 50,
    generateRunbook: 30,
    enrichMonitoringAlerts: 100,
    helpMe: 50,
    ticketRunbook: 50,
    dashboardBriefing: 40,
    supervisionBriefing: 40,
    enterpriseSummary: 40
  }
};

export const AI_PROVIDER_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  mammouth: "https://api.mammouth.ai/v1"
};

function parseBool(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "oui"].includes(normalized)) return true;
  if (["false", "0", "no", "non"].includes(normalized)) return false;
  return fallback;
}

function parseLimit(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(100000, n);
}

export function normalizeAiProvider(raw) {
  const p = String(raw || "").toLowerCase().trim();
  if (!p || p === "openai") return "openai";
  if (p === "anthropic") return "anthropic";
  if (p === "mammouth" || p === "mamouth") return "mammouth";
  return null;
}

export function getDefaultModelForProvider(provider) {
  return DEFAULTS.modelByProvider[provider] || DEFAULTS.modelByProvider.openai;
}

export function resolveAiLimitKey(usageFeature) {
  return AI_USAGE_FEATURE_TO_LIMIT_KEY[String(usageFeature || "").trim()] || null;
}

export async function getAiConfig() {
  const map = await getSettingsMap(AI_SETTING_KEYS);
  const enabled = parseBool(map.INTEGRATION_AI_ENABLED, false);
  const providerRaw = String(map.AI_PROVIDER || DEFAULTS.provider).toLowerCase().trim();
  const provider = normalizeAiProvider(providerRaw) || DEFAULTS.provider;
  const apiKey = String(map.AI_API_KEY || "").trim() || null;
  const model = String(map.AI_MODEL || "").trim() || getDefaultModelForProvider(provider);
  const featureLimits = {};
  for (const [key, settingKey] of Object.entries(AI_FEATURE_LIMIT_KEYS)) {
    featureLimits[key] = parseLimit(map[settingKey], DEFAULTS.featureLimits[key]);
  }
  return {
    enabled,
    provider,
    apiKey,
    model,
    featureLimits,
    features: {
      suggestReply: parseBool(map.AI_FEATURE_SUGGEST_REPLY, true),
      suggestResolve: parseBool(map.AI_FEATURE_SUGGEST_RESOLVE, true),
      generateRunbook: parseBool(map.AI_FEATURE_GENERATE_RUNBOOK, true),
      enrichMonitoringAlerts: parseBool(map.AI_ENRICH_MONITORING_ALERTS, true),
      helpMe: parseBool(map.AI_FEATURE_HELP_ME, true),
      ticketRunbook: parseBool(map.AI_FEATURE_TICKET_RUNBOOK, true),
      dashboardBriefing: parseBool(map.AI_FEATURE_DASHBOARD_BRIEFING, true),
      supervisionBriefing: parseBool(map.AI_FEATURE_SUPERVISION_BRIEFING, true),
      enterpriseSummary: parseBool(map.AI_FEATURE_ENTERPRISE_SUMMARY, true)
    },
    enrichMonitoringAlerts: parseBool(map.AI_ENRICH_MONITORING_ALERTS, true),
    configured: Boolean(enabled && apiKey)
  };
}

export function assertAiFeatureEnabled(config, featureKey) {
  const map = {
    suggest_reply: "suggestReply",
    suggest_internal_note: "suggestReply",
    suggest_resolve: "suggestResolve",
    generate_runbook: "generateRunbook",
    enrich_alert_runbook: "enrichMonitoringAlerts",
    help_me: "helpMe",
    ticket_runbook: "ticketRunbook",
    dashboard_briefing: "dashboardBriefing",
    supervision_briefing: "supervisionBriefing",
    enterprise_summary: "enterpriseSummary"
  };
  const flag = map[featureKey];
  if (!flag) return;
  if (config.features?.[flag] === false) {
    const err = new Error("AI feature disabled in Admin → AI");
    err.code = "AI_FEATURE_DISABLED";
    throw err;
  }
}
