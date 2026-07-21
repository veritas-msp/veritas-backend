import express from "express";
import verifyJWT from "../../middleware/auth.js";
import { requireAnyPermission, requirePermission } from "../../middleware/permissions.js";
import { requireRole } from "../../middleware/roles.js";
import { pool } from "../../database/db.js";
import { getAiConfig, AI_FEATURE_LIMIT_KEYS } from "../../utils/aiSettings.js";
import { getAiCallsUsedTodayTotal, getAiFeatureUsageToday, getAiUsageBreakdownToday, listAiUsage } from "../../services/aiUsageService.js";
import { enrichAlertRunbook, generateDashboardBriefing, generateEnterpriseSummary, generateRunbookChecklist, generateSupervisionBriefing, generateSupportTicketRunbook, helpDiagnoseTicket, suggestTicketReply, suggestTicketResolve, testAiConnection } from "../../services/llmClient.js";
import { getCriterionLabel } from "../../services/monitoringTicketAssignment.js";
import { encryptSettingValue } from "../../utils/settingsHelper.js";
const router = express.Router();
router.use(verifyJWT);
function mapAiError(res, err) {
  const code = err?.code || "AI_ERROR";
  const status = code === "AI_NOT_CONFIGURED" ? 503 : code === "AI_QUOTA_EXCEEDED" ? 429 : code === "AI_FEATURE_DISABLED" ? 403 : code === "AI_PROVIDER_ERROR" ? 502 : code === "AI_INVALID_PROVIDER" ? 400 : 400;
  return res.status(status).json({
    error: err.message || "AI error",
    code,
    used: err.used,
    limit: err.limit
  });
}
async function upsertSetting(key, value, section = "ai", label = key) {
  const enc = encryptSettingValue(value == null ? "" : String(value));
  await pool.query(`INSERT INTO v_b_settings (key, value, value_encrypted, value_iv, value_auth_tag, section, label)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       value_encrypted = EXCLUDED.value_encrypted,
       value_iv = EXCLUDED.value_iv,
       value_auth_tag = EXCLUDED.value_auth_tag,
       section = EXCLUDED.section,
       label = EXCLUDED.label`, [key, enc.value, enc.value_encrypted, enc.value_iv, enc.value_auth_tag, section, label]);
}
router.get("/status", async (req, res) => {
  try {
    const config = await getAiConfig();
    const usedToday = await getAiCallsUsedTodayTotal().catch(() => 0);
    const breakdown = await getAiUsageBreakdownToday().catch(() => []);
    const featureUsage = await getAiFeatureUsageToday(config.featureLimits).catch(() => ({}));
    res.json({
      enabled: config.enabled,
      configured: config.configured,
      provider: config.provider,
      model: config.model,
      hasApiKey: Boolean(config.apiKey),
      enrichMonitoringAlerts: config.features.enrichMonitoringAlerts,
      features: config.features,
      featureLimits: config.featureLimits,
      featureUsage,
      usage: {
        usedToday,
        breakdown
      }
    });
  } catch (err) {
    console.error("[ai] status:", err.message);
    res.status(500).json({
      error: "Server error"
    });
  }
});
router.post("/test", requireRole("admin"), async (req, res) => {
  try {
    const body = req.body || {};
    const saved = await getAiConfig();
    const provider = body.provider != null && String(body.provider).trim() !== "" ? String(body.provider).trim() : saved.provider;
    const apiKeyFromBody = body.apiKey != null ? String(body.apiKey).trim() : "";
    const apiKey = apiKeyFromBody || saved.apiKey || "";
    const model = body.model != null && String(body.model).trim() !== "" ? String(body.model).trim() : saved.model;
    const result = await testAiConnection({
      provider,
      apiKey,
      model
    });
    res.json({
      success: true,
      message: "AI connection OK",
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    console.error("[ai] test:", err.message);
    return mapAiError(res, err);
  }
});
router.get("/usage", requireRole("admin"), async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    const data = await listAiUsage({
      limit,
      offset
    });
    res.json(data);
  } catch (err) {
    console.error("[ai] usage:", err.message);
    res.status(500).json({
      error: "Server error"
    });
  }
});
router.put("/policy", requireRole("admin"), async (req, res) => {
  try {
    const body = req.body || {};
    if (body.features && typeof body.features === "object") {
      const mapping = {
        suggestReply: ["AI_FEATURE_SUGGEST_REPLY", "AI · reply suggestion"],
        suggestResolve: ["AI_FEATURE_SUGGEST_RESOLVE", "AI · closure draft"],
        generateRunbook: ["AI_FEATURE_GENERATE_RUNBOOK", "AI · runbook generation"],
        enrichMonitoringAlerts: ["AI_ENRICH_MONITORING_ALERTS", "IA · enrichir alertes"],
        helpMe: ["AI_FEATURE_HELP_ME", "IA · Help Me diagnostic"],
        ticketRunbook: ["AI_FEATURE_TICKET_RUNBOOK", "AI · support ticket runbook"],
        dashboardBriefing: ["AI_FEATURE_DASHBOARD_BRIEFING", "IA · briefing dashboard KPI"],
        supervisionBriefing: ["AI_FEATURE_SUPERVISION_BRIEFING", "AI · monitoring summary"],
        enterpriseSummary: ["AI_FEATURE_ENTERPRISE_SUMMARY", "AI · company profile summary"]
      };
      for (const [key, [settingKey, label]] of Object.entries(mapping)) {
        if (body.features[key] !== undefined) {
          await upsertSetting(settingKey, body.features[key] ? "true" : "false", "ai", label);
        }
      }
    }
    if (body.featureLimits && typeof body.featureLimits === "object") {
      const labels = {
        suggestReply: "IA · limite / jour · réponses tickets",
        suggestResolve: "IA · limite / jour · résolutions",
        generateRunbook: "IA · limite / jour · runbooks",
        enrichMonitoringAlerts: "IA · limite / jour · alertes",
        helpMe: "IA · limite / jour · Help Me",
        ticketRunbook: "IA · limite / jour · runbooks tickets",
        dashboardBriefing: "IA · limite / jour · briefing dashboard",
        supervisionBriefing: "IA · limite / jour · briefing supervision",
        enterpriseSummary: "IA · limite / jour · résumé entreprise"
      };
      for (const [key, settingKey] of Object.entries(AI_FEATURE_LIMIT_KEYS)) {
        if (body.featureLimits[key] === undefined) continue;
        const n = Number.parseInt(String(body.featureLimits[key]), 10);
        if (!Number.isFinite(n) || n < 1 || n > 100000) {
          return res.status(400).json({
            error: `Invalid feature limit for ${key} (1–100000)`
          });
        }
        await upsertSetting(settingKey, String(n), "ai", labels[key] || settingKey);
      }
    }
    const config = await getAiConfig();
    const usedToday = await getAiCallsUsedTodayTotal().catch(() => 0);
    const featureUsage = await getAiFeatureUsageToday(config.featureLimits).catch(() => ({}));
    res.json({
      ok: true,
      enabled: config.enabled,
      configured: config.configured,
      features: config.features,
      featureLimits: config.featureLimits,
      featureUsage,
      usage: {
        usedToday
      }
    });
  } catch (err) {
    console.error("[ai] policy:", err.message);
    res.status(500).json({
      error: "Server error"
    });
  }
});
router.post("/suggest-reply", requireAnyPermission("tickets.edit", "tickets.manage"), async (req, res) => {
  try {
    const {
      ticketId,
      internal = false,
      locale
    } = req.body || {};
    if (!ticketId) return res.status(400).json({
      error: "ticketId required"
    });
    const ticketResult = await pool.query(`SELECT id, title, description FROM v_b_tickets WHERE id = $1::uuid LIMIT 1`, [ticketId]);
    const ticket = ticketResult.rows[0];
    if (!ticket) return res.status(404).json({
      error: "Ticket not found"
    });
    const commentsResult = await pool.query(`SELECT c.content, c.is_internal,
                COALESCE(NULLIF(TRIM(u.username), ''), u.email) AS author_name
         FROM v_b_ticket_comments c
         LEFT JOIN v_b_users u ON u.id = c.author_user_id
         WHERE c.ticket_id = $1::uuid
         ORDER BY c.created_at DESC
         LIMIT 20`, [ticketId]);
    const result = await suggestTicketReply({
      title: ticket.title,
      description: ticket.description,
      comments: commentsResult.rows.reverse(),
      locale: locale || "fr",
      internal: Boolean(internal),
      userId: req.user?.id || null
    });
    res.json({
      reply: result.reply,
      usage: result.usage,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    console.error("[ai] suggest-reply:", err.message);
    return mapAiError(res, err);
  }
});
router.post("/suggest-resolve", requireAnyPermission("tickets.edit", "tickets.manage"), async (req, res) => {
  try {
    const {
      ticketId,
      interventionType,
      actionType,
      locale
    } = req.body || {};
    if (!ticketId) return res.status(400).json({
      error: "ticketId required"
    });
    const ticketResult = await pool.query(`SELECT id, title, description FROM v_b_tickets WHERE id = $1::uuid LIMIT 1`, [ticketId]);
    const ticket = ticketResult.rows[0];
    if (!ticket) return res.status(404).json({
      error: "Ticket not found"
    });
    const commentsResult = await pool.query(`SELECT content FROM v_b_ticket_comments
         WHERE ticket_id = $1::uuid
         ORDER BY created_at DESC
         LIMIT 15`, [ticketId]);
    const result = await suggestTicketResolve({
      title: ticket.title,
      description: ticket.description,
      comments: commentsResult.rows.reverse(),
      interventionType,
      actionType,
      locale: locale || "fr",
      userId: req.user?.id || null
    });
    res.json({
      reason: result.reason,
      usage: result.usage,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    console.error("[ai] suggest-resolve:", err.message);
    return mapAiError(res, err);
  }
});
router.post("/generate-runbook", requirePermission("supervision.manage"), async (req, res) => {
  try {
    const {
      criterionKey,
      title,
      checklist,
      locale
    } = req.body || {};
    if (!criterionKey) return res.status(400).json({
      error: "criterionKey required"
    });
    const result = await generateRunbookChecklist({
      criterionKey: String(criterionKey),
      criterionLabel: getCriterionLabel(String(criterionKey)),
      title: title || null,
      existingChecklist: Array.isArray(checklist) ? checklist : [],
      locale: locale || "fr",
      userId: req.user?.id || null
    });
    res.json({
      title: result.title,
      checklist: result.checklist,
      priority: result.priority,
      usage: result.usage,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    console.error("[ai] generate-runbook:", err.message);
    return mapAiError(res, err);
  }
});
router.post("/help-me", requireAnyPermission("tickets.edit", "tickets.manage"), async (req, res) => {
  try {
    const {
      ticketId,
      locale
    } = req.body || {};
    if (!ticketId) return res.status(400).json({
      error: "ticketId required"
    });
    const ticketResult = await pool.query(`SELECT t.id, t.title, t.description, t.priority, t.category,
                cat.name AS category_name
         FROM v_b_tickets t
         LEFT JOIN v_b_ticket_categories cat ON cat.id = t.category
         WHERE t.id = $1::uuid
         LIMIT 1`, [ticketId]);
    const ticket = ticketResult.rows[0];
    if (!ticket) return res.status(404).json({
      error: "Ticket not found"
    });
    const commentsResult = await pool.query(`SELECT c.content, c.is_internal,
                COALESCE(NULLIF(TRIM(u.username), ''), u.email) AS author_name
         FROM v_b_ticket_comments c
         LEFT JOIN v_b_users u ON u.id = c.author_user_id
         WHERE c.ticket_id = $1::uuid
         ORDER BY c.created_at DESC
         LIMIT 20`, [ticketId]);
    const result = await helpDiagnoseTicket({
      title: ticket.title,
      description: ticket.description,
      comments: commentsResult.rows.reverse(),
      priority: ticket.priority,
      category: ticket.category_name || ticket.category,
      locale: locale || "fr",
      userId: req.user?.id || null
    });
    res.json({
      summary: result.summary,
      hypotheses: result.hypotheses,
      nextSteps: result.nextSteps,
      questionsToAsk: result.questionsToAsk,
      usage: result.usage,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    console.error("[ai] help-me:", err.message);
    return mapAiError(res, err);
  }
});
router.post("/generate-ticket-runbook", requireAnyPermission("tickets.edit", "tickets.manage"), async (req, res) => {
  try {
    const {
      ticketId,
      locale
    } = req.body || {};
    if (!ticketId) return res.status(400).json({
      error: "ticketId required"
    });
    const ticketResult = await pool.query(`SELECT t.id, t.title, t.description, t.priority, t.category,
                cat.name AS category_name
         FROM v_b_tickets t
         LEFT JOIN v_b_ticket_categories cat ON cat.id = t.category
         WHERE t.id = $1::uuid
         LIMIT 1`, [ticketId]);
    const ticket = ticketResult.rows[0];
    if (!ticket) return res.status(404).json({
      error: "Ticket not found"
    });
    const commentsResult = await pool.query(`SELECT content FROM v_b_ticket_comments
         WHERE ticket_id = $1::uuid
         ORDER BY created_at DESC
         LIMIT 15`, [ticketId]);
    const result = await generateSupportTicketRunbook({
      title: ticket.title,
      description: ticket.description,
      comments: commentsResult.rows.reverse(),
      priority: ticket.priority,
      category: ticket.category_name || ticket.category,
      locale: locale || "fr",
      userId: req.user?.id || null
    });
    const checklist = Array.isArray(result.checklist) ? result.checklist : [];
    const aiRunbook = {
      title: String(result.title || "").trim() || "Runbook",
      checklist,
      checked: Object.fromEntries(checklist.map((_, idx) => [`step-${idx}`, false])),
      generatedAt: new Date().toISOString(),
      generatedBy: req.user?.id || null,
      updatedAt: new Date().toISOString()
    };
    try {
      await pool.query(`UPDATE v_b_tickets
           SET ai_runbook = $1::jsonb, updated_at = NOW()
           WHERE id = $2::uuid`, [JSON.stringify(aiRunbook), ticketId]);
    } catch (persistErr) {
      if (persistErr?.code !== "42703") throw persistErr;
      console.warn("[ai] generate-ticket-runbook: ai_runbook column missing, not persisted");
    }
    res.json({
      title: aiRunbook.title,
      checklist: aiRunbook.checklist,
      checked: aiRunbook.checked,
      ai_runbook: aiRunbook,
      usage: result.usage,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    console.error("[ai] generate-ticket-runbook:", err.message);
    return mapAiError(res, err);
  }
});
router.post("/enrich-alert-runbook", requirePermission("supervision.manage"), async (req, res) => {
  try {
    const body = req.body || {};
    const enriched = await enrichAlertRunbook({
      criterionKey: body.criterionKey,
      criterionLabel: getCriterionLabel(body.criterionKey),
      equipmentName: body.equipmentName,
      equipmentFamily: body.equipmentFamily,
      source: body.source,
      detail: body.detail,
      baseRunbook: body.baseRunbook || null,
      ticketTitle: body.ticketTitle,
      ticketDescription: body.ticketDescription,
      locale: body.locale || "fr"
    });
    if (!enriched) {
      return res.status(503).json({
        error: "Enrichment unavailable (AI off or error)",
        code: "AI_ENRICH_UNAVAILABLE"
      });
    }
    res.json(enriched);
  } catch (err) {
    console.error("[ai] enrich-alert-runbook:", err.message);
    return mapAiError(res, err);
  }
});
router.post("/dashboard-briefing", async (req, res) => {
  try {
    const {
      stats,
      source,
      locale
    } = req.body || {};
    if (!stats || typeof stats !== "object") {
      return res.status(400).json({
        error: "stats required"
      });
    }
    const result = await generateDashboardBriefing({
      stats,
      source: source || "home",
      locale: locale || "fr",
      userId: req.user?.id || null
    });
    res.json({
      summary: result.summary,
      insights: result.insights,
      priorities: result.priorities,
      watchpoints: result.watchpoints,
      usage: result.usage,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    console.error("[ai] dashboard-briefing:", err.message);
    return mapAiError(res, err);
  }
});
router.post("/supervision-briefing", requireAnyPermission("supervision.view", "infrastructure.view"), async (req, res) => {
  try {
    const {
      stats,
      locale
    } = req.body || {};
    if (!stats || typeof stats !== "object") {
      return res.status(400).json({
        error: "stats required"
      });
    }
    const result = await generateSupervisionBriefing({
      stats,
      locale: locale || "fr",
      userId: req.user?.id || null
    });
    res.json({
      summary: result.summary,
      critical: result.critical,
      priorities: result.priorities,
      watchpoints: result.watchpoints,
      usage: result.usage,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    console.error("[ai] supervision-briefing:", err.message);
    return mapAiError(res, err);
  }
});
router.post("/enterprise-summary", requirePermission("clients.view"), async (req, res) => {
  try {
    const {
      profile,
      locale
    } = req.body || {};
    if (!profile || typeof profile !== "object") {
      return res.status(400).json({
        error: "profile required"
      });
    }
    const result = await generateEnterpriseSummary({
      profile,
      locale: locale || "fr",
      userId: req.user?.id || null
    });
    res.json({
      summary: result.summary,
      strengths: result.strengths,
      risks: result.risks,
      nextActions: result.nextActions,
      usage: result.usage,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    console.error("[ai] enterprise-summary:", err.message);
    return mapAiError(res, err);
  }
});
export default router;
