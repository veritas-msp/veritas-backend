import fetch from "node-fetch";
import { getAiConfig, assertAiFeatureEnabled, normalizeAiProvider, getDefaultModelForProvider, AI_PROVIDER_BASE_URLS } from "../utils/aiSettings.js";
import { assertAiQuotaAvailable, recordAiUsage } from "./aiUsageService.js";
const AI_LOCALES = {
  fr: {
    code: "fr",
    name: "French",
    outputInstruction: "Write ALL user-facing JSON text values (summary, insights, priorities, watchpoints, critical, strengths, risks, nextActions, reply, reason, title, checklist items, hypotheses, nextSteps, questionsToAsk, notes, etc.) in French. Keep JSON keys in English exactly as specified."
  },
  en: {
    code: "en",
    name: "English",
    outputInstruction: "Write ALL user-facing JSON text values (summary, insights, priorities, watchpoints, critical, strengths, risks, nextActions, reply, reason, title, checklist items, hypotheses, nextSteps, questionsToAsk, notes, etc.) in English. Keep JSON keys in English exactly as specified."
  },
  de: {
    code: "de",
    name: "German",
    outputInstruction: "Write ALL user-facing JSON text values (summary, insights, priorities, watchpoints, critical, strengths, risks, nextActions, reply, reason, title, checklist items, hypotheses, nextSteps, questionsToAsk, notes, etc.) in German. Keep JSON keys in English exactly as specified."
  },
  it: {
    code: "it",
    name: "Italian",
    outputInstruction: "Write ALL user-facing JSON text values (summary, insights, priorities, watchpoints, critical, strengths, risks, nextActions, reply, reason, title, checklist items, hypotheses, nextSteps, questionsToAsk, notes, etc.) in Italian. Keep JSON keys in English exactly as specified."
  },
  es: {
    code: "es",
    name: "Spanish",
    outputInstruction: "Write ALL user-facing JSON text values (summary, insights, priorities, watchpoints, critical, strengths, risks, nextActions, reply, reason, title, checklist items, hypotheses, nextSteps, questionsToAsk, notes, etc.) in Spanish. Keep JSON keys in English exactly as specified."
  }
};
function resolveAiLocale(locale) {
  const code = String(locale || "fr").toLowerCase().trim().slice(0, 2);
  return AI_LOCALES[code] || AI_LOCALES.fr;
}
function withLocaleInstruction(baseSystem, locale) {
  const aiLocale = resolveAiLocale(locale);
  return `${baseSystem}\n\n${aiLocale.outputInstruction}`;
}
function truncate(text, max = 6000) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
async function callOpenAiCompatible({
  baseUrl,
  apiKey,
  model,
  system,
  user,
  temperature = 0.3,
  jsonMode = true
}) {
  const root = String(baseUrl || "").replace(/\/$/, "");
  const body = {
    model,
    temperature,
    messages: [{
      role: "system",
      content: system
    }, {
      role: "user",
      content: user
    }]
  };
  if (jsonMode) {
    body.response_format = {
      type: "json_object"
    };
  }
  const response = await fetch(`${root}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `LLM HTTP ${response.status}`);
    err.code = "AI_PROVIDER_ERROR";
    throw err;
  }
  return {
    content: data?.choices?.[0]?.message?.content || "",
    promptTokens: data?.usage?.prompt_tokens || 0,
    completionTokens: data?.usage?.completion_tokens || 0
  };
}
async function callAnthropic({
  apiKey,
  model,
  system,
  user,
  temperature = 0.3
}) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature,
      system,
      messages: [{
        role: "user",
        content: `${user}\n\nRespond only with valid JSON.`
      }]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `Anthropic HTTP ${response.status}`);
    err.code = "AI_PROVIDER_ERROR";
    throw err;
  }
  const content = Array.isArray(data?.content) ? data.content.map(part => part?.text || "").join("\n") : "";
  return {
    content,
    promptTokens: data?.usage?.input_tokens || 0,
    completionTokens: data?.usage?.output_tokens || 0
  };
}
export async function completeAiJson(opts) {
  const config = await getAiConfig();
  if (!config.configured) {
    const err = new Error("AI is not configured or is disabled (Admin → Integrations → AI)");
    err.code = "AI_NOT_CONFIGURED";
    throw err;
  }
  assertAiFeatureEnabled(config, opts.feature);
  await assertAiQuotaAvailable(config, opts.feature);
  let result;
  try {
    if (config.provider === "anthropic") {
      result = await callAnthropic({
        apiKey: config.apiKey,
        model: config.model,
        system: opts.system,
        user: opts.user,
        temperature: opts.temperature
      });
    } else {
      const baseUrl = AI_PROVIDER_BASE_URLS[config.provider] || AI_PROVIDER_BASE_URLS.openai;
      result = await callOpenAiCompatible({
        baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        system: opts.system,
        user: opts.user,
        temperature: opts.temperature,
        jsonMode: config.provider === "openai"
      });
    }
  } catch (err) {
    await recordAiUsage({
      userId: opts.userId || null,
      feature: opts.feature,
      provider: config.provider,
      model: config.model,
      success: false,
      errorMessage: err.message
    }).catch(() => {});
    throw err;
  }
  await recordAiUsage({
    userId: opts.userId || null,
    feature: opts.feature,
    provider: config.provider,
    model: config.model,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    success: true
  }).catch(() => {});
  const parsed = extractJsonObject(result.content);
  if (!parsed || typeof parsed !== "object") {
    const err = new Error("Invalid AI response (JSON expected)");
    err.code = "AI_BAD_RESPONSE";
    throw err;
  }
  return {
    data: parsed,
    usage: {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: (result.promptTokens || 0) + (result.completionTokens || 0)
    },
    provider: config.provider,
    model: config.model
  };
}
export { truncate };
export async function suggestTicketReply({
  title,
  description,
  comments = [],
  locale = "fr",
  internal = false,
  userId = null
}) {
  const aiLocale = resolveAiLocale(locale);
  const thread = (Array.isArray(comments) ? comments : []).slice(-12).map(c => {
    const who = c.is_internal || c.isInternal ? "interne" : "public";
    const author = c.author_name || c.authorName || "agent";
    return `[${who}] ${author}: ${truncate(c.content || c.body || "", 800)}`;
  }).join("\n");
  const system = withLocaleInstruction('You are an MSP helpdesk copilot for Veritas. Draft a concise professional reply. Never invent credentials or guarantees. Return JSON: {"reply": "..."}.', locale);
  const user = [`Language: ${aiLocale.code} (${aiLocale.name})`, `Mode: ${internal ? "internal agent note" : "customer-facing reply"}`, `Title: ${truncate(title, 300)}`, `Description: ${truncate(description, 2500)}`, thread ? `Thread:\n${thread}` : "Thread: (empty)"].join("\n\n");
  const result = await completeAiJson({
    feature: internal ? "suggest_internal_note" : "suggest_reply",
    system,
    user,
    userId,
    temperature: 0.35
  });
  const reply = String(result.data.reply || result.data.text || "").trim();
  if (!reply) {
    const err = new Error("Empty suggestion");
    err.code = "AI_EMPTY";
    throw err;
  }
  return {
    reply,
    ...result
  };
}
export async function suggestTicketResolve({
  title,
  description,
  comments = [],
  interventionType = null,
  actionType = null,
  locale = "fr",
  userId = null
}) {
  const aiLocale = resolveAiLocale(locale);
  const thread = (Array.isArray(comments) ? comments : []).slice(-10).map(c => truncate(c.content || "", 600)).join("\n---\n");
  const system = withLocaleInstruction('You are an MSP helpdesk copilot. Draft a short resolution summary for closing a ticket. Return JSON: {"reason": "..."}.', locale);
  const user = [`Language: ${aiLocale.code} (${aiLocale.name})`, `Title: ${truncate(title, 300)}`, `Description: ${truncate(description, 2000)}`, interventionType ? `Intervention type: ${interventionType}` : null, actionType ? `Action: ${actionType}` : null, thread ? `Context:\n${thread}` : null].filter(Boolean).join("\n\n");
  const result = await completeAiJson({
    feature: "suggest_resolve",
    system,
    user,
    userId,
    temperature: 0.3
  });
  const reason = String(result.data.reason || result.data.reply || "").trim();
  if (!reason) {
    const err = new Error("Empty closure draft");
    err.code = "AI_EMPTY";
    throw err;
  }
  return {
    reason,
    ...result
  };
}
export async function generateRunbookChecklist({
  criterionKey,
  criterionLabel = null,
  title = null,
  existingChecklist = [],
  locale = "fr",
  userId = null
}) {
  const aiLocale = resolveAiLocale(locale);
  const system = withLocaleInstruction('You write MSP monitoring runbooks. Return JSON: {"title": "...", "checklist": ["step1", "step2", ...], "priority": "low|normal|high|urgent"}. 4 to 8 concrete steps.', locale);
  const user = [`Language: ${aiLocale.code} (${aiLocale.name})`, `Alert type: ${criterionKey}`, criterionLabel ? `Label: ${criterionLabel}` : null, title ? `Current title: ${title}` : null, existingChecklist?.length ? `Current checklist:\n${existingChecklist.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "Current checklist: (empty)"].filter(Boolean).join("\n\n");
  const result = await completeAiJson({
    feature: "generate_runbook",
    system,
    user,
    userId,
    temperature: 0.4
  });
  const checklist = Array.isArray(result.data.checklist) ? result.data.checklist.map(s => String(s || "").trim()).filter(Boolean) : [];
  if (!checklist.length) {
    const err = new Error("Generated checklist is empty");
    err.code = "AI_EMPTY";
    throw err;
  }
  const priority = ["low", "normal", "high", "urgent"].includes(String(result.data.priority || "").toLowerCase()) ? String(result.data.priority).toLowerCase() : "normal";
  return {
    title: String(result.data.title || title || criterionLabel || criterionKey).trim(),
    checklist,
    priority,
    ...result
  };
}
export async function helpDiagnoseTicket({
  title,
  description,
  comments = [],
  priority = null,
  category = null,
  locale = "fr",
  userId = null
}) {
  const aiLocale = resolveAiLocale(locale);
  const thread = (Array.isArray(comments) ? comments : []).slice(-15).map(c => {
    const who = c.is_internal || c.isInternal ? "interne" : "public";
    const author = c.author_name || c.authorName || "agent";
    return `[${who}] ${author}: ${truncate(c.content || c.body || "", 700)}`;
  }).join("\n");
  const system = withLocaleInstruction('You are an MSP senior engineer coaching a helpdesk agent. Do not invent credentials or claim fixes. Return JSON: {"summary":"...","hypotheses":["..."],"nextSteps":["..."],"questionsToAsk":["..."]}. Keep each list to 2-5 short items.', locale);
  const user = [`Language: ${aiLocale.code} (${aiLocale.name})`, `Title: ${truncate(title, 300)}`, priority ? `Priority: ${priority}` : null, category ? `Category: ${category}` : null, `Description: ${truncate(description, 2500)}`, thread ? `Thread:\n${thread}` : "Thread: (empty)"].filter(Boolean).join("\n\n");
  const result = await completeAiJson({
    feature: "help_me",
    system,
    user,
    userId,
    temperature: 0.35
  });
  const asList = value => (Array.isArray(value) ? value : []).map(item => String(item || "").trim()).filter(Boolean).slice(0, 6);
  return {
    summary: String(result.data.summary || "").trim(),
    hypotheses: asList(result.data.hypotheses),
    nextSteps: asList(result.data.nextSteps || result.data.next_steps),
    questionsToAsk: asList(result.data.questionsToAsk || result.data.questions_to_ask),
    ...result
  };
}
export async function generateSupportTicketRunbook({
  title,
  description,
  comments = [],
  priority = null,
  category = null,
  locale = "fr",
  userId = null
}) {
  const aiLocale = resolveAiLocale(locale);
  const thread = (Array.isArray(comments) ? comments : []).slice(-10).map(c => truncate(c.content || c.body || "", 500)).join("\n---\n");
  const system = withLocaleInstruction('You write an actionable MSP support runbook for ONE ticket. Return JSON: {"title":"...","checklist":["step1",...]}. 4 to 8 concrete steps. No credentials invented.', locale);
  const user = [`Language: ${aiLocale.code} (${aiLocale.name})`, `Title: ${truncate(title, 300)}`, priority ? `Priority: ${priority}` : null, category ? `Category: ${category}` : null, `Description: ${truncate(description, 2500)}`, thread ? `Context:\n${thread}` : null].filter(Boolean).join("\n\n");
  const result = await completeAiJson({
    feature: "ticket_runbook",
    system,
    user,
    userId,
    temperature: 0.35
  });
  const checklist = Array.isArray(result.data.checklist) ? result.data.checklist.map(s => String(s || "").trim()).filter(Boolean) : [];
  if (!checklist.length) {
    const err = new Error("Generated checklist is empty");
    err.code = "AI_EMPTY";
    throw err;
  }
  return {
    title: String(result.data.title || title || "Runbook").trim(),
    checklist,
    ...result
  };
}
export async function enrichAlertRunbook({
  criterionKey,
  criterionLabel = null,
  equipmentName = null,
  equipmentFamily = null,
  source = null,
  detail = null,
  baseRunbook = null,
  ticketTitle = null,
  ticketDescription = null,
  locale = "fr"
}) {
  const config = await getAiConfig();
  if (!config.configured || !config.features?.enrichMonitoringAlerts) {
    return null;
  }
  const aiLocale = resolveAiLocale(locale);
  const system = withLocaleInstruction('You are an MSP engineer. Enrich a runbook checklist for ONE concrete alert. Return JSON: {"checklist": ["..."], "notes": "short internal context"}. 3 to 8 actionable steps specific to the provided detail. Do not repeat secrets.', locale);
  const baseChecklist = Array.isArray(baseRunbook?.checklist) ? baseRunbook.checklist : [];
  const user = [`Language: ${aiLocale.code} (${aiLocale.name})`, `Alert: ${criterionKey} (${criterionLabel || criterionKey})`, `Equipment: ${equipmentName || "—"} / family ${equipmentFamily || "—"}`, `Source: ${source || "—"}`, ticketTitle ? `Ticket title: ${truncate(ticketTitle, 300)}` : null, ticketDescription ? `Description:\n${truncate(ticketDescription, 2500)}` : null, detail ? `Technical detail:\n${truncate(typeof detail === "string" ? detail : JSON.stringify(detail), 2500)}` : null, baseChecklist.length ? `Template runbook:\n${baseChecklist.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "Template runbook: (none)"].filter(Boolean).join("\n\n");
  try {
    const result = await completeAiJson({
      feature: "enrich_alert_runbook",
      system,
      user,
      userId: null,
      temperature: 0.25
    });
    const checklist = Array.isArray(result.data.checklist) ? result.data.checklist.map(s => String(s || "").trim()).filter(Boolean) : [];
    if (!checklist.length) return null;
    return {
      checklist,
      notes: String(result.data.notes || "").trim() || null,
      title: baseRunbook?.title || criterionLabel || criterionKey
    };
  } catch (err) {
    console.warn("[ai] enrichAlertRunbook skipped:", err.message);
    return null;
  }
}
export async function testAiConnection({
  provider,
  apiKey,
  model
} = {}) {
  const normalizedProvider = normalizeAiProvider(provider);
  if (!normalizedProvider) {
    const err = new Error('Invalid provider — use "openai", "anthropic", or "mammouth"');
    err.code = "AI_INVALID_PROVIDER";
    throw err;
  }
  const key = String(apiKey || "").trim();
  if (!key) {
    const err = new Error("Missing API key");
    err.code = "AI_NOT_CONFIGURED";
    throw err;
  }
  const resolvedModel = String(model || "").trim() || getDefaultModelForProvider(normalizedProvider);
  if (normalizedProvider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: 16,
        messages: [{
          role: "user",
          content: "ping"
        }]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data?.error?.message || `Anthropic HTTP ${response.status}`);
      err.code = "AI_PROVIDER_ERROR";
      throw err;
    }
  } else {
    const baseUrl = AI_PROVIDER_BASE_URLS[normalizedProvider];
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data?.error?.message || `LLM HTTP ${response.status}`);
      err.code = "AI_PROVIDER_ERROR";
      throw err;
    }
  }
  return {
    success: true,
    provider: normalizedProvider,
    model: resolvedModel
  };
}
function asStringList(value, max = 6) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || "").trim()).filter(Boolean).slice(0, max);
}
function slimStatsPayload(payload, maxChars = 12000) {
  try {
    const json = JSON.stringify(payload ?? {});
    if (json.length <= maxChars) return json;
    return `${json.slice(0, maxChars)}…`;
  } catch {
    return "{}";
  }
}
export async function generateDashboardBriefing({
  stats = {},
  source = "home",
  locale = "fr",
  userId = null
}) {
  const aiLocale = resolveAiLocale(locale);
  const system = withLocaleInstruction('You are an MSP operations analyst for Veritas. Analyze the KPI snapshot. Be factual, concise, actionable. Never invent numbers not present in the data. Return JSON: {"summary":"...","insights":["..."],"priorities":["..."],"watchpoints":["..."]}. 3-5 items per list max.', locale);
  const user = [`Language: ${aiLocale.code} (${aiLocale.name})`, `Source: ${source}`, `KPI snapshot:\n${slimStatsPayload(stats)}`].join("\n\n");
  const result = await completeAiJson({
    feature: "dashboard_briefing",
    system,
    user,
    userId,
    temperature: 0.3
  });
  const summary = String(result.data.summary || "").trim();
  if (!summary) {
    const err = new Error("Empty dashboard briefing");
    err.code = "AI_EMPTY";
    throw err;
  }
  return {
    summary,
    insights: asStringList(result.data.insights, 5),
    priorities: asStringList(result.data.priorities, 5),
    watchpoints: asStringList(result.data.watchpoints || result.data.alerts, 5),
    ...result
  };
}
export async function generateSupervisionBriefing({
  stats = {},
  locale = "fr",
  userId = null
}) {
  const aiLocale = resolveAiLocale(locale);
  const system = withLocaleInstruction('You are an MSP NOC lead. Prioritize monitoring and contract risks from the snapshot. Return JSON: {"summary":"...","critical":["..."],"priorities":["..."],"watchpoints":["..."]}. Keep lists short (2-5). Do not invent assets.', locale);
  const user = [`Language: ${aiLocale.code} (${aiLocale.name})`, `Supervision snapshot:\n${slimStatsPayload(stats)}`].join("\n\n");
  const result = await completeAiJson({
    feature: "supervision_briefing",
    system,
    user,
    userId,
    temperature: 0.3
  });
  const summary = String(result.data.summary || "").trim();
  if (!summary) {
    const err = new Error("Empty monitoring summary");
    err.code = "AI_EMPTY";
    throw err;
  }
  return {
    summary,
    critical: asStringList(result.data.critical, 5),
    priorities: asStringList(result.data.priorities, 5),
    watchpoints: asStringList(result.data.watchpoints, 5),
    ...result
  };
}
export async function generateEnterpriseSummary({
  profile = {},
  locale = "fr",
  userId = null
}) {
  const aiLocale = resolveAiLocale(locale);
  const system = withLocaleInstruction('You are an MSP account manager. Summarize one client account. Return JSON: {"summary":"...","strengths":["..."],"risks":["..."],"nextActions":["..."]}. 2-5 items per list. Stick to provided facts.', locale);
  const user = [`Language: ${aiLocale.code} (${aiLocale.name})`, `Client account:\n${slimStatsPayload(profile)}`].join("\n\n");
  const result = await completeAiJson({
    feature: "enterprise_summary",
    system,
    user,
    userId,
    temperature: 0.3
  });
  const summary = String(result.data.summary || "").trim();
  if (!summary) {
    const err = new Error("Empty company summary");
    err.code = "AI_EMPTY";
    throw err;
  }
  return {
    summary,
    strengths: asStringList(result.data.strengths, 5),
    risks: asStringList(result.data.risks, 5),
    nextActions: asStringList(result.data.nextActions || result.data.next_actions, 5),
    ...result
  };
}
