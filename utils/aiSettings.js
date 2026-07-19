import { getSettingsMap } from "./settingsHelper.js";

export const AI_SETTING_KEYS = [
  "INTEGRATION_AI_ENABLED",
  "AI_PROVIDER",
  "AI_API_KEY",
  "AI_MODEL",
  "AI_MAX_TOKENS_PER_DAY",
  "AI_ENRICH_MONITORING_ALERTS",
  "AI_FEATURE_SUGGEST_REPLY",
  "AI_FEATURE_SUGGEST_RESOLVE",
  "AI_FEATURE_GENERATE_RUNBOOK",
  "AI_FEATURE_HELP_ME",
  "AI_FEATURE_TICKET_RUNBOOK",
  "AI_FEATURE_DASHBOARD_BRIEFING",
  "AI_FEATURE_SUPERVISION_BRIEFING",
  "AI_FEATURE_ENTERPRISE_SUMMARY",
];

export const AI_PROVIDERS = ["openai", "anthropic", "mammouth"];

const DEFAULTS = {
  provider: "openai",
  modelByProvider: {
    openai: "gpt-4o-mini",
    anthropic: "claude-3-5-haiku-latest",
    mammouth: "mammouth-recommended",
  },
  maxTokensPerDay: 200000,
};

/** Base URL OpenAI-compatible (chat/completions, models). */
export const AI_PROVIDER_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  mammouth: "https://api.mammouth.ai/v1",
};

function parseBool(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "oui"].includes(normalized)) return true;
  if (["false", "0", "no", "non"].includes(normalized)) return false;
  return fallback;
}

/**
 * Normalise le fournisseur saisi (accepte la faute « mamouth »).
 * @returns {'openai'|'anthropic'|'mammouth'|null}
 */
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

export async function getAiConfig() {
  const map = await getSettingsMap(AI_SETTING_KEYS);
  const enabled = parseBool(map.INTEGRATION_AI_ENABLED, false);
  const providerRaw = String(map.AI_PROVIDER || DEFAULTS.provider).toLowerCase().trim();
  const provider = normalizeAiProvider(providerRaw) || DEFAULTS.provider;
  const apiKey = String(map.AI_API_KEY || "").trim() || null;
  const model =
    String(map.AI_MODEL || "").trim() || getDefaultModelForProvider(provider);
  const maxTokensPerDay = Number.parseInt(String(map.AI_MAX_TOKENS_PER_DAY || ""), 10);

  return {
    enabled,
    provider,
    apiKey,
    model,
    maxTokensPerDay: Number.isFinite(maxTokensPerDay) && maxTokensPerDay > 0
      ? maxTokensPerDay
      : DEFAULTS.maxTokensPerDay,
    features: {
      suggestReply: parseBool(map.AI_FEATURE_SUGGEST_REPLY, true),
      suggestResolve: parseBool(map.AI_FEATURE_SUGGEST_RESOLVE, true),
      generateRunbook: parseBool(map.AI_FEATURE_GENERATE_RUNBOOK, true),
      enrichMonitoringAlerts: parseBool(map.AI_ENRICH_MONITORING_ALERTS, true),
      helpMe: parseBool(map.AI_FEATURE_HELP_ME, true),
      ticketRunbook: parseBool(map.AI_FEATURE_TICKET_RUNBOOK, true),
      dashboardBriefing: parseBool(map.AI_FEATURE_DASHBOARD_BRIEFING, true),
      supervisionBriefing: parseBool(map.AI_FEATURE_SUPERVISION_BRIEFING, true),
      enterpriseSummary: parseBool(map.AI_FEATURE_ENTERPRISE_SUMMARY, true),
    },
    /** @deprecated use features.enrichMonitoringAlerts */
    enrichMonitoringAlerts: parseBool(map.AI_ENRICH_MONITORING_ALERTS, true),
    configured: Boolean(enabled && apiKey),
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
    enterprise_summary: "enterpriseSummary",
  };
  const flag = map[featureKey];
  if (!flag) return;
  if (config.features?.[flag] === false) {
    const err = new Error("Fonctionnalité IA désactivée dans Admin → IA");
    err.code = "AI_FEATURE_DISABLED";
    throw err;
  }
}
