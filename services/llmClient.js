import fetch from "node-fetch";
import {
  getAiConfig,
  assertAiFeatureEnabled,
  normalizeAiProvider,
  getDefaultModelForProvider,
  AI_PROVIDER_BASE_URLS,
} from "../utils/aiSettings.js";
import {
  assertAiQuotaAvailable,
  recordAiUsage,
} from "./aiUsageService.js";

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

/** Appel chat/completions compatible OpenAI (OpenAI, Mammouth, …). */
async function callOpenAiCompatible({
  baseUrl,
  apiKey,
  model,
  system,
  user,
  temperature = 0.3,
  jsonMode = true,
}) {
  const root = String(baseUrl || "").replace(/\/$/, "");
  const body = {
    model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  // Mammouth / agrégateurs : response_format JSON pas toujours supporté
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const response = await fetch(`${root}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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
    completionTokens: data?.usage?.completion_tokens || 0,
  };
}

async function callAnthropic({ apiKey, model, system, user, temperature = 0.3 }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature,
      system,
      messages: [{ role: "user", content: `${user}\n\nRéponds uniquement en JSON valide.` }],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `Anthropic HTTP ${response.status}`);
    err.code = "AI_PROVIDER_ERROR";
    throw err;
  }
  const content = Array.isArray(data?.content)
    ? data.content.map((part) => part?.text || "").join("\n")
    : "";
  return {
    content,
    promptTokens: data?.usage?.input_tokens || 0,
    completionTokens: data?.usage?.output_tokens || 0,
  };
}

/**
 * @param {{ feature: string, system: string, user: string, userId?: string|null, temperature?: number }} opts
 */
export async function completeAiJson(opts) {
  const config = await getAiConfig();
  if (!config.configured) {
    const err = new Error("IA non configurée ou désactivée (Admin → Interconnexions → IA)");
    err.code = "AI_NOT_CONFIGURED";
    throw err;
  }

  assertAiFeatureEnabled(config, opts.feature);

  await assertAiQuotaAvailable(config.maxTokensPerDay, 500);

  let result;
  try {
    if (config.provider === "anthropic") {
      result = await callAnthropic({
        apiKey: config.apiKey,
        model: config.model,
        system: opts.system,
        user: opts.user,
        temperature: opts.temperature,
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
        // OpenAI natif : json_object ; Mammouth : prompt JSON uniquement
        jsonMode: config.provider === "openai",
      });
    }
  } catch (err) {
    await recordAiUsage({
      userId: opts.userId || null,
      feature: opts.feature,
      provider: config.provider,
      model: config.model,
      success: false,
      errorMessage: err.message,
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
    success: true,
  }).catch(() => {});

  const parsed = extractJsonObject(result.content);
  if (!parsed || typeof parsed !== "object") {
    const err = new Error("Réponse IA invalide (JSON attendu)");
    err.code = "AI_BAD_RESPONSE";
    throw err;
  }

  return {
    data: parsed,
    usage: {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: (result.promptTokens || 0) + (result.completionTokens || 0),
    },
    provider: config.provider,
    model: config.model,
  };
}

export { truncate };

export async function suggestTicketReply({
  title,
  description,
  comments = [],
  locale = "fr",
  internal = false,
  userId = null,
}) {
  const lang = String(locale || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  const thread = (Array.isArray(comments) ? comments : [])
    .slice(-12)
    .map((c) => {
      const who = c.is_internal || c.isInternal ? "interne" : "public";
      const author = c.author_name || c.authorName || "agent";
      return `[${who}] ${author}: ${truncate(c.content || c.body || "", 800)}`;
    })
    .join("\n");

  const system =
    lang === "en"
      ? "You are an MSP helpdesk copilot for Veritas. Draft a concise professional reply. Never invent credentials or guarantees. Return JSON: {\"reply\": \"...\"}."
      : "Tu es un copilote MSP Veritas. Rédige une réponse professionnelle et concise. N'invente jamais d'identifiants ni de garanties. Réponds en JSON: {\"reply\": \"...\"}.";

  const user = [
    `Langue: ${lang}`,
    `Mode: ${internal ? "commentaire interne agent" : "réponse client"}`,
    `Titre: ${truncate(title, 300)}`,
    `Description: ${truncate(description, 2500)}`,
    thread ? `Fil de discussion:\n${thread}` : "Fil: (vide)",
  ].join("\n\n");

  const result = await completeAiJson({
    feature: internal ? "suggest_internal_note" : "suggest_reply",
    system,
    user,
    userId,
    temperature: 0.35,
  });

  const reply = String(result.data.reply || result.data.text || "").trim();
  if (!reply) {
    const err = new Error("Suggestion vide");
    err.code = "AI_EMPTY";
    throw err;
  }
  return { reply, ...result };
}

export async function suggestTicketResolve({
  title,
  description,
  comments = [],
  interventionType = null,
  actionType = null,
  locale = "fr",
  userId = null,
}) {
  const lang = String(locale || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  const thread = (Array.isArray(comments) ? comments : [])
    .slice(-10)
    .map((c) => truncate(c.content || "", 600))
    .join("\n---\n");

  const system =
    lang === "en"
      ? "You are an MSP helpdesk copilot. Draft a short resolution summary for closing a ticket. Return JSON: {\"reason\": \"...\"}."
      : "Tu es un copilote MSP. Rédige un court message de résolution pour clôturer un ticket. Réponds en JSON: {\"reason\": \"...\"}.";

  const user = [
    `Langue: ${lang}`,
    `Titre: ${truncate(title, 300)}`,
    `Description: ${truncate(description, 2000)}`,
    interventionType ? `Type intervention: ${interventionType}` : null,
    actionType ? `Action: ${actionType}` : null,
    thread ? `Contexte:\n${thread}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await completeAiJson({
    feature: "suggest_resolve",
    system,
    user,
    userId,
    temperature: 0.3,
  });

  const reason = String(result.data.reason || result.data.reply || "").trim();
  if (!reason) {
    const err = new Error("Brouillon de clôture vide");
    err.code = "AI_EMPTY";
    throw err;
  }
  return { reason, ...result };
}

export async function generateRunbookChecklist({
  criterionKey,
  criterionLabel = null,
  title = null,
  existingChecklist = [],
  locale = "fr",
  userId = null,
}) {
  const lang = String(locale || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  const system =
    lang === "en"
      ? "You write MSP monitoring runbooks. Return JSON: {\"title\": \"...\", \"checklist\": [\"step1\", \"step2\", ...], \"priority\": \"low|normal|high|urgent\"}. 4 to 8 concrete steps."
      : "Tu rédiges des runbooks MSP de supervision. Réponds en JSON: {\"title\": \"...\", \"checklist\": [\"étape1\", ...], \"priority\": \"low|normal|high|urgent\"}. 4 à 8 étapes concrètes.";

  const user = [
    `Langue: ${lang}`,
    `Type d'alerte: ${criterionKey}`,
    criterionLabel ? `Libellé: ${criterionLabel}` : null,
    title ? `Titre actuel: ${title}` : null,
    existingChecklist?.length
      ? `Checklist actuelle:\n${existingChecklist.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "Checklist actuelle: (vide)",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await completeAiJson({
    feature: "generate_runbook",
    system,
    user,
    userId,
    temperature: 0.4,
  });

  const checklist = Array.isArray(result.data.checklist)
    ? result.data.checklist.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  if (!checklist.length) {
    const err = new Error("Checklist générée vide");
    err.code = "AI_EMPTY";
    throw err;
  }

  const priority = ["low", "normal", "high", "urgent"].includes(
    String(result.data.priority || "").toLowerCase()
  )
    ? String(result.data.priority).toLowerCase()
    : "normal";

  return {
    title: String(result.data.title || title || criterionLabel || criterionKey).trim(),
    checklist,
    priority,
    ...result,
  };
}

/**
 * Coach diagnostic pour un ticket support (AI Help Me).
 */
export async function helpDiagnoseTicket({
  title,
  description,
  comments = [],
  priority = null,
  category = null,
  locale = "fr",
  userId = null,
}) {
  const lang = String(locale || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  const thread = (Array.isArray(comments) ? comments : [])
    .slice(-15)
    .map((c) => {
      const who = c.is_internal || c.isInternal ? "interne" : "public";
      const author = c.author_name || c.authorName || "agent";
      return `[${who}] ${author}: ${truncate(c.content || c.body || "", 700)}`;
    })
    .join("\n");

  const system =
    lang === "en"
      ? 'You are an MSP senior engineer coaching a helpdesk agent. Do not invent credentials or claim fixes. Return JSON: {"summary":"...","hypotheses":["..."],"nextSteps":["..."],"questionsToAsk":["..."]}. Keep each list to 2-5 short items.'
      : 'Tu es un ingénieur MSP senior qui coache un agent helpdesk. N\'invente pas d\'identifiants ni de garanties. Réponds en JSON: {"summary":"...","hypotheses":["..."],"nextSteps":["..."],"questionsToAsk":["..."]}. 2 à 5 items courts par liste.';

  const user = [
    `Langue: ${lang}`,
    `Titre: ${truncate(title, 300)}`,
    priority ? `Priorité: ${priority}` : null,
    category ? `Catégorie: ${category}` : null,
    `Description: ${truncate(description, 2500)}`,
    thread ? `Fil:\n${thread}` : "Fil: (vide)",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await completeAiJson({
    feature: "help_me",
    system,
    user,
    userId,
    temperature: 0.35,
  });

  const asList = (value) =>
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 6);

  return {
    summary: String(result.data.summary || "").trim(),
    hypotheses: asList(result.data.hypotheses),
    nextSteps: asList(result.data.nextSteps || result.data.next_steps),
    questionsToAsk: asList(result.data.questionsToAsk || result.data.questions_to_ask),
    ...result,
  };
}

/**
 * Checklist runbook ad-hoc pour un ticket support (pas monitoring).
 */
export async function generateSupportTicketRunbook({
  title,
  description,
  comments = [],
  priority = null,
  category = null,
  locale = "fr",
  userId = null,
}) {
  const lang = String(locale || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  const thread = (Array.isArray(comments) ? comments : [])
    .slice(-10)
    .map((c) => truncate(c.content || c.body || "", 500))
    .join("\n---\n");

  const system =
    lang === "en"
      ? 'You write an actionable MSP support runbook for ONE ticket. Return JSON: {"title":"...","checklist":["step1",...]}. 4 to 8 concrete steps. No credentials invented.'
      : 'Tu rédiges un runbook MSP actionnable pour UN ticket support. Réponds en JSON: {"title":"...","checklist":["étape1",...]}. 4 à 8 étapes concrètes. N\'invente pas d\'identifiants.';

  const user = [
    `Langue: ${lang}`,
    `Titre: ${truncate(title, 300)}`,
    priority ? `Priorité: ${priority}` : null,
    category ? `Catégorie: ${category}` : null,
    `Description: ${truncate(description, 2500)}`,
    thread ? `Contexte:\n${thread}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await completeAiJson({
    feature: "ticket_runbook",
    system,
    user,
    userId,
    temperature: 0.35,
  });

  const checklist = Array.isArray(result.data.checklist)
    ? result.data.checklist.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  if (!checklist.length) {
    const err = new Error("Checklist générée vide");
    err.code = "AI_EMPTY";
    throw err;
  }

  return {
    title: String(result.data.title || title || "Runbook").trim(),
    checklist,
    ...result,
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
}) {
  const config = await getAiConfig();
  if (!config.configured || !config.features?.enrichMonitoringAlerts) {
    return null;
  }

  const system =
    "Tu es un ingénieur MSP. Enrichis une checklist de runbook pour UNE alerte concrète. Réponds en JSON: {\"checklist\": [\"...\"], \"notes\": \"court contexte interne\"}. 3 à 8 étapes actionnables, spécifiques au détail fourni. Ne répète pas de secrets.";

  const baseChecklist = Array.isArray(baseRunbook?.checklist) ? baseRunbook.checklist : [];
  const user = [
    `Alerte: ${criterionKey} (${criterionLabel || criterionKey})`,
    `Équipement: ${equipmentName || "—"} / famille ${equipmentFamily || "—"}`,
    `Source: ${source || "—"}`,
    ticketTitle ? `Titre ticket: ${truncate(ticketTitle, 300)}` : null,
    ticketDescription ? `Description:\n${truncate(ticketDescription, 2500)}` : null,
    detail ? `Détail technique:\n${truncate(typeof detail === "string" ? detail : JSON.stringify(detail), 2500)}` : null,
    baseChecklist.length
      ? `Runbook modèle:\n${baseChecklist.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "Runbook modèle: (aucun)",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const result = await completeAiJson({
      feature: "enrich_alert_runbook",
      system,
      user,
      userId: null,
      temperature: 0.25,
    });
    const checklist = Array.isArray(result.data.checklist)
      ? result.data.checklist.map((s) => String(s || "").trim()).filter(Boolean)
      : [];
    if (!checklist.length) return null;
    return {
      checklist,
      notes: String(result.data.notes || "").trim() || null,
      title: baseRunbook?.title || criterionLabel || criterionKey,
    };
  } catch (err) {
    console.warn("[ai] enrichAlertRunbook skipped:", err.message);
    return null;
  }
}

/**
 * Ping léger du provider avec une config fournie (brouillon formulaire, hors DB).
 * Ne consomme pas le quota journalier.
 */
export async function testAiConnection({ provider, apiKey, model } = {}) {
  const normalizedProvider = normalizeAiProvider(provider);
  if (!normalizedProvider) {
    const err = new Error(
      'Fournisseur invalide — utilisez "openai", "anthropic" ou "mammouth"'
    );
    err.code = "AI_INVALID_PROVIDER";
    throw err;
  }
  const key = String(apiKey || "").trim();
  if (!key) {
    const err = new Error("Clé API manquante");
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
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
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
      headers: { Authorization: `Bearer ${key}` },
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
    model: resolvedModel,
  };
}

function asStringList(value, max = 6) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, max);
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

/**
 * Briefing analytique pour Home / Dashboard KPI.
 * @param {{ stats: object, source?: string, locale?: string, userId?: string|null }} opts
 */
export async function generateDashboardBriefing({
  stats = {},
  source = "home",
  locale = "fr",
  userId = null,
}) {
  const lang = String(locale || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  const system =
    lang === "en"
      ? 'You are an MSP operations analyst for Veritas. Analyze the KPI snapshot. Be factual, concise, actionable. Never invent numbers not present in the data. Return JSON: {"summary":"...","insights":["..."],"priorities":["..."],"watchpoints":["..."]}. 3-5 items per list max.'
      : 'Tu es un analyste opérations MSP pour Veritas. Analyse le snapshot KPI. Sois factuel, concis, actionnable. N\'invente jamais de chiffres absents des données. Réponds en JSON: {"summary":"...","insights":["..."],"priorities":["..."],"watchpoints":["..."]}. 3 à 5 items max par liste.';

  const user = [
    `Langue: ${lang}`,
    `Source: ${source}`,
    `Snapshot KPI:\n${slimStatsPayload(stats)}`,
  ].join("\n\n");

  const result = await completeAiJson({
    feature: "dashboard_briefing",
    system,
    user,
    userId,
    temperature: 0.3,
  });

  const summary = String(result.data.summary || "").trim();
  if (!summary) {
    const err = new Error("Briefing dashboard vide");
    err.code = "AI_EMPTY";
    throw err;
  }

  return {
    summary,
    insights: asStringList(result.data.insights, 5),
    priorities: asStringList(result.data.priorities, 5),
    watchpoints: asStringList(result.data.watchpoints || result.data.alerts, 5),
    ...result,
  };
}

/**
 * Synthèse du centre de supervision (alertes / todos).
 */
export async function generateSupervisionBriefing({
  stats = {},
  locale = "fr",
  userId = null,
}) {
  const lang = String(locale || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  const system =
    lang === "en"
      ? 'You are an MSP NOC lead. Prioritize monitoring and contract risks from the snapshot. Return JSON: {"summary":"...","critical":["..."],"priorities":["..."],"watchpoints":["..."]}. Keep lists short (2-5). Do not invent assets.'
      : 'Tu es un responsable NOC MSP. Priorise les risques monitoring et contrats à partir du snapshot. Réponds en JSON: {"summary":"...","critical":["..."],"priorities":["..."],"watchpoints":["..."]}. Listes courtes (2-5). N\'invente pas d\'équipements.';

  const user = [
    `Langue: ${lang}`,
    `Snapshot supervision:\n${slimStatsPayload(stats)}`,
  ].join("\n\n");

  const result = await completeAiJson({
    feature: "supervision_briefing",
    system,
    user,
    userId,
    temperature: 0.3,
  });

  const summary = String(result.data.summary || "").trim();
  if (!summary) {
    const err = new Error("Synthèse supervision vide");
    err.code = "AI_EMPTY";
    throw err;
  }

  return {
    summary,
    critical: asStringList(result.data.critical, 5),
    priorities: asStringList(result.data.priorities, 5),
    watchpoints: asStringList(result.data.watchpoints, 5),
    ...result,
  };
}

/**
 * Résumé 360° d'une fiche entreprise.
 */
export async function generateEnterpriseSummary({
  profile = {},
  locale = "fr",
  userId = null,
}) {
  const lang = String(locale || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  const system =
    lang === "en"
      ? 'You are an MSP account manager. Summarize one client account. Return JSON: {"summary":"...","strengths":["..."],"risks":["..."],"nextActions":["..."]}. 2-5 items per list. Stick to provided facts.'
      : 'Tu es un chargé de compte MSP. Résume le dossier d\'un client. Réponds en JSON: {"summary":"...","strengths":["..."],"risks":["..."],"nextActions":["..."]}. 2 à 5 items par liste. Reste factuel.';

  const user = [
    `Langue: ${lang}`,
    `Dossier client:\n${slimStatsPayload(profile)}`,
  ].join("\n\n");

  const result = await completeAiJson({
    feature: "enterprise_summary",
    system,
    user,
    userId,
    temperature: 0.3,
  });

  const summary = String(result.data.summary || "").trim();
  if (!summary) {
    const err = new Error("Résumé entreprise vide");
    err.code = "AI_EMPTY";
    throw err;
  }

  return {
    summary,
    strengths: asStringList(result.data.strengths, 5),
    risks: asStringList(result.data.risks, 5),
    nextActions: asStringList(result.data.nextActions || result.data.next_actions, 5),
    ...result,
  };
}

