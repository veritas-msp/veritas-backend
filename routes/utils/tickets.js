import express from "express";
import { body, param, query, validationResult } from "express-validator";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requirePermission, requireAnyPermission } from "../../middleware/permissions.js";
import fs from "fs";
import path from "path";
import multer from "multer";
import { dispatchNotificationEvent } from "../../services/notificationDispatcher.js";
import { notifyInAppTicketAssigned, notifyInAppTicketCommented, notifyInAppTicketCreated, notifyInAppTicketStatusChanged, normalizeInAppSettings } from "../../services/userNotificationService.js";
import { getTicketSatisfaction, listTicketSatisfactions, countTicketSatisfactions, enrichTicketRowsWithSatisfaction } from "../../services/ticketSatisfactionService.js";
import { ensureTicketStatusMatchesValidation, getTicketResolutionValidation, markResolutionValidationReopened, resolveTicketWithClientValidation } from "../../services/ticketResolutionValidationService.js";
import { listSolutionCatalog, createSolutionCatalogEntry, updateSolutionCatalogEntry, deleteSolutionCatalogEntry } from "../../services/ticketSolutionCatalogService.js";
import { loadExclusionRulesRaw, loadMailCollectorsRaw, loadNotificationSettingsRaw, loadTicketAutomationRawConfig, saveMailCollectorsRaw, saveNotificationLogsRaw, saveTicketAutomationRawConfig } from "../../services/ticketAutomationConfigStore.js";
import { resolveClientIdForTicket, getTicketCreditStatus, handleTicketStatusCreditChange } from "../../services/supportCredits.js";
import ticketViewsRoutes from "./ticketViewsRoutes.js";
import { upsertUserSetting } from "../../utils/userSettingsStore.js";
import {
  loadPublicTicketTableColumns,
  savePublicTicketTableColumns,
  loadPrivateTicketTableColumns,
  resolveEffectiveTicketTableColumns,
  normalizeTicketTableColumns,
  DEFAULT_TICKET_TABLE_COLUMNS,
  TICKET_TABLE_COLUMNS_PRIVATE_SETTING_KEY
} from "../../utils/ticketTableColumns.js";
import salesFormsRoutes from "./salesFormsRoutes.js";
import { applyFormTicketTargets, buildTicketTitle, loadFormTicketTargetsConfig, mergeCreateOptionsFromTargets, normalizeTicketTargets, resolveAssigneeUserIds, resolveMatchingRules } from "../../services/salesFormTicketTargets.js";
import { resolveClientIdFromRequesterContact, shouldSyncTicketPlanningEvents, syncTicketPlanningEventClient } from "./ticketPlanningSync.js";
import { buildSlaInfoForTicket, enrichTicketWithSla, ensureTicketSlaInfoStored, loadClientContrat, maybeRecordTakeoverSla, persistTicketSlaInfoIfMissing, resolveTicketSlaInfo } from "../../utils/ticketSla.js";
import { loadSlaSettings } from "../../utils/slaSettingsStore.js";
import { maybeSendWhatsAppReplyForComment } from "../../services/whatsappService.js";
import { loadAuthorProfilesByUserIds } from "../../utils/userAvatar.js";
import { requirePro } from "../../middleware/edition.js";
import { appendCommunityTicketFilters, COMMUNITY_SALES_TICKET_SQL, isSalesTicketRow, rejectCommunitySalesTicketCreate, rejectCommunitySalesTicketUpdate, sendProSalesTicketError } from "../../utils/ticketEditionGuard.js";
import { isCommunity } from "../../utils/edition.js";
import { assertCommunityTicketAutomationLimits, sendCommunityLimitError } from "../../utils/communityLimits.js";
import { appendCollectorLogInConfig, filterExclusionRulesForCollector, normalizeMailCollector, processMailCollector, withImapClient } from "../../services/mailCollectorIngest.js";
import { normalizeMailCollectSettings } from "../../services/mailCollectSettings.js";
import { getAllMatchingExclusionRules, normalizeExclusionRule } from "../../services/mailIngestionRules.js";
import { searchTicketsPaged, TICKET_SEARCH_MAX_LIMIT, resolveTicketListSchema } from "../../services/ticketPagedListService.js";
import { logTicketActivity, logTicketFieldChanges, listTicketActivity } from "../../services/ticketActivityService.js";
const router = express.Router();
router.use(verifyJWT);
const TICKET_UPLOAD_DIR = path.resolve(process.cwd(), "uploads", "tickets");
fs.mkdirSync(TICKET_UPLOAD_DIR, {
  recursive: true
});
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx", ".csv", ".xls", ".xlsx", ".mp4", ".3gp", ".mp3", ".mpeg", ".ogg", ".aac", ".amr", ".m4a"]);
const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TICKET_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeName = String(file.originalname || "attachment").replace(/[^\w.\-]+/g, "_").slice(0, 120);
    cb(null, `${Date.now()}-${safeName}`);
  }
});
const attachmentUpload = multer({
  storage: attachmentStorage,
  limits: {
    fileSize: 15 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(String(file.originalname || "")).toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) {
      return cb(new Error("Type de finon allowed. Accepted formats: PDF, JPG, PNG, DOC, DOCX, CSV, XLS, XLSX, MP4, 3GP, MP3, OGG, AAC, AMR, M4A."));
    }
    cb(null, true);
  }
});
const STATUS_VALUES = ["open", "new", "pending", "in_progress", "resolved", "closed"];
const PRIORITY_VALUES = ["low", "normal", "high", "urgent"];
function normalizeTicketStatusValue(status) {
  return String(status || "").toLowerCase();
}
function isTicketClosedStatus(status) {
  return normalizeTicketStatusValue(status) === "closed";
}
function isTicketLockedForEdits(ticketRow) {
  if (!ticketRow) return true;
  if (Boolean(ticketRow.is_deleted)) return true;
  return isTicketClosedStatus(ticketRow.status);
}
const FIRST_TAKEOVER_AT_SQL = `(SELECT h.created_at
           FROM v_b_ticket_status_history h
           WHERE h.ticket_id = t.id
             AND LOWER(COALESCE(h.old_status, '')) IN ('new', 'open', '')
             AND LOWER(COALESCE(h.new_status, '')) NOT IN ('new', 'open', '')
           ORDER BY h.created_at ASC
           LIMIT 1) AS first_takeover_at`;
let requesterContactColumnExistsCache = null;
let ticketAssigneesTableExistsCache = null;
const ticketColumnExistsCache = new Map();
const ticketCommentColumnExistsCache = new Map();
const DEFAULT_TICKET_AUTOMATION_CONFIG = {
  commentTemplates: [],
  macros: [],
  emailInboxes: [],
  exclusionRules: [],
  autoReplyRules: [],
  autoReplyTemplate: "",
  notificationSettings: {
    onTicketCreated: false,
    onTicketResolved: false,
    onTicketCommented: false,
    eventToggles: {
      ticketCreated: false,
      ticketResolved: false,
      ticketCommented: false,
      ticketAutoReply: false
    },
    webhooks: [],
    notificationEvents: [{
      id: "notif-event-default-1",
      source: "tickets",
      element: "created",
      scopeType: "all",
      enterpriseId: "",
      daysBefore: 30,
      channel: "webhook",
      webhookId: "",
      emailTo: "",
      emailCc: "",
      useTemplate: false,
      templateId: "",
      customMessage: "",
      teamsThemeColor: "#13BA8E",
      enabled: true
    }, {
      id: "notif-event-default-2",
      source: "tickets",
      element: "updated",
      scopeType: "all",
      enterpriseId: "",
      daysBefore: 30,
      channel: "webhook",
      webhookId: "",
      emailTo: "",
      emailCc: "",
      useTemplate: false,
      templateId: "",
      customMessage: "",
      teamsThemeColor: "#13BA8E",
      enabled: true
    }],
    logs: []
  },
  scheduledAlertRules: [],
  mailCollectors: [],
  mailCollectSettings: normalizeMailCollectSettings()
};
function normalizeIncomingStatus(status) {
  if (!status) return status;
  return status === "new" ? "open" : status;
}
function isAdminUser(req) {
  return String(req.user?.role || "").toLowerCase() === "admin";
}
function validationErrorOrNull(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json({
    error: "Validation error",
    errors: errors.array()
  });
}
const normalizeTicketAutomationTemplate = (row, idx) => ({
  id: row?.id || `tpl-${Date.now()}-${idx}`,
  name: String(row?.name || "").trim() || `Template ${idx + 1}`,
  content: String(row?.content || "")
});
const normalizeTicketAutomationMacro = (row, idx) => ({
  id: row?.id || `macro-${Date.now()}-${idx}`,
  name: String(row?.name || "").trim() || `Macro ${idx + 1}`,
  actions: Array.isArray(row?.actions) ? row.actions.map((action, actionIdx) => ({
    id: action?.id || `macro-action-${Date.now()}-${idx}-${actionIdx}`,
    type: String(action?.type || "set_field").trim() || "set_field",
    field: String(action?.field || "").trim(),
    fieldMode: String(action?.fieldMode || "").trim(),
    value: String(action?.value || ""),
    comment: String(action?.comment || ""),
    commentTemplateId: String(action?.commentTemplateId || ""),
    isInternal: Boolean(action?.isInternal),
    emailTo: String(action?.emailTo || ""),
    emailCc: String(action?.emailCc || ""),
    emailSubject: String(action?.emailSubject || ""),
    emailBody: String(action?.emailBody || ""),
    teamsWebhookId: String(action?.teamsWebhookId || action?.webhookId || ""),
    teamsTitle: String(action?.teamsTitle || ""),
    teamsMessage: String(action?.teamsMessage || ""),
    teamsThemeColor: String(action?.teamsThemeColor || "#13BA8E"),
    reminderTitle: String(action?.reminderTitle || ""),
    reminderOffsetMinutes: String(action?.reminderOffsetMinutes ?? "60"),
    reminderNote: String(action?.reminderNote || ""),
    tagsMode: String(action?.tagsMode || "add").trim() || "add",
    phoneNumber: String(action?.phoneNumber || ""),
    ticketId: String(action?.ticketId || ""),
    equipmentId: String(action?.equipmentId || ""),
    tagsText: String(action?.tagsText || "")
  })).filter(action => action.type) : [...(row?.status ? [{
    id: "legacy-status",
    type: "set_field",
    field: "status",
    value: String(row.status)
  }] : []), ...(row?.assignToSelf ? [{
    id: "legacy-assignee",
    type: "set_field",
    field: "assigned_to_me",
    value: "true"
  }] : []), ...(row?.emailSubject || row?.emailBody ? [{
    id: "legacy-email",
    type: "open_email",
    emailSubject: String(row?.emailSubject || ""),
    emailBody: String(row?.emailBody || "")
  }] : [])]
});
const normalizeTicketAutomationInbox = (row, idx) => ({
  id: row?.id || `inbox-${Date.now()}-${idx}`,
  address: String(row?.address || "").trim(),
  enabled: row?.enabled !== false,
  provider: String(row?.provider || "").trim()
});
const normalizeTicketAutomationExclusion = normalizeExclusionRule;
const normalizeTicketAutomationAutoReplyRule = (row, idx) => ({
  id: row?.id || `autoreply-${Date.now()}-${idx}`,
  matchOn: String(row?.matchOn || "requester_email").trim() || "requester_email",
  operator: String(row?.operator || "contains").trim() || "contains",
  value: String(row?.value || "").trim(),
  enabled: row?.enabled !== false
});
const normalizeNotificationSettings = row => ({
  onTicketCreated: Boolean(row?.onTicketCreated),
  onTicketResolved: Boolean(row?.onTicketResolved),
  onTicketCommented: Boolean(row?.onTicketCommented),
  eventToggles: {
    ticketCreated: Boolean(row?.eventToggles?.ticketCreated ?? row?.onTicketCreated),
    ticketResolved: Boolean(row?.eventToggles?.ticketResolved ?? row?.onTicketResolved),
    ticketCommented: Boolean(row?.eventToggles?.ticketCommented ?? row?.onTicketCommented),
    ticketAutoReply: Boolean(row?.eventToggles?.ticketAutoReply)
  },
  webhooks: Array.isArray(row?.webhooks) ? row.webhooks.map((webhook, idx) => ({
    id: String(webhook?.id || `notif-webhook-${Date.now()}-${idx}`),
    name: String(webhook?.name || "").trim() || `Webhook ${idx + 1}`,
    channel: String(webhook?.channel || "teams").trim() || "teams",
    channelName: String(webhook?.channelName || "").trim(),
    url: String(webhook?.url || "").trim(),
    enabled: webhook?.enabled !== false
  })) : [],
  notificationEvents: (Array.isArray(row?.notificationEvents) && row.notificationEvents.length > 0 ? row.notificationEvents : DEFAULT_TICKET_AUTOMATION_CONFIG.notificationSettings.notificationEvents).map((eventItem, idx) => ({
    id: String(eventItem?.id || `notif-event-${Date.now()}-${idx}`),
    source: String(eventItem?.source || "tickets").trim().toLowerCase() || "tickets",
    element: String(eventItem?.element || "updated").trim().toLowerCase() || "updated",
    scopeType: String(eventItem?.scopeType || "all").trim().toLowerCase() === "enterprise" ? "enterprise" : "all",
    enterpriseId: String(eventItem?.enterpriseId || "").trim(),
    daysBefore: Number.isFinite(Number(eventItem?.daysBefore)) ? Number(eventItem.daysBefore) : 30,
    channel: String(eventItem?.channel || "webhook").trim().toLowerCase() || "webhook",
    webhookId: String(eventItem?.webhookId || "").trim(),
    emailTo: String(eventItem?.emailTo || "").trim(),
    emailCc: String(eventItem?.emailCc || "").trim(),
    useTemplate: eventItem?.useTemplate === true,
    templateId: String(eventItem?.templateId || "").trim(),
    customMessage: String(eventItem?.customMessage || ""),
    teamsThemeColor: String(eventItem?.teamsThemeColor || "#13BA8E"),
    enabled: eventItem?.enabled !== false
  })),
  logs: Array.isArray(row?.logs) ? row.logs.map((log, idx) => ({
    id: String(log?.id || `notif-log-${Date.now()}-${idx}`),
    createdAt: String(log?.createdAt || new Date().toISOString()),
    source: String(log?.source || "").trim(),
    element: String(log?.element || "").trim(),
    channel: String(log?.channel || "").trim(),
    status: String(log?.status || "").trim() || "info",
    message: String(log?.message || "").trim(),
    enterpriseId: String(log?.enterpriseId || "").trim()
  })) : [],
  channelsByEvent: {
    ticketCreated: Array.isArray(row?.channelsByEvent?.ticketCreated) ? row.channelsByEvent.ticketCreated.map(item => String(item || "").trim()).filter(Boolean) : ["mail"],
    ticketResolved: Array.isArray(row?.channelsByEvent?.ticketResolved) ? row.channelsByEvent.ticketResolved.map(item => String(item || "").trim()).filter(Boolean) : ["mail"],
    ticketCommented: Array.isArray(row?.channelsByEvent?.ticketCommented) ? row.channelsByEvent.ticketCommented.map(item => String(item || "").trim()).filter(Boolean) : ["mail"]
  },
  inAppSettings: normalizeInAppSettings(row?.inAppSettings)
});
const normalizeTicketAutomationScheduledAlertRule = (row, idx) => ({
  id: row?.id || `cron-alert-${Date.now()}-${idx}`,
  name: String(row?.name || "").trim() || `Ru${idx + 1}`,
  cron: String(row?.cron || "0 8 * * *").trim() || "0 8 * * *",
  triggerType: String(row?.triggerType || "contract_expiration").trim() || "contract_expiration",
  thresholdDays: Number.isFinite(Number(row?.thresholdDays)) ? Number(row.thresholdDays) : 30,
  frequencyType: String(row?.frequencyType || "monthly_last_friday").trim() || "monthly_last_friday",
  weekInterval: Number.isFinite(Number(row?.weekInterval)) ? Math.max(1, Number(row.weekInterval)) : 2,
  anchorDate: String(row?.anchorDate || "").trim(),
  runHour: Number.isFinite(Number(row?.runHour)) ? Math.min(23, Math.max(0, Number(row.runHour))) : 8,
  channels: Array.isArray(row?.channels) ? row.channels.map(channel => String(channel || "").trim()).filter(Boolean) : ["mail"],
  recipients: String(row?.recipients || "").trim(),
  emailCc: String(row?.emailCc || "").trim(),
  distributionMode: String(row?.distributionMode || "to_only").trim() || "to_only",
  webhookId: String(row?.webhookId || "").trim(),
  useTemplate: row?.useTemplate === true,
  templateId: String(row?.templateId || "").trim(),
  customMessage: String(row?.customMessage || ""),
  teamsThemeColor: String(row?.teamsThemeColor || "#13BA8E"),
  sendWhenEmpty: row?.sendWhenEmpty === true,
  lastRunAt: String(row?.lastRunAt || "").trim(),
  enabled: row?.enabled !== false
});
const normalizeTicketAutomationMailCollector = normalizeMailCollector;
const normalizeTicketAutomationConfig = payload => ({
  ...DEFAULT_TICKET_AUTOMATION_CONFIG,
  commentTemplates: Array.isArray(payload?.commentTemplates) ? payload.commentTemplates.map(normalizeTicketAutomationTemplate) : [],
  macros: Array.isArray(payload?.macros) ? payload.macros.map(normalizeTicketAutomationMacro) : [],
  emailInboxes: Array.isArray(payload?.emailInboxes) ? payload.emailInboxes.map(normalizeTicketAutomationInbox) : [],
  exclusionRules: Array.isArray(payload?.exclusionRules) ? payload.exclusionRules.map(normalizeTicketAutomationExclusion) : [],
  autoReplyRules: Array.isArray(payload?.autoReplyRules) ? payload.autoReplyRules.map(normalizeTicketAutomationAutoReplyRule) : Array.isArray(payload?.autoReplyRules?.legacyRules) ? payload.autoReplyRules.legacyRules.map(normalizeTicketAutomationAutoReplyRule) : [],
  autoReplyTemplate: String(payload?.autoReplyTemplate || ""),
  notificationSettings: normalizeNotificationSettings(payload?.notificationSettings || payload?.autoReplyRules?.notificationSettings),
  scheduledAlertRules: Array.isArray(payload?.scheduledAlertRules) ? payload.scheduledAlertRules.map(normalizeTicketAutomationScheduledAlertRule) : [],
  mailCollectors: Array.isArray(payload?.mailCollectors) ? payload.mailCollectors.map(normalizeTicketAutomationMailCollector) : [],
  mailCollectSettings: normalizeMailCollectSettings(payload?.mailCollectSettings)
});
async function enrichTicketRowsWithSla(rows, {
  hasSlaInfo = true
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (isCommunity()) return rows;
  const slaSettings = await loadSlaSettings();
  return rows.map(row => enrichTicketWithSla(row, {
    clientContrat: row.client_contrat ?? null,
    slaSettings
  }));
}
async function enrichSingleTicketWithSla(ticket, {
  persistIfResolved = false
} = {}) {
  if (!ticket) return ticket;
  if (isCommunity()) return ticket;
  const hasSlaInfo = await hasTicketColumn("sla_info");
  let clientContrat = ticket.client_contrat ?? null;
  if (!clientContrat && ticket.client_id) {
    clientContrat = await loadClientContrat(ticket.client_id);
  }
  const slaSettings = await loadSlaSettings();
  if (!hasSlaInfo) {
    return enrichTicketWithSla(ticket, {
      clientContrat,
      slaSettings
    });
  }
  let firstPublicCommentAt = ticket.first_public_comment_at ?? null;
  if (!firstPublicCommentAt && ticket.id) {
    const commentResult = await pool.query(`SELECT MIN(created_at) AS first_at
       FROM v_b_ticket_comments
       WHERE ticket_id = $1 AND COALESCE(is_internal, FALSE) = FALSE`, [ticket.id]);
    firstPublicCommentAt = commentResult.rows[0]?.first_at || null;
  }
  if (persistIfResolved && hasSlaInfo) {
    const resolved = resolveTicketSlaInfo(ticket, {
      clientContrat,
      slaSettings
    });
    await persistTicketSlaInfoIfMissing(ticket.id, resolved);
    if (resolved.enabled) {
      await pool.query(`UPDATE v_b_tickets SET sla_info = $1::jsonb WHERE id = $2`, [JSON.stringify(resolved), ticket.id]);
      ticket = {
        ...ticket,
        sla_info: resolved
      };
    }
  }
  return enrichTicketWithSla(ticket, {
    clientContrat,
    slaSettings
  });
}
async function getTicketById(ticketId) {
  await ensureTicketStatusMatchesValidation(ticketId).catch(err => {
    console.error(`[tickets] ensureTicketStatusMatchesValidation ${ticketId}:`, err.message);
  });
  const ticketResult = await pool.query(`SELECT
      t.*,
      c.name AS client_name,
      c.name AS client_nom,
      c.contrat AS client_contrat,
      req_u.email AS requester_email,
      ass_u.email AS assigned_email,
      cre_u.email AS created_by_email,
      ${FIRST_TAKEOVER_AT_SQL},
      (
        SELECT MIN(cm.created_at)
        FROM v_b_ticket_comments cm
        WHERE cm.ticket_id = t.id AND COALESCE(cm.is_internal, FALSE) = FALSE
      ) AS first_public_comment_at
     FROM v_b_tickets t
     LEFT JOIN v_b_clients c ON c.id = t.client_id
     LEFT JOIN v_b_users req_u ON req_u.id = t.requester_user_id
     LEFT JOIN v_b_users ass_u ON ass_u.id = t.assigned_user_id
     LEFT JOIN v_b_users cre_u ON cre_u.id = t.created_by
     WHERE t.id = $1`, [ticketId]);
  if (ticketResult.rows.length === 0) return null;
  const hasTicketAssignees = await hasTicketAssigneesTable();
  const hasCommentUpdatedAt = await hasCommentColumn("updated_at");
  const assigneesPromise = hasTicketAssignees ? pool.query(`SELECT ticket_id, user_id, created_at
         FROM v_b_ticket_assignees
         WHERE ticket_id = $1
         ORDER BY created_at ASC`, [ticketId]) : Promise.resolve({
    rows: []
  });
  const [commentsResult, historyResult, tagsResult, watchersResult, attachmentsResult, assigneesResult, activityHistory] = await Promise.all([pool.query(`SELECT id, ticket_id, author_user_id, content, is_internal, created_at, ${commentUpdatedAtSelectSql(hasCommentUpdatedAt)}
       FROM v_b_ticket_comments
       WHERE ticket_id = $1
       ORDER BY created_at ASC`, [ticketId]), pool.query(`SELECT id, ticket_id, old_status, new_status, changed_by, note, created_at
       FROM v_b_ticket_status_history
       WHERE ticket_id = $1
       ORDER BY created_at DESC`, [ticketId]), pool.query(`SELECT l.ticket_id, t.id, t.label, t.color
       FROM v_b_ticket_tag_links l
       JOIN v_b_ticket_tags t ON t.id = l.tag_id
       WHERE l.ticket_id = $1
       ORDER BY t.label ASC`, [ticketId]), pool.query(`SELECT ticket_id, user_id, created_at
       FROM v_b_ticket_watchers
       WHERE ticket_id = $1
       ORDER BY created_at ASC`, [ticketId]), pool.query(`SELECT id, ticket_id, comment_id, uploaded_by, file_name, file_path, mime_type, file_size, created_at
       FROM v_b_ticket_attachments
       WHERE ticket_id = $1
       ORDER BY created_at DESC`, [ticketId]), assigneesPromise, listTicketActivity(ticketId)]);
  const satisfaction = await getTicketSatisfaction(ticketId).catch(() => null);
  const resolutionValidation = await getTicketResolutionValidation(ticketId).catch(() => null);
  return enrichSingleTicketWithSla({
    ...ticketResult.rows[0],
    comments: await enrichCommentsWithAuthors(commentsResult.rows),
    statusHistory: historyResult.rows,
    activityHistory,
    tags: tagsResult.rows,
    watchers: watchersResult.rows,
    attachments: attachmentsResult.rows,
    assignees: assigneesResult.rows,
    supportCredit: await getTicketCreditStatus(ticketResult.rows[0]).catch(() => null),
    satisfaction,
    resolutionValidation
  }, {
    persistIfResolved: true
  });
}
async function enrichCommentsWithAuthors(comments = []) {
  if (!Array.isArray(comments) || comments.length === 0) return [];
  const authorIds = comments.map(row => row.author_user_id).filter(Boolean);
  const profiles = await loadAuthorProfilesByUserIds(authorIds);
  return comments.map(row => {
    const profile = profiles.get(String(row.author_user_id));
    if (!profile) return row;
    return {
      ...row,
      author_name: profile.display_name,
      author_avatar: profile.avatar,
      author_role: profile.role
    };
  });
}
async function enrichCommentWithAuthor(comment) {
  if (!comment) return comment;
  const [enriched] = await enrichCommentsWithAuthors([comment]);
  return enriched || comment;
}
async function findOrCreateTicketTag(label, color = null) {
  const normalizedLabel = String(label || "").trim().toLowerCase();
  if (!normalizedLabel) {
    throw new Error("Tag label is required");
  }
  const existing = await pool.query(`SELECT * FROM v_b_ticket_tags WHERE label = $1 LIMIT 1`, [normalizedLabel]);
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (color) {
      const updated = await pool.query(`UPDATE v_b_ticket_tags
         SET color = COALESCE($1, color)
         WHERE id = $2
         RETURNING *`, [color, row.id]);
      return updated.rows[0];
    }
    return row;
  }
  const inserted = await pool.query(`INSERT INTO v_b_ticket_tags (label, color, created_at)
     VALUES ($1, $2, NOW())
     RETURNING *`, [normalizedLabel, color]);
  return inserted.rows[0];
}
async function hasRequesterContactColumn() {
  if (requesterContactColumnExistsCache !== null) {
    return requesterContactColumnExistsCache;
  }
  const result = await pool.query(`SELECT EXISTS (
       SELECT 1
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.oid = to_regclass('v_b_tickets')
         AND a.attname = 'requester_contact_id'
         AND a.attnum > 0
         AND NOT a.attisdropped
     ) AS has_column`);
  requesterContactColumnExistsCache = Boolean(result.rows?.[0]?.has_column);
  return requesterContactColumnExistsCache;
}
async function hasTicketAssigneesTable() {
  if (ticketAssigneesTableExistsCache !== null) {
    return ticketAssigneesTableExistsCache;
  }
  const result = await pool.query(`SELECT to_regclass('v_b_ticket_assignees') IS NOT NULL AS has_table`);
  ticketAssigneesTableExistsCache = Boolean(result.rows?.[0]?.has_table);
  return ticketAssigneesTableExistsCache;
}
async function hasTicketColumn(columnName) {
  if (ticketColumnExistsCache.has(columnName)) {
    return ticketColumnExistsCache.get(columnName);
  }
  const result = await pool.query(`SELECT EXISTS (
       SELECT 1
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.oid = to_regclass('v_b_tickets')
         AND a.attname = $1
         AND a.attnum > 0
         AND NOT a.attisdropped
     ) AS has_column`, [columnName]);
  const exists = Boolean(result.rows?.[0]?.has_column);
  ticketColumnExistsCache.set(columnName, exists);
  return exists;
}
async function hasCommentColumn(columnName) {
  if (ticketCommentColumnExistsCache.get(columnName) === true) {
    return true;
  }
  const result = await pool.query(`SELECT EXISTS (
       SELECT 1
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.oid = to_regclass('v_b_ticket_comments')
         AND a.attname = $1
         AND a.attnum > 0
         AND NOT a.attisdropped
     ) AS has_column`, [columnName]);
  const exists = Boolean(result.rows?.[0]?.has_column);
  ticketCommentColumnExistsCache.set(columnName, exists);
  return exists;
}
function commentUpdatedAtSelectSql(hasCommentUpdatedAt) {
  return hasCommentUpdatedAt ? "updated_at" : "NULL::timestamptz AS updated_at";
}
function appendActiveTicketFilters(where, {
  hasDeletedAt,
  hasIsDeleted
}) {
  if (hasDeletedAt) {
    where.push("t.deleted_at IS NULL");
  } else if (hasIsDeleted) {
    where.push("COALESCE(t.is_deleted, FALSE) = FALSE");
  }
  return where;
}
async function softDeleteTicketById(ticketId) {
  const hasDeletedAt = await hasTicketColumn("deleted_at");
  const hasIsDeleted = await hasTicketColumn("is_deleted");
  if (!hasDeletedAt && !hasIsDeleted) {
    const error = new Error("Ticket trash is not enabled. Restart the server or run `npm run schema:incremental` to apply missing patches.");
    error.status = 503;
    throw error;
  }
  const assignments = [];
  if (hasDeletedAt) assignments.push("deleted_at = NOW()");
  if (hasIsDeleted) assignments.push("is_deleted = TRUE");
  assignments.push("updated_at = NOW()");
  await pool.query(`UPDATE v_b_tickets SET ${assignments.join(", ")} WHERE id = $1`, [ticketId]);
}
function normalizeContactSlots(rawSlots) {
  if (!Array.isArray(rawSlots)) return [];
  return rawSlots.map(slot => ({
    date: String(slot?.date || "").trim(),
    startTime: String(slot?.startTime || slot?.start_time || "").trim(),
    endTime: String(slot?.endTime || slot?.end_time || "").trim(),
    note: String(slot?.note || "").trim()
  })).filter(slot => slot.date || slot.startTime || slot.endTime || slot.note);
}
function normalizeEquipmentInfo(rawInfo) {
  const info = rawInfo && typeof rawInfo === "object" ? rawInfo : {};
  if (!info.concerned) return {
    concerned: false
  };
  const source = String(info.source || "").trim() === "external" ? "external" : "veritas";
  if (source === "external") {
    return {
      concerned: true,
      source: "external",
      brand: String(info.brand || "").trim(),
      model: String(info.model || "").trim(),
      serial: String(info.serial || "").trim()
    };
  }
  return {
    concerned: true,
    source: "veritas",
    equipmentId: String(info.equipmentId || info.equipment_id || "").trim(),
    name: String(info.name || "").trim(),
    type: String(info.type || "").trim(),
    clientId: String(info.clientId || info.client_id || "").trim()
  };
}
router.get("/automation-config", verifyJWT, async (_req, res) => {
  try {
    const row = await loadTicketAutomationRawConfig();
    const normalized = normalizeTicketAutomationConfig({
      commentTemplates: row.commentTemplates,
      macros: row.macros,
      emailInboxes: row.emailInboxes,
      exclusionRules: row.exclusionRules,
      autoReplyRules: row.autoReplyRules,
      autoReplyTemplate: row.autoReplyTemplate,
      scheduledAlertRules: row.scheduledAlertRules,
      mailCollectors: row.mailCollectors,
      mailCollectSettings: row.mailCollectSettings,
      notificationSettings: row.notificationSettings
    });
    return res.json(normalized);
  } catch (err) {
    console.error("GET /tickets/automation-config:", err);
    return res.status(500).json({
      error: "Error during loading tickand configuration."
    });
  }
});
router.put("/automation-config", verifyJWT, requirePermission("tickets.manage"), [body("commentTemplates").optional().isArray(), body("macros").optional().isArray(), body("emailInboxes").optional().isArray(), body("exclusionRules").optional().isArray(), body("autoReplyRules").optional().custom(value => Array.isArray(value) || value && typeof value === "object"), body("autoReplyTemplate").optional().isString(), body("notificationSettings").optional().isObject(), body("scheduledAlertRules").optional().isArray(), body("mailCollectors").optional().isArray(), body("mailCollectSettings").optional().isObject()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const normalized = normalizeTicketAutomationConfig(req.body || {});
    try {
      assertCommunityTicketAutomationLimits(normalized);
    } catch (limitErr) {
      if (limitErr?.code?.startsWith("COMMUNITY_")) {
        return sendCommunityLimitError(res, limitErr);
      }
      throw limitErr;
    }
    await saveTicketAutomationRawConfig({
      commentTemplates: normalized.commentTemplates,
      macros: normalized.macros,
      emailInboxes: normalized.emailInboxes,
      exclusionRules: normalized.exclusionRules,
      autoReplyRules: normalized.autoReplyRules,
      autoReplyTemplate: normalized.autoReplyTemplate,
      scheduledAlertRules: normalized.scheduledAlertRules,
      mailCollectors: normalized.mailCollectors,
      mailCollectSettings: normalized.mailCollectSettings,
      notificationSettings: normalizeNotificationSettings(normalized.notificationSettings)
    });
    return res.json(normalized);
  } catch (err) {
    console.error("PUT /tickets/automation-config:", err);
    return res.status(500).json({
      error: "Error saving ticket configuration"
    });
  }
});
router.post("/collectors/test-connection", verifyJWT, [body("collector").isObject()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const collector = normalizeTicketAutomationMailCollector(req.body?.collector || {}, 0);
    await withImapClient(collector, async () => true);
    return res.json({
      success: true,
      message: "IMAP connection successful."
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "IMAP connection failed."
    });
  }
});
router.post("/collectors/folders", verifyJWT, [body("collector").isObject()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const collector = normalizeTicketAutomationMailCollector(req.body?.collector || {}, 0);
    const folders = await withImapClient(collector, async client => {
      const list = await client.list();
      return (Array.isArray(list) ? list : []).map(item => String(item?.path || "").trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, "fr"));
    });
    return res.json({
      success: true,
      folders
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "Unable to retrieve IMAP folders."
    });
  }
});
router.post("/collectors/test-rules", verifyJWT, [body("sample").isObject(), body("rules").optional().isArray(), body("collectorId").optional().isString()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const sample = req.body?.sample || {};
    const sampleContext = {
      subject: String(sample.subject || ""),
      body: String(sample.body || ""),
      fromAddress: String(sample.fromAddress || ""),
      fromName: String(sample.fromName || ""),
      toAddresses: String(sample.toAddresses || ""),
      ccAddresses: String(sample.ccAddresses || ""),
      replyToAddress: String(sample.replyToAddress || ""),
      fromDomain: String(sample.fromDomain || ""),
      isReply: /^(re|fw|fwd)\s*:/i.test(String(sample.subject || "")) ? "yes" : "no"
    };
    const providedRules = Array.isArray(req.body?.rules) ? req.body.rules : null;
    let normalizedExclusions = [];
    if (providedRules) {
      normalizedExclusions = providedRules.map(normalizeTicketAutomationExclusion);
    } else {
      const exclusionRules = await loadExclusionRulesRaw();
      normalizedExclusions = Array.isArray(exclusionRules) ? exclusionRules.map(normalizeTicketAutomationExclusion) : [];
    }
    const collectorId = String(req.body?.collectorId ?? "").trim();
    if (collectorId) {
      normalizedExclusions = filterExclusionRulesForCollector(normalizedExclusions, collectorId);
    } else {
      normalizedExclusions = normalizedExclusions.filter(rule => !String(rule?.collectorId || "").trim());
    }
    const matches = getAllMatchingExclusionRules(normalizedExclusions, sampleContext);
    const firstMatch = matches[0] || null;
    return res.json({
      success: true,
      firstMatchId: firstMatch?.id || null,
      firstMatchName: firstMatch?.name || null,
      matches: matches.map(rule => ({
        id: rule.id,
        name: rule.name,
        action: rule.action,
        criteriaCount: Array.isArray(rule.criteria) ? rule.criteria.length : 0
      }))
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "Unable to test exclusion rules."
    });
  }
});
router.post("/notifications/webhooks/test", verifyJWT, [body("channel").isString(), body("url").isString()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const channel = String(req.body?.channel || "").trim().toLowerCase();
    const urlRaw = String(req.body?.url || "").trim();
    if (!urlRaw) {
      return res.status(400).json({
        success: false,
        error: "Webhook URL required."
      });
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(urlRaw);
    } catch (_error) {
      return res.status(400).json({
        success: false,
        error: "Invalid URL webhook."
      });
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        success: false,
        error: "Allowed protocols: http/https."
      });
    }
    const testMessage = "Veritas - Message de test webhook";
    let payload = {
      type: "veritas_webhook_test",
      channel,
      message: testMessage,
      timestamp: new Date().toISOString()
    };
    if (channel === "teams") {
      payload = {
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        summary: "Veritas - Test webhook",
        themeColor: "13BA8E",
        title: "Veritas - Test webhook",
        text: `${testMessage}\n\nDate: ${new Date().toLocaleString("fr-FR")}`
      };
    } else if (channel === "slack") {
      payload = {
        text: `${testMessage} (${new Date().toISOString()})`
      };
    } else if (channel === "webhook") {
      payload = {
        text: testMessage,
        type: "veritas_webhook_test",
        timestamp: new Date().toISOString()
      };
    }
    const response = await fetch(parsedUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      return res.status(400).json({
        success: false,
        error: `Webhook responded ${response.status}. Check the URL/channel.`
      });
    }
    let detectedChannelName = "";
    try {
      const responseText = await response.text();
      const match = responseText.match(/"channel"\s*:\s*"([^"]+)"/i) || responseText.match(/"channelName"\s*:\s*"([^"]+)"/i);
      if (match?.[1]) detectedChannelName = String(match[1]).trim();
    } catch (_error) {}
    return res.json({
      success: true,
      message: "Webhook tested successfully.",
      detectedChannelName
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "Unable to test webhook."
    });
  }
});
router.post("/notifications/webhooks/custom-send", verifyJWT, [body("webhookId").isString().notEmpty(), body("message").isString().notEmpty(), body("title").optional().isString(), body("teamsThemeColor").optional().isString()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const appendCustomAnnouncementLog = async ({
      status = "success",
      channel = "webhook",
      message = ""
    }) => {
      const notificationSettings = await loadNotificationSettingsRaw();
      const currentLogs = Array.isArray(notificationSettings?.logs) ? notificationSettings.logs : [];
      const logEntry = {
        id: `notif-log-custom-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        source: "tickets",
        element: "custom_announcement",
        channel: String(channel || "webhook"),
        status: String(status || "info"),
        message: String(message || ""),
        createdAt: new Date().toISOString(),
        enterpriseId: ""
      };
      await saveNotificationLogsRaw([logEntry, ...currentLogs].slice(0, 500));
    };
    const webhookId = String(req.body?.webhookId || "").trim();
    const title = String(req.body?.title || "").trim() || "Annonce Veritas";
    const message = String(req.body?.message || "").trim();
    const teamsThemeColor = String(req.body?.teamsThemeColor || "#13BA8E").trim() || "#13BA8E";
    const notificationSettings = await loadNotificationSettingsRaw();
    const webhooks = Array.isArray(notificationSettings?.webhooks) ? notificationSettings.webhooks : [];
    const webhook = webhooks.find(item => String(item?.id || "").trim() === webhookId);
    if (!webhook) {
      return res.status(404).json({
        success: false,
        error: "Webhook not found."
      });
    }
    if (webhook?.enabled === false) {
      return res.status(400).json({
        success: false,
        error: "This webhook is disabled."
      });
    }
    const urlRaw = String(webhook?.url || "").trim();
    if (!urlRaw) {
      return res.status(400).json({
        success: false,
        error: "URL webhook manquante."
      });
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(urlRaw);
    } catch (_error) {
      return res.status(400).json({
        success: false,
        error: "Invalid URL webhook."
      });
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        success: false,
        error: "Allowed protocols: http/https."
      });
    }
    const channel = String(webhook?.channel || "webhook").trim().toLowerCase();
    let payload = {
      type: "veritas_custom_announcement",
      title,
      message,
      timestamp: new Date().toISOString()
    };
    if (channel === "teams") {
      payload = {
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        summary: title,
        themeColor: teamsThemeColor.replace("#", ""),
        title,
        text: message
      };
    } else if (channel === "slack") {
      payload = {
        text: `*${title}*\n${message}`
      };
    }
    const response = await fetch(parsedUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      await appendCustomAnnouncementLog({
        status: "error",
        channel,
        message: `Custom announcement failed (${response.status}) vers "${webhook?.name || webhookId}".`
      }).catch(() => {});
      return res.status(400).json({
        success: false,
        error: `Webhook responded ${response.status}. Check the destination.`
      });
    }
    await appendCustomAnnouncementLog({
      status: "success",
      channel,
      message: `Custom announcement sent to "${webhook?.name || webhookId}".`
    }).catch(() => {});
    return res.json({
      success: true,
      message: "Announcement sent successfully."
    });
  } catch (err) {
    const failedChannel = String(req.body?.channel || "webhook");
    const failedWebhookId = String(req.body?.webhookId || "").trim();
    const failMessage = err?.message || "Unable to send custom announcement.";
    const notificationSettings = await loadNotificationSettingsRaw().catch(() => ({}));
    const currentLogs = Array.isArray(notificationSettings?.logs) ? notificationSettings.logs : [];
    await saveNotificationLogsRaw([{
      id: `notif-log-custom-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      source: "tickets",
      element: "custom_announcement",
      channel: failedChannel,
      status: "error",
      message: `Custom announcement error (${failedWebhookId || "unknown webhook"}): ${failMessage}`,
      createdAt: new Date().toISOString(),
      enterpriseId: ""
    }, ...currentLogs].slice(0, 500)).catch(() => {});
    return res.status(400).json({
      success: false,
      error: err?.message || "Unable to send custom announcement."
    });
  }
});
router.post("/notifications/logs/:logId/retry", verifyJWT, [param("logId").isString().notEmpty()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const logId = String(req.params?.logId || "").trim();
    const notificationSettings = await loadNotificationSettingsRaw();
    const logs = Array.isArray(notificationSettings?.logs) ? notificationSettings.logs : [];
    const logItem = logs.find(item => String(item?.id || "") === logId);
    if (!logItem) {
      return res.status(404).json({
        success: false,
        error: "Notification log not found."
      });
    }
    const result = await dispatchNotificationEvent({
      source: String(logItem.source || "").trim().toLowerCase(),
      element: String(logItem.element || "").trim().toLowerCase(),
      enterpriseId: String(logItem.enterpriseId || "").trim(),
      user: req.user,
      context: {
        manualRetry: true,
        originalLogId: logId,
        requestedBy: req.user?.id || null
      }
    });
    if (!result?.matched) {
      return res.status(400).json({
        success: false,
        error: "No active rumatches this log."
      });
    }
    if (!result?.sent) {
      return res.status(400).json({
        success: false,
        error: "Retry attempted, but no successful send. Check the webhook."
      });
    }
    return res.json({
      success: true,
      message: "Notification retried successfully.",
      details: result
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "Unable to retry notification."
    });
  }
});
router.post("/collectors/force-fetch", verifyJWT, [body("collector").isObject()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const collector = normalizeTicketAutomationMailCollector(req.body?.collector || {}, 0);
    const stats = await processMailCollector(collector, {
      force: true
    });
    if (stats.skipped && stats.reason === "disabled") {
      return res.status(400).json({
        success: false,
        error: "Collector is disabled or incomplete."
      });
    }
    await appendCollectorLogInConfig(collector.id, "success", `Manual force: ${stats.attached} mail(s) attached, ${stats.ignored} ignored, ${stats.inspected} inspected.`).catch(() => {});
    return res.json({
      success: true,
      stats
    });
  } catch (err) {
    await appendCollectorLogInConfig(req.body?.collector?.id, "error", `Manual force error: ${err?.message || "unknown"}`).catch(() => {});
    return res.status(400).json({
      success: false,
      error: err?.message || "Unable to force retrieval."
    });
  }
});
router.post("/search", verifyJWT, requirePermission("tickets.view"), [body("viewRules").optional({
  nullable: true
}).custom(value => value == null || typeof value === "object"), body("viewMode").optional().isIn(["active", "trash"]), body("status").optional().isString(), body("ticketType").optional().isString(), body("search").optional().isString(), body("sortBy").optional().isString(), body("sortDirection").optional().isIn(["asc", "desc"]), body("limit").optional().isInt({
  min: 1,
  max: TICKET_SEARCH_MAX_LIMIT
}), body("offset").optional().isInt({
  min: 0
})], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const schema = await resolveTicketListSchema(pool, {
      isCommunityEdition: isCommunity
    });
    const {
      viewRules = null,
      viewMode = "active",
      status = "",
      ticketType = "",
      search = "",
      sortBy = "updated_at",
      sortDirection = "desc",
      limit = 25,
      offset = 0
    } = req.body || {};
    const result = await searchTicketsPaged(pool, {
      viewRules,
      viewMode,
      status,
      ticketType,
      search,
      sortBy,
      sortDirection,
      limit,
      offset
    }, schema);
    return res.json({
      items: await enrichTicketRowsWithSla(result.items, {
        hasSlaInfo: schema.hasSlaInfo
      }),
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });
  } catch (err) {
    console.error("Error searching paginated tickets:", err);
    return res.status(500).json({
      error: "Error searching tickets"
    });
  }
});
router.get("/satisfactions/counts", verifyJWT, async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const communityFilter = isCommunity();
    const mine = await countTicketSatisfactions({
      userId,
      scope: "mine",
      communityFilter
    });
    const payload = {
      mine
    };
    if (isAdminUser(req)) {
      payload.all = await countTicketSatisfactions({
        userId,
        scope: "all",
        communityFilter
      });
    }
    res.json(payload);
  } catch (err) {
    console.error("Failed to count satisfactions:", err);
    res.status(500).json({
      error: "Error during comptage client feedback."
    });
  }
});
router.get("/satisfactions", verifyJWT, [query("scope").optional().isIn(["mine", "all"]), query("sentiment").optional().isIn(["positive", "negative", "neutral", ""]), query("search").optional().isString(), query("sortBy").optional().isIn(["created_at", "rating", "ticket_number", "updated_at"]), query("sortDirection").optional().isIn(["asc", "desc"]), query("limit").optional().isInt({
  min: 1,
  max: 200
}), query("offset").optional().isInt({
  min: 0
})], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  const scope = req.query.scope === "all" ? "all" : "mine";
  if (scope === "all" && !isAdminUser(req)) {
    return res.status(403).json({
      error: "Access restricted to administrators."
    });
  }
  try {
    const result = await listTicketSatisfactions({
      userId: req.user?.id || null,
      scope,
      search: req.query.search || "",
      sentiment: req.query.sentiment || "",
      sortBy: req.query.sortBy || "created_at",
      sortDirection: req.query.sortDirection || "desc",
      limit: req.query.limit,
      offset: req.query.offset,
      communityFilter: isCommunity()
    });
    res.json(result);
  } catch (err) {
    console.error("Error liste satisfactions:", err);
    res.status(500).json({
      error: "Error retrieving client feedback"
    });
  }
});
router.get("/", verifyJWT, requirePermission("tickets.view"), [query("status").optional().isIn(STATUS_VALUES), query("priority").optional().isIn(PRIORITY_VALUES), query("clientId").optional().isInt(), query("assignedUserId").optional().isUUID(), query("requesterUserId").optional().isUUID(), query("requesterContactId").optional().isInt(), query("forLinking").optional().isIn(["true", "false", "1", "0"]), query("includeClosed").optional().isIn(["true", "false", "1", "0"]), query("category").optional().isString(), query("search").optional().isString(), query("limit").optional().isInt({
  min: 1,
  max: 200
}), query("offset").optional().isInt({
  min: 0
})], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const hasRequesterContact = await hasRequesterContactColumn();
    const hasTicketAssignees = await hasTicketAssigneesTable();
    const hasSlaInfo = await hasTicketColumn("sla_info");
    const hasMajorIncident = await hasTicketColumn("is_major_incident");
    const hasDeletedAt = await hasTicketColumn("deleted_at");
    const hasIsDeleted = await hasTicketColumn("is_deleted");
    const {
      status,
      priority,
      clientId,
      assignedUserId,
      requesterUserId,
      requesterContactId,
      forLinking: forLinkingRaw,
      includeClosed: includeClosedRaw,
      category,
      search,
      limit = 50,
      offset = 0
    } = req.query;
    const forLinking = ["true", "1"].includes(String(forLinkingRaw || "").toLowerCase());
    const includeClosed = !["false", "0"].includes(String(includeClosedRaw ?? "true").toLowerCase());
    const where = [];
    const values = [];
    let i = 1;
    if (status) {
      where.push(`t.status = $${i++}`);
      values.push(normalizeIncomingStatus(status));
    }
    if (priority) {
      where.push(`t.priority = $${i++}`);
      values.push(priority);
    }
    if (forLinking && requesterContactId && hasRequesterContact) {
      where.push(`(t.requester_contact_id = $${i} OR t.client_id IN (SELECT c2.client_id FROM v_b_contacts c2 WHERE c2.id = $${i} AND c2.client_id IS NOT NULL))`);
      values.push(Number(requesterContactId));
      i += 1;
    } else {
      if (clientId) {
        where.push(`t.client_id = $${i++}`);
        values.push(Number(clientId));
      }
      if (requesterContactId && hasRequesterContact) {
        where.push(`t.requester_contact_id = $${i++}`);
        values.push(Number(requesterContactId));
      }
    }
    if (assignedUserId) {
      where.push(`t.assigned_user_id = $${i++}`);
      values.push(assignedUserId);
    }
    if (requesterUserId) {
      where.push(`t.requester_user_id = $${i++}`);
      values.push(requesterUserId);
    }
    if (category && String(category).trim()) {
      where.push(`t.category = $${i++}`);
      values.push(String(category).trim());
    }
    if (search && String(search).trim()) {
      where.push(`(LOWER(t.title) LIKE $${i} OR LOWER(COALESCE(t.description, '')) LIKE $${i})`);
      values.push(`%${String(search).toLowerCase().trim()}%`);
      i += 1;
    }
    if (!status && !includeClosed) {
      where.push(`t.status NOT IN ('resolved', 'closed')`);
    }
    appendActiveTicketFilters(where, {
      hasDeletedAt,
      hasIsDeleted
    });
    appendCommunityTicketFilters(where);
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limitValue = Number(limit) || 50;
    const offsetValue = Number(offset) || 0;
    const result = await pool.query(`SELECT
          t.id,
          t.ticket_number,
          t.title,
          t.description,
          t.status,
          t.priority,
          t.type,
          t.category,
          t.channel,
          t.client_id,
          ${hasRequesterContact ? "t.requester_contact_id," : ""}
          t.requester_user_id,
          t.assigned_user_id,
          t.created_at,
          t.updated_at,
          t.resolved_at,
          ${hasSlaInfo ? "t.sla_info," : ""}
          c.contrat AS client_contrat,
          ${FIRST_TAKEOVER_AT_SQL},
          ${hasSlaInfo ? `(SELECT MIN(cm.created_at) FROM v_b_ticket_comments cm WHERE cm.ticket_id = t.id AND COALESCE(cm.is_internal, FALSE) = FALSE) AS first_public_comment_at,` : ""}
          ${hasMajorIncident ? "t.is_major_incident," : ""}
          c.name AS client_name,
          c.name AS client_nom,
          req_u.email AS requester_email,
          ass_u.email AS assigned_email,
          COALESCE(
            (
              SELECT json_agg(
                json_build_object(
                  'user_id', w.user_id,
                  'created_at', w.created_at
                )
                ORDER BY w.created_at ASC
              )
              FROM v_b_ticket_watchers w
              WHERE w.ticket_id = t.id
            ),
            '[]'::json
          ) AS watchers,
          ${hasTicketAssignees ? `COALESCE(
            (
              SELECT json_agg(
                json_build_object(
                  'user_id', a.user_id,
                  'created_at', a.created_at
                )
                ORDER BY a.created_at ASC
              )
              FROM v_b_ticket_assignees a
              WHERE a.ticket_id = t.id
            ),
            '[]'::json
          ) AS assignees,` : "'[]'::json AS assignees,"}
          COALESCE((SELECT COUNT(*) FROM v_b_ticket_watchers w2 WHERE w2.ticket_id = t.id), 0) AS followers_count,
          ${hasTicketAssignees ? "COALESCE((SELECT COUNT(*) FROM v_b_ticket_assignees a2 WHERE a2.ticket_id = t.id), 0) AS assignees_count," : "0 AS assignees_count,"}
          (SELECT COUNT(*) FROM v_b_ticket_comments cm WHERE cm.ticket_id = t.id) AS comments_count
         FROM v_b_tickets t
         LEFT JOIN v_b_clients c ON c.id = t.client_id
         LEFT JOIN v_b_users req_u ON req_u.id = t.requester_user_id
         LEFT JOIN v_b_users ass_u ON ass_u.id = t.assigned_user_id
         ${whereSql}
         ORDER BY t.updated_at DESC
         LIMIT $${i++} OFFSET $${i}`, [...values, limitValue, offsetValue]);
    const rows = await enrichTicketRowsWithSla(result.rows, {
      hasSlaInfo
    });
    res.json(await enrichTicketRowsWithSatisfaction(rows));
  } catch (err) {
    console.error("Error fetching des tickets:", err);
    res.status(500).json({
      error: "Error retrieving tickets"
    });
  }
});
router.post("/", verifyJWT, requirePermission("tickets.create"), [body("title").notEmpty().withMessage("Title is required"), body("description").optional().isString(), body("status").optional().isIn(STATUS_VALUES), body("priority").optional().isIn(PRIORITY_VALUES), body("type").optional().isString(), body("category").optional({
  nullable: true
}).isString(), body("channel").optional().isString(), body("clientId").optional({
  nullable: true,
  checkFalsy: true
}).isInt(), body("requesterContactId").optional({
  nullable: true,
  checkFalsy: true
}).isInt(), body("requesterUserId").optional({
  nullable: true,
  checkFalsy: true
}).isUUID(), body("assignedUserId").optional({
  nullable: true,
  checkFalsy: true
}).isUUID(), body("isMajorIncident").optional().isBoolean(), body("contactSlots").optional().isArray(), body("equipmentInfo").optional().isObject(), body("salesFormData").optional().isObject()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  if (rejectCommunitySalesTicketCreate(req, res)) return;
  try {
    const hasRequesterContact = await hasRequesterContactColumn();
    const hasMajorIncident = await hasTicketColumn("is_major_incident");
    const hasContactSlots = await hasTicketColumn("contact_slots");
    const hasEquipmentInfo = await hasTicketColumn("equipment_info");
    const hasSlaInfo = await hasTicketColumn("sla_info");
    const hasSalesFormData = await hasTicketColumn("sales_form_data");
    const {
      title,
      description = null,
      status = "open",
      priority = "normal",
      type = "incident",
      category = "",
      channel = "web",
      clientId = null,
      requesterContactId = null,
      requesterUserId = null,
      assignedUserId = null,
      isMajorIncident = false,
      contactSlots = [],
      equipmentInfo = {
        concerned: false
      },
      salesFormData = null
    } = req.body;
    const formId = salesFormData && typeof salesFormData === "object" && salesFormData.formId ? String(salesFormData.formId) : null;
    const formFieldValues = salesFormData && typeof salesFormData === "object" && salesFormData.values && typeof salesFormData.values === "object" ? salesFormData.values : {};
    const formTargetsConfig = formId ? await loadFormTicketTargetsConfig(formId) : {
      version: 2,
      rules: []
    };
    const matchingRules = formId ? resolveMatchingRules(formTargetsConfig, formFieldValues) : [];
    const ticketRules = matchingRules.length > 0 ? matchingRules : formId ? [{
      id: "fallback",
      label: "Ticket principal",
      enabled: true,
      always: true,
      conditions: [],
      targets: normalizeTicketTargets({})
    }] : [{
      id: "default",
      label: "Ticket principal",
      enabled: true,
      always: true,
      conditions: [],
      targets: normalizeTicketTargets({})
    }];
    const createdBy = req.user?.id || null;
    const resolvedClientId = await resolveClientIdForTicket({
      clientId,
      requesterContactId
    });
    const normalizedContactSlots = normalizeContactSlots(contactSlots);
    const normalizedEquipmentInfo = normalizeEquipmentInfo(equipmentInfo);
    const majorIncidentValue = type === "incident" && Boolean(isMajorIncident);
    const clientContrat = resolvedClientId ? await loadClientContrat(resolvedClientId) : null;
    const insertTicket = async (dbClient, rule = null) => {
      const executor = dbClient || pool;
      const ruleTargets = rule?.targets || normalizeTicketTargets({});
      const mergedCreate = mergeCreateOptionsFromTargets(ruleTargets, {
        priority,
        status
      });
      const normalizedStatus = normalizeIncomingStatus(mergedCreate.status);
      const resolvedPriority = majorIncidentValue ? "urgent" : mergedCreate.priority;
      const slaInfo = hasSlaInfo && !isCommunity() ? await buildSlaInfoForTicket({
        clientContrat,
        priority: resolvedPriority,
        createdAt: new Date()
      }) : {
        enabled: false
      };
      let resolvedAssignedUserId = assignedUserId || null;
      if (!resolvedAssignedUserId && formId) {
        const targetAssigneeIds = await resolveAssigneeUserIds(ruleTargets);
        if (targetAssigneeIds.length > 0) resolvedAssignedUserId = targetAssigneeIds[0];
      }
      const ticketTitle = rule ? buildTicketTitle(String(title).trim(), rule) : String(title).trim();
      const ticketCategory = ruleTargets.categorySlug || String(category || "").trim();
      const ticketSalesFormData = salesFormData && typeof salesFormData === "object" ? {
        ...salesFormData,
        targetRuleId: rule?.id || null,
        targetRuleLabel: rule?.label || null
      } : null;
      const columns = ["title", "description", "status", "priority", "type", "category", "channel", "client_id"];
      const values = [ticketTitle, description, normalizedStatus, resolvedPriority, type, ticketCategory, channel, resolvedClientId];
      if (hasRequesterContact) {
        columns.push("requester_contact_id");
        values.push(requesterContactId || null);
      }
      columns.push("requester_user_id", "assigned_user_id", "created_by");
      values.push(requesterUserId || null, resolvedAssignedUserId || null, createdBy);
      if (hasMajorIncident) {
        columns.push("is_major_incident");
        values.push(majorIncidentValue);
      }
      if (hasContactSlots) {
        columns.push("contact_slots");
        values.push(JSON.stringify(normalizedContactSlots));
      }
      if (hasEquipmentInfo) {
        columns.push("equipment_info");
        values.push(JSON.stringify(normalizedEquipmentInfo));
      }
      if (hasSlaInfo) {
        columns.push("sla_info");
        values.push(JSON.stringify(slaInfo));
      }
      if (hasSalesFormData && ticketSalesFormData) {
        columns.push("sales_form_data");
        values.push(JSON.stringify(ticketSalesFormData));
      }
      columns.push("created_at", "updated_at");
      const placeholders = values.map((_, idx) => `$${idx + 1}`);
      placeholders.push("NOW()", "NOW()");
      const result = await executor.query(`INSERT INTO v_b_tickets (${columns.join(", ")})
           VALUES (${placeholders.join(", ")})
           RETURNING *`, values);
      const createdTicket = result.rows[0];
      const historyNote = ticketRules.length > 1 && rule?.label ? String(rule.label).trim() || null : null;
      await executor.query(`INSERT INTO v_b_ticket_status_history (ticket_id, old_status, new_status, changed_by, note, created_at)
           VALUES ($1, NULL, $2, $3, $4, NOW())`, [createdTicket.id, normalizedStatus, createdBy, historyNote]);
      if (formId) {
        await applyFormTicketTargets(createdTicket.id, ruleTargets);
        const refreshed = await executor.query(`SELECT * FROM v_b_tickets WHERE id = $1`, [createdTicket.id]);
        return refreshed.rows[0] || createdTicket;
      }
      return createdTicket;
    };
    const createdTickets = [];
    for (const rule of ticketRules) {
      const created = await insertTicket(null, rule);
      createdTickets.push(created);
      await dispatchNotificationEvent({
        source: "tickets",
        element: "created",
        enterpriseId: String(created?.client_id || ""),
        user: req.user,
        context: {
          ticket: created,
          entreprise: {
            id: String(created?.client_id || "")
          }
        }
      }).catch(() => {});
      await notifyInAppTicketCreated({
        ticketId: created.id,
        assignedUserId: created.assigned_user_id,
        createdByUserId: req.user?.id || null
      }).catch(() => {});
    }
    const primaryTicket = createdTickets[0];
    if (createdTickets.length === 1) {
      return res.status(201).json(enrichTicketWithSla(primaryTicket));
    }
    const enrichedTickets = createdTickets.map(ticket => enrichTicketWithSla(ticket));
    return res.status(201).json({
      multiple: true,
      count: enrichedTickets.length,
      tickets: enrichedTickets,
      ...enrichedTickets[0]
    });
  } catch (err) {
    console.error("Error creating du ticket:", err);
    res.status(500).json({
      error: "Error creating ticket"
    });
  }
});
async function applyBulkTicketFieldUpdates(ticketId, updates, req, helpers) {
  const {
    hasRequesterContact
  } = helpers;
  const existing = await pool.query("SELECT * FROM v_b_tickets WHERE id = $1", [ticketId]);
  if (!existing.rows.length) {
    return {
      ticketId,
      success: false,
      error: "Ticket not found"
    };
  }
  const oldTicket = existing.rows[0];
  const map = [["status", "status", v => normalizeIncomingStatus(v)], ["priority", "priority", v => v], ["type", "type", v => v], ["requesterUserId", "requester_user_id", v => v || null], ["assignedUserId", "assigned_user_id", v => v || null]];
  if (hasRequesterContact) {
    map.splice(3, 0, ["requesterContactId", "requester_contact_id", v => v || null]);
  }
  const updatesList = [];
  const values = [];
  let p = 1;
  for (const [bodyKey, dbKey, transform] of map) {
    if (Object.prototype.hasOwnProperty.call(updates, bodyKey)) {
      updatesList.push(`${dbKey} = $${p++}`);
      values.push(transform(updates[bodyKey]));
    }
  }
  if (updatesList.length === 0) {
    return {
      ticketId,
      success: true,
      skipped: true
    };
  }
  const newStatus = Object.prototype.hasOwnProperty.call(updates, "status") ? normalizeIncomingStatus(updates.status) : oldTicket.status;
  if (newStatus === "resolved") updatesList.push("resolved_at = COALESCE(resolved_at, NOW())");
  if (newStatus === "closed") updatesList.push("closed_at = COALESCE(closed_at, NOW())");
  updatesList.push("updated_at = NOW()");
  values.push(ticketId);
  const result = await pool.query(`UPDATE v_b_tickets SET ${updatesList.join(", ")} WHERE id = $${p} RETURNING *`, values);
  if (oldTicket.status !== result.rows[0].status) {
    await pool.query(`INSERT INTO v_b_ticket_status_history (ticket_id, old_status, new_status, changed_by, note, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`, [ticketId, oldTicket.status, result.rows[0].status, req.user?.id || null, null]);
    if (await hasTicketColumn("sla_info")) {
      await maybeRecordTakeoverSla(ticketId, oldTicket.status, result.rows[0].status);
    }
  }
  await logTicketFieldChanges({
    ticketId,
    oldTicket,
    newTicket: result.rows[0],
    actorUserId: req.user?.id || null
  }).catch(() => {});
  await dispatchNotificationEvent({
    source: "tickets",
    element: result.rows[0]?.status === "resolved" ? "resolved" : "updated",
    enterpriseId: String(result.rows[0]?.client_id || ""),
    user: req.user,
    context: {
      ticket: result.rows[0],
      oldTicket,
      entreprise: {
        id: String(result.rows[0]?.client_id || "")
      }
    }
  }).catch(() => {});
  await notifyInAppTicketStatusChanged({
    ticketId,
    newStatus: result.rows[0]?.status,
    changedByUserId: req.user?.id || null
  }).catch(() => {});
  return {
    ticketId,
    success: true
  };
}
async function applyBulkAssignees(ticketId, assigneesPayload, helpers, assignedByUserId = null) {
  const {
    hasAssignees
  } = helpers;
  if (!assigneesPayload || !hasAssignees) return {
    ticketId,
    success: true,
    skipped: true
  };
  const mode = String(assigneesPayload.mode || "replace").toLowerCase();
  const userIds = Array.isArray(assigneesPayload.userIds) ? assigneesPayload.userIds.map(id => String(id)).filter(Boolean) : [];
  const usersToNotify = mode === "remove" ? [] : userIds;
  if (mode === "remove") {
    if (userIds.length === 0) return {
      ticketId,
      success: true,
      skipped: true
    };
    await pool.query(`DELETE FROM v_b_ticket_assignees
       WHERE ticket_id = $1 AND user_id = ANY($2::uuid[])`, [ticketId, userIds]);
    for (const userId of userIds) {
      await logTicketActivity({
        ticketId,
        action: "assignee_removed",
        field: "assignee",
        oldValue: userId,
        actorUserId: assignedByUserId
      }).catch(() => {});
    }
  } else if (mode === "replace") {
    await pool.query("DELETE FROM v_b_ticket_assignees WHERE ticket_id = $1", [ticketId]);
    for (const userId of userIds) {
      await pool.query(`INSERT INTO v_b_ticket_assignees (ticket_id, user_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (ticket_id, user_id) DO NOTHING`, [ticketId, userId]);
      await logTicketActivity({
        ticketId,
        action: "assignee_added",
        field: "assignee",
        newValue: userId,
        actorUserId: assignedByUserId
      }).catch(() => {});
    }
  } else {
    for (const userId of userIds) {
      const inserted = await pool.query(`INSERT INTO v_b_ticket_assignees (ticket_id, user_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (ticket_id, user_id) DO NOTHING
         RETURNING user_id`, [ticketId, userId]);
      if (inserted.rows.length > 0) {
        await logTicketActivity({
          ticketId,
          action: "assignee_added",
          field: "assignee",
          newValue: userId,
          actorUserId: assignedByUserId
        }).catch(() => {});
      }
    }
  }
  const nextAssigneeResult = await pool.query(`SELECT user_id
     FROM v_b_ticket_assignees
     WHERE ticket_id = $1
     ORDER BY created_at ASC
     LIMIT 1`, [ticketId]);
  const nextAssignedUserId = nextAssigneeResult.rows.length > 0 ? nextAssigneeResult.rows[0].user_id : null;
  await pool.query(`UPDATE v_b_tickets SET assigned_user_id = $1, updated_at = NOW() WHERE id = $2`, [nextAssignedUserId, ticketId]);
  for (const userId of usersToNotify) {
    await notifyInAppTicketAssigned({
      ticketId,
      assignedUserId: userId,
      assignedByUserId
    }).catch(() => {});
  }
  return {
    ticketId,
    success: true
  };
}
async function applyBulkWatchers(ticketId, watchersPayload, actorUserId = null) {
  if (!watchersPayload) return {
    ticketId,
    success: true,
    skipped: true
  };
  const mode = String(watchersPayload.mode || "add").toLowerCase();
  const userIds = Array.isArray(watchersPayload.userIds) ? watchersPayload.userIds.map(id => String(id)).filter(Boolean) : [];
  if (mode === "remove") {
    if (userIds.length === 0) return {
      ticketId,
      success: true,
      skipped: true
    };
    await pool.query(`DELETE FROM v_b_ticket_watchers
       WHERE ticket_id = $1 AND user_id = ANY($2::uuid[])`, [ticketId, userIds]);
    for (const userId of userIds) {
      await logTicketActivity({
        ticketId,
        action: "watcher_removed",
        field: "watcher",
        oldValue: userId,
        actorUserId
      }).catch(() => {});
    }
  } else if (mode === "replace") {
    await pool.query("DELETE FROM v_b_ticket_watchers WHERE ticket_id = $1", [ticketId]);
    for (const userId of userIds) {
      await pool.query(`INSERT INTO v_b_ticket_watchers (ticket_id, user_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (ticket_id, user_id) DO NOTHING`, [ticketId, userId]);
      await logTicketActivity({
        ticketId,
        action: "watcher_added",
        field: "watcher",
        newValue: userId,
        actorUserId
      }).catch(() => {});
    }
  } else {
    for (const userId of userIds) {
      const inserted = await pool.query(`INSERT INTO v_b_ticket_watchers (ticket_id, user_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (ticket_id, user_id) DO NOTHING
         RETURNING user_id`, [ticketId, userId]);
      if (inserted.rows.length > 0) {
        await logTicketActivity({
          ticketId,
          action: "watcher_added",
          field: "watcher",
          newValue: userId,
          actorUserId
        }).catch(() => {});
      }
    }
  }
  await pool.query("UPDATE v_b_tickets SET updated_at = NOW() WHERE id = $1", [ticketId]);
  return {
    ticketId,
    success: true
  };
}
async function applyBulkTicketDelete(ticketId, actorUserId = null) {
  try {
    await softDeleteTicketById(ticketId);
    await logTicketActivity({
      ticketId,
      action: "deleted",
      actorUserId
    }).catch(() => {});
    return {
      ticketId,
      success: true
    };
  } catch (err) {
    return {
      ticketId,
      success: false,
      error: err?.message || "Error moving to trash"
    };
  }
}
async function applyBulkTicketRestore(ticketId, actorUserId = null) {
  const hasDeletedAt = await hasTicketColumn("deleted_at");
  const hasIsDeleted = await hasTicketColumn("is_deleted");
  if (!hasDeletedAt && !hasIsDeleted) {
    return {
      ticketId,
      success: false,
      error: "Tickand trash is not enabled"
    };
  }
  const assignments = [];
  if (hasDeletedAt) assignments.push("deleted_at = NULL");
  if (hasIsDeleted) assignments.push("is_deleted = FALSE");
  assignments.push("updated_at = NOW()");
  const result = await pool.query(`UPDATE v_b_tickets SET ${assignments.join(", ")} WHERE id = $1 RETURNING id`, [ticketId]);
  if (!result.rows.length) {
    return {
      ticketId,
      success: false,
      error: "Ticket not found"
    };
  }
  await logTicketActivity({
    ticketId,
    action: "restored",
    actorUserId
  }).catch(() => {});
  return {
    ticketId,
    success: true
  };
}
async function applyBulkTicketPurge(ticketId) {
  const result = await pool.query("DELETE FROM v_b_tickets WHERE id = $1 RETURNING id", [ticketId]);
  if (!result.rows.length) {
    return {
      ticketId,
      success: false,
      error: "Ticket not found"
    };
  }
  return {
    ticketId,
    success: true
  };
}
router.post("/bulk", verifyJWT, requireAnyPermission("tickets.edit", "tickets.delete", "tickets.manage"), [body("ticketIds").isArray({
  min: 1,
  max: 100
}), body("ticketIds.*").isUUID(), body("action").isIn(["update", "delete", "restore", "purge"]), body("updates").optional().isObject(), body("updates.status").optional().isIn(STATUS_VALUES), body("updates.priority").optional().isIn(PRIORITY_VALUES), body("updates.type").optional().isString(), body("updates.requesterContactId").optional({
  nullable: true
}), body("updates.requesterUserId").optional({
  nullable: true
}), body("assignees").optional().isObject(), body("assignees.mode").optional().isIn(["add", "replace", "remove"]), body("assignees.userIds").optional().isArray(), body("assignees.userIds.*").optional().isUUID(), body("watchers").optional().isObject(), body("watchers.mode").optional().isIn(["add", "replace", "remove"]), body("watchers.userIds").optional().isArray(), body("watchers.userIds.*").optional().isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const {
      ticketIds,
      action,
      updates = {},
      assignees,
      watchers
    } = req.body;
    if (action === "delete" && !isAdminUser(req)) {
      return res.status(403).json({
        error: "Only administrators can bulk-delete tickets"
      });
    }
    if (action === "purge" && !isAdminUser(req)) {
      return res.status(403).json({
        error: "Only administrators can permanently delete tickets"
      });
    }
    if (action === "update") {
      const hasAnyUpdate = Object.keys(updates).length > 0 || assignees && Array.isArray(assignees.userIds) && assignees.userIds.length > 0 || watchers && Array.isArray(watchers.userIds) && watchers.userIds.length > 0 || assignees?.mode === "replace" || watchers?.mode === "replace";
      if (!hasAnyUpdate) {
        return res.status(400).json({
          error: "No changes to apply"
        });
      }
    }
    const hasRequesterContact = await hasRequesterContactColumn();
    const hasAssignees = await hasTicketAssigneesTable();
    const helpers = {
      hasRequesterContact,
      hasAssignees
    };
    const results = [];
    for (const ticketId of ticketIds) {
      try {
        if (action === "delete") {
          results.push(await applyBulkTicketDelete(ticketId, req.user?.id || null));
          continue;
        }
        if (action === "restore") {
          results.push(await applyBulkTicketRestore(ticketId, req.user?.id || null));
          continue;
        }
        if (action === "purge") {
          results.push(await applyBulkTicketPurge(ticketId));
          continue;
        }
        if (Object.keys(updates).length > 0) {
          const fieldResult = await applyBulkTicketFieldUpdates(ticketId, updates, req, helpers);
          if (!fieldResult.success) {
            results.push(fieldResult);
            continue;
          }
        }
        if (assignees) {
          const assigneeResult = await applyBulkAssignees(ticketId, assignees, helpers, req.user?.id || null);
          if (!assigneeResult.success) {
            results.push(assigneeResult);
            continue;
          }
        }
        if (watchers) {
          const watcherResult = await applyBulkWatchers(ticketId, watchers, req.user?.id || null);
          if (!watcherResult.success) {
            results.push(watcherResult);
            continue;
          }
        }
        results.push({
          ticketId,
          success: true
        });
      } catch (ticketErr) {
        results.push({
          ticketId,
          success: false,
          error: ticketErr?.message || "Error during processing ticket"
        });
      }
    }
    const successCount = results.filter(row => row.success).length;
    const failureCount = results.length - successCount;
    return res.json({
      success: failureCount === 0,
      successCount,
      failureCount,
      results
    });
  } catch (err) {
    console.error("Error bulk tickand action:", err);
    return res.status(500).json({
      error: "Error during bulk ticket action"
    });
  }
});
router.get("/categories", verifyJWT, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT id, section, name, description, enabled, created_at, updated_at
       FROM v_b_ticket_categories
       ORDER BY section ASC, name ASC`);
    return res.json(result.rows || []);
  } catch (err) {
    console.error("Error loading ITIL categories:", err);
    return res.status(500).json({
      error: "Error during loading ITIL categories"
    });
  }
});
router.post("/categories", verifyJWT, [body("name").isString().notEmpty(), body("section").optional().isString(), body("description").optional().isString(), body("enabled").optional().isBoolean()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const name = String(req.body?.name || "").trim();
    const section = String(req.body?.section || "Uncategorized").trim() || "Uncategorized";
    const description = String(req.body?.description || "").trim();
    const enabled = req.body?.enabled !== false;
    const id = `itil-cat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const result = await pool.query(`INSERT INTO v_b_ticket_categories (id, section, name, description, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         RETURNING id, section, name, description, enabled, created_at, updated_at`, [id, section, name, description, enabled]);
    return res.status(201).json(result.rows?.[0] || null);
  } catch (err) {
    console.error("Failed to create ITIL category:", err);
    return res.status(500).json({
      error: "Error creating ITIL category"
    });
  }
});
router.put("/categories/:categoryId", verifyJWT, [param("categoryId").isString().notEmpty(), body("name").optional().isString(), body("section").optional().isString(), body("description").optional().isString(), body("enabled").optional().isBoolean()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const categoryId = String(req.params?.categoryId || "").trim();
    const updates = [];
    const values = [];
    let idx = 1;
    if (Object.prototype.hasOwnProperty.call(req.body, "name")) {
      updates.push(`name = $${idx++}`);
      values.push(String(req.body?.name || "").trim());
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "section")) {
      updates.push(`section = $${idx++}`);
      values.push(String(req.body?.section || "Uncategorized").trim() || "Uncategorized");
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "description")) {
      updates.push(`description = $${idx++}`);
      values.push(String(req.body?.description || "").trim());
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "enabled")) {
      updates.push(`enabled = $${idx++}`);
      values.push(req.body?.enabled !== false);
    }
    if (updates.length === 0) {
      return res.status(400).json({
        error: "No fields to update"
      });
    }
    updates.push("updated_at = NOW()");
    values.push(categoryId);
    const result = await pool.query(`UPDATE v_b_ticket_categories
         SET ${updates.join(", ")}
         WHERE id = $${idx}
         RETURNING id, section, name, description, enabled, created_at, updated_at`, values);
    if (!result.rows.length) {
      return res.status(404).json({
        error: "ITIL category not found"
      });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("Failed to update ITIL category:", err);
    return res.status(500).json({
      error: "Error updating ITIL category"
    });
  }
});
router.delete("/categories/:categoryId", verifyJWT, [param("categoryId").isString().notEmpty()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const categoryId = String(req.params?.categoryId || "").trim();
    const result = await pool.query(`DELETE FROM v_b_ticket_categories WHERE id = $1`, [categoryId]);
    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "ITIL category not found"
      });
    }
    return res.json({
      success: true
    });
  } catch (err) {
    console.error("Failed to delete ITIL category:", err);
    return res.status(500).json({
      error: "Error deleting ITIL category"
    });
  }
});
router.get("/category-sections", verifyJWT, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT id, name, description, enabled, created_at, updated_at
       FROM v_b_ticket_category_sections
       ORDER BY name ASC`);
    return res.json(result.rows || []);
  } catch (err) {
    console.error("Error loading des sections ITIL:", err);
    return res.status(500).json({
      error: "Error during loading sections ITIL"
    });
  }
});
router.post("/category-sections", verifyJWT, [body("name").isString().notEmpty(), body("description").optional().isString(), body("enabled").optional().isBoolean()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const id = `itil-sec-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const name = String(req.body?.name || "").trim();
    const description = String(req.body?.description || "").trim();
    const enabled = req.body?.enabled !== false;
    const result = await pool.query(`INSERT INTO v_b_ticket_category_sections (id, name, description, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id, name, description, enabled, created_at, updated_at`, [id, name, description, enabled]);
    return res.status(201).json(result.rows?.[0] || null);
  } catch (err) {
    console.error("Failed to create section ITIL:", err);
    return res.status(500).json({
      error: "Error creating ITIL section"
    });
  }
});
router.put("/category-sections/:sectionId", verifyJWT, [param("sectionId").isString().notEmpty(), body("name").optional().isString(), body("description").optional().isString(), body("enabled").optional().isBoolean()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const sectionId = String(req.params?.sectionId || "").trim();
    const existing = await pool.query(`SELECT id, name FROM v_b_ticket_category_sections WHERE id = $1`, [sectionId]);
    if (!existing.rows.length) {
      return res.status(404).json({
        error: "ITIL section not found"
      });
    }
    const oldName = String(existing.rows[0]?.name || "").trim();
    const updates = [];
    const values = [];
    let idx = 1;
    if (Object.prototype.hasOwnProperty.call(req.body, "name")) {
      updates.push(`name = $${idx++}`);
      values.push(String(req.body?.name || "").trim());
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "description")) {
      updates.push(`description = $${idx++}`);
      values.push(String(req.body?.description || "").trim());
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "enabled")) {
      updates.push(`enabled = $${idx++}`);
      values.push(req.body?.enabled !== false);
    }
    if (updates.length === 0) {
      return res.status(400).json({
        error: "No fields to update"
      });
    }
    updates.push("updated_at = NOW()");
    values.push(sectionId);
    const result = await pool.query(`UPDATE v_b_ticket_category_sections
         SET ${updates.join(", ")}
         WHERE id = $${idx}
         RETURNING id, name, description, enabled, created_at, updated_at`, values);
    const newName = String(result.rows?.[0]?.name || "").trim();
    if (oldName && newName && oldName !== newName) {
      await pool.query(`UPDATE v_b_ticket_categories
           SET section = $1
           WHERE section = $2`, [newName, oldName]);
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("Failed to update section ITIL:", err);
    return res.status(500).json({
      error: "Error updating ITIL section"
    });
  }
});
router.delete("/category-sections/:sectionId", verifyJWT, [param("sectionId").isString().notEmpty()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const sectionId = String(req.params?.sectionId || "").trim();
    const existing = await pool.query(`SELECT id, name FROM v_b_ticket_category_sections WHERE id = $1`, [sectionId]);
    if (!existing.rows.length) {
      return res.status(404).json({
        error: "ITIL section not found"
      });
    }
    const sectionName = String(existing.rows[0]?.name || "").trim();
    const linkedCategories = await pool.query(`SELECT COUNT(*)::int AS count FROM v_b_ticket_categories WHERE section = $1`, [sectionName]);
    const linkedCount = Number(linkedCategories.rows?.[0]?.count || 0);
    if (linkedCount > 0) {
      return res.status(409).json({
        error: linkedCount === 1 ? "Unabto delete this section : 1 ITIL category is still linked." : `Unabto delete this section : ${linkedCount} ITIL categories are still linked.`
      });
    }
    await pool.query(`DELETE FROM v_b_ticket_category_sections WHERE id = $1`, [sectionId]);
    return res.json({
      success: true
    });
  } catch (err) {
    console.error("Failed to delete section ITIL:", err);
    return res.status(500).json({
      error: "Error deleting ITIL section"
    });
  }
});
router.get("/solution-catalog", verifyJWT, [query("category").optional().isIn(["intervention", "action"]), query("includeInactive").optional().isBoolean()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const items = await listSolutionCatalog({
      category: req.query?.category || "",
      includeInactive: req.query?.includeInactive === true || req.query?.includeInactive === "true"
    });
    return res.json(items);
  } catch (err) {
    console.error("GET /tickets/solution-catalog:", err);
    return res.status(500).json({
      error: "Error during loading catalog de solutions"
    });
  }
});
router.post("/solution-catalog", verifyJWT, [body("category").isIn(["intervention", "action"]), body("label").isString().notEmpty(), body("displayOrder").optional().isInt({
  min: 0
}), body("isActive").optional().isBoolean()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  if (!isAdminUser(req)) {
    return res.status(403).json({
      error: "Only administrators can manage the solution catalog."
    });
  }
  try {
    const entry = await createSolutionCatalogEntry({
      category: req.body.category,
      label: req.body.label,
      displayOrder: req.body.displayOrder,
      isActive: req.body.isActive
    });
    return res.status(201).json(entry);
  } catch (err) {
    if (err?.message === "INVALID_CATEGORY") {
      return res.status(400).json({
        error: "Invalid category (intervention or action)."
      });
    }
    if (err?.message === "LABEL_REQUIRED") {
      return res.status(400).json({
        error: "Label is required."
      });
    }
    if (String(err?.code || "") === "23505") {
      return res.status(409).json({
        error: "This label already exists for this category."
      });
    }
    console.error("POST /tickets/solution-catalog:", err);
    return res.status(500).json({
      error: "Error creating catalog entry"
    });
  }
});
router.put("/solution-catalog/:entryId", verifyJWT, [param("entryId").isUUID(), body("label").optional().isString(), body("displayOrder").optional().isInt({
  min: 0
}), body("isActive").optional().isBoolean()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  if (!isAdminUser(req)) {
    return res.status(403).json({
      error: "Only administrators can manage the solution catalog."
    });
  }
  try {
    const entry = await updateSolutionCatalogEntry(req.params.entryId, {
      label: req.body.label,
      displayOrder: req.body.displayOrder,
      isActive: req.body.isActive
    });
    if (!entry) return res.status(404).json({
      error: "Catalog entry not found"
    });
    return res.json(entry);
  } catch (err) {
    if (err?.message === "LABEL_REQUIRED") {
      return res.status(400).json({
        error: "Label is required."
      });
    }
    if (err?.message === "NO_CHANGES") {
      return res.status(400).json({
        error: "No fields to update"
      });
    }
    if (String(err?.code || "") === "23505") {
      return res.status(409).json({
        error: "This label already exists for this category."
      });
    }
    console.error("PUT /tickets/solution-catalog/:entryId:", err);
    return res.status(500).json({
      error: "Error updating catalog entry"
    });
  }
});
router.delete("/solution-catalog/:entryId", verifyJWT, [param("entryId").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  if (!isAdminUser(req)) {
    return res.status(403).json({
      error: "Only administrators can manage the solution catalog."
    });
  }
  try {
    const deleted = await deleteSolutionCatalogEntry(req.params.entryId);
    if (!deleted) return res.status(404).json({
      error: "Catalog entry not found"
    });
    return res.json({
      success: true
    });
  } catch (err) {
    console.error("DELETE /tickets/solution-catalog/:entryId:", err);
    return res.status(500).json({
      error: "Error deleting catalog entry"
    });
  }
});
router.get("/trash", verifyJWT, requirePermission("tickets.view"), [query("limit").optional().isInt({
  min: 1,
  max: 200
}), query("offset").optional().isInt({
  min: 0
})], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const hasRequesterContact = await hasRequesterContactColumn();
    const hasDeletedAt = await hasTicketColumn("deleted_at");
    const hasIsDeleted = await hasTicketColumn("is_deleted");
    const hasMajorIncident = await hasTicketColumn("is_major_incident");
    const hasSlaInfo = await hasTicketColumn("sla_info");
    const limitValue = Number(req.query?.limit) || 50;
    const offsetValue = Number(req.query?.offset) || 0;
    const trashWhere = hasDeletedAt ? "t.deleted_at IS NOT NULL" : hasIsDeleted ? "COALESCE(t.is_deleted, FALSE) = TRUE" : "1 = 0";
    const communityTrashFilter = isCommunity() ? ` AND ${COMMUNITY_SALES_TICKET_SQL}` : "";
    const result = await pool.query(`SELECT
          t.id,
          t.ticket_number,
          t.title,
          t.description,
          t.status,
          t.priority,
          t.type,
          t.category,
          t.channel,
          t.client_id,
          ${hasRequesterContact ? "t.requester_contact_id," : ""}
          t.requester_user_id,
          t.assigned_user_id,
          t.created_at,
          t.updated_at,
          t.resolved_at,
          ${hasSlaInfo ? "t.sla_info," : ""}
          c.contrat AS client_contrat,
          ${FIRST_TAKEOVER_AT_SQL},
          ${hasSlaInfo ? `(SELECT MIN(cm.created_at) FROM v_b_ticket_comments cm WHERE cm.ticket_id = t.id AND COALESCE(cm.is_internal, FALSE) = FALSE) AS first_public_comment_at,` : ""}
          ${hasMajorIncident ? "t.is_major_incident," : ""}
          c.name AS client_name,
          c.name AS client_nom,
          req_u.email AS requester_email,
          ass_u.email AS assigned_email,
          (SELECT COUNT(*) FROM v_b_ticket_comments cm WHERE cm.ticket_id = t.id) AS comments_count
         FROM v_b_tickets t
         LEFT JOIN v_b_clients c ON c.id = t.client_id
         LEFT JOIN v_b_users req_u ON req_u.id = t.requester_user_id
         LEFT JOIN v_b_users ass_u ON ass_u.id = t.assigned_user_id
         WHERE ${trashWhere}${communityTrashFilter}
         ORDER BY t.updated_at DESC
         LIMIT $1 OFFSET $2`, [limitValue, offsetValue]);
    return res.json(await enrichTicketRowsWithSla(result.rows, {
      hasSlaInfo
    }));
  } catch (err) {
    console.error("Error fetching corbeille tickets:", err);
    return res.status(500).json({
      error: "Error retrieving ticket trash"
    });
  }
});
router.get("/table-columns", verifyJWT, async (req, res) => {
  try {
    const community = isCommunity();
    const publicColumns = await loadPublicTicketTableColumns();
    const privateColumns = await loadPrivateTicketTableColumns(req.user?.id);
    const resolved = resolveEffectiveTicketTableColumns({
      publicColumns,
      privateColumns,
      isCommunityEdition: community
    });
    res.json(resolved);
  } catch (err) {
    console.error("GET /tickets/table-columns", err);
    res.status(500).json({
      error: "Unable to load table columns"
    });
  }
});
router.put("/table-columns/public", verifyJWT, async (req, res) => {
  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only administrators can edit the public column view"
      });
    }
    const community = isCommunity();
    const columns = normalizeTicketTableColumns(req.body?.columns, {
      fallback: DEFAULT_TICKET_TABLE_COLUMNS
    }) || [...DEFAULT_TICKET_TABLE_COLUMNS];
    const saved = await savePublicTicketTableColumns(columns);
    const privateColumns = await loadPrivateTicketTableColumns(req.user?.id);
    const resolved = resolveEffectiveTicketTableColumns({
      publicColumns: saved,
      privateColumns,
      isCommunityEdition: community
    });
    res.json({
      success: true,
      ...resolved
    });
  } catch (err) {
    console.error("PUT /tickets/table-columns/public", err);
    res.status(500).json({
      error: "Unable to save public columns"
    });
  }
});
router.put("/table-columns/private", verifyJWT, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }
    const community = isCommunity();
    const columns = normalizeTicketTableColumns(req.body?.columns, {
      fallback: DEFAULT_TICKET_TABLE_COLUMNS
    }) || [...DEFAULT_TICKET_TABLE_COLUMNS];
    await upsertUserSetting(userId, TICKET_TABLE_COLUMNS_PRIVATE_SETTING_KEY, columns);
    const publicColumns = await loadPublicTicketTableColumns();
    const resolved = resolveEffectiveTicketTableColumns({
      publicColumns,
      privateColumns: columns,
      isCommunityEdition: community
    });
    res.json({
      success: true,
      ...resolved
    });
  } catch (err) {
    console.error("PUT /tickets/table-columns/private", err);
    res.status(500).json({
      error: "Unable to save private columns"
    });
  }
});
router.delete("/table-columns/private", verifyJWT, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }
    const community = isCommunity();
    await pool.query(
      `DELETE FROM v_b_users_settings
       WHERE user_id = $1 AND setting_key = $2`,
      [userId, TICKET_TABLE_COLUMNS_PRIVATE_SETTING_KEY]
    );
    const publicColumns = await loadPublicTicketTableColumns();
    const resolved = resolveEffectiveTicketTableColumns({
      publicColumns,
      privateColumns: null,
      isCommunityEdition: community
    });
    res.json({
      success: true,
      ...resolved
    });
  } catch (err) {
    console.error("DELETE /tickets/table-columns/private", err);
    res.status(500).json({
      error: "Unable to reset private columns"
    });
  }
});
router.use("/views", ticketViewsRoutes);
router.use("/sales-forms", requirePro, salesFormsRoutes);
router.get("/random", verifyJWT, [query("excludeId").optional().isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const hasDeletedAt = await hasTicketColumn("deleted_at");
    const hasIsDeleted = await hasTicketColumn("is_deleted");
    const where = ["t.status NOT IN ('resolved', 'closed')"];
    const values = [];
    let i = 1;
    if (hasDeletedAt) {
      where.push("t.deleted_at IS NULL");
    } else if (hasIsDeleted) {
      where.push("COALESCE(t.is_deleted, FALSE) = FALSE");
    }
    const excludeId = String(req.query?.excludeId || "").trim();
    if (excludeId) {
      where.push(`t.id <> $${i++}`);
      values.push(excludeId);
    }
    appendCommunityTicketFilters(where);
    const result = await pool.query(`SELECT
          t.id,
          t.ticket_number,
          t.title,
          t.status,
          t.priority,
          t.type,
          t.updated_at
         FROM v_b_tickets t
         WHERE ${where.join(" AND ")}
         ORDER BY RANDOM()
         LIMIT 1`, values);
    if (!result.rows.length) {
      return res.status(404).json({
        error: "No tickand to process"
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error random ticket:", err);
    res.status(500).json({
      error: "Error selecting a random ticket"
    });
  }
});
router.get("/:id", verifyJWT, [param("id").isUUID().withMessage("Invalid ID ticket")], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const ticket = await getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({
      error: "Ticket not found"
    });
    if (isCommunity() && isSalesTicketRow(ticket)) {
      return sendProSalesTicketError(res);
    }
    res.json(ticket);
  } catch (err) {
    console.error("Error fetching du ticket:", err);
    res.status(500).json({
      error: "Error retrieving ticket"
    });
  }
});
function normalizeAiRunbookPayload(raw, {
  resetChecked = false
} = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const checklist = Array.isArray(source.checklist) ? source.checklist.map(step => String(step || "").trim()).filter(Boolean) : [];
  const checkedIn = source.checked && typeof source.checked === "object" ? source.checked : {};
  const checked = {};
  checklist.forEach((_, idx) => {
    const key = `step-${idx}`;
    checked[key] = resetChecked ? false : Boolean(checkedIn[key]);
  });
  return {
    title: String(source.title || "").trim() || "Runbook",
    checklist,
    checked,
    generatedAt: source.generatedAt || new Date().toISOString(),
    generatedBy: source.generatedBy || null,
    updatedAt: new Date().toISOString()
  };
}
router.patch("/:id/ai-runbook", verifyJWT, requireAnyPermission("tickets.edit", "tickets.manage"), [param("id").isUUID().withMessage("Invalid ID ticket")], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    if (!(await hasTicketColumn("ai_runbook"))) {
      return res.status(503).json({
        error: "ai_runbook column unavailable — migration required"
      });
    }
    const {
      id
    } = req.params;
    const existing = await pool.query(`SELECT id, ai_runbook, status, is_deleted FROM v_b_tickets WHERE id = $1`, [id]);
    if (!existing.rows.length) return res.status(404).json({
      error: "Ticket not found"
    });
    if (isTicketLockedForEdits(existing.rows[0])) {
      return res.status(409).json({
        error: "This ticket is closed. Reopen it to edit the runbook."
      });
    }
    const body = req.body || {};
    const current = existing.rows[0].ai_runbook || {};
    const nextSource = {
      title: body.title !== undefined ? body.title : current.title,
      checklist: body.checklist !== undefined ? body.checklist : current.checklist,
      checked: body.checked !== undefined ? body.checked : current.checked,
      generatedAt: body.generatedAt || current.generatedAt,
      generatedBy: body.generatedBy !== undefined ? body.generatedBy : current.generatedBy
    };
    const normalized = normalizeAiRunbookPayload(nextSource, {
      resetChecked: Array.isArray(body.checklist) && body.replaceChecklist === true
    });
    const updated = await pool.query(`UPDATE v_b_tickets
         SET ai_runbook = $1::jsonb, updated_at = NOW()
         WHERE id = $2
         RETURNING ai_runbook`, [JSON.stringify(normalized), id]);
    return res.json({
      ai_runbook: updated.rows[0].ai_runbook
    });
  } catch (err) {
    console.error("Error updating ticket ai_runbook:", err);
    return res.status(500).json({
      error: "Error saving runbook"
    });
  }
});
router.put("/:id", verifyJWT, requirePermission("tickets.edit"), [param("id").isUUID(), body("title").optional().notEmpty(), body("description").optional().isString(), body("status").optional().isIn(STATUS_VALUES), body("priority").optional().isIn(PRIORITY_VALUES), body("type").optional().isString(), body("category").optional({
  nullable: true
}).isString(), body("channel").optional().isString(), body("clientId").optional({
  nullable: true,
  checkFalsy: true
}).isInt(), body("requesterContactId").optional({
  nullable: true,
  checkFalsy: true
}).isInt(), body("requesterUserId").optional({
  nullable: true,
  checkFalsy: true
}).isUUID(), body("assignedUserId").optional({
  nullable: true,
  checkFalsy: true
}).isUUID(), body("isMajorIncident").optional().isBoolean(), body("contactSlots").optional().isArray(), body("equipmentInfo").optional().isObject()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const hasRequesterContact = await hasRequesterContactColumn();
    const hasMajorIncident = await hasTicketColumn("is_major_incident");
    const hasContactSlots = await hasTicketColumn("contact_slots");
    const hasEquipmentInfo = await hasTicketColumn("equipment_info");
    const {
      id
    } = req.params;
    const existing = await pool.query("SELECT * FROM v_b_tickets WHERE id = $1", [id]);
    if (existing.rows.length === 0) return res.status(404).json({
      error: "Ticket not found"
    });
    const oldTicket = existing.rows[0];
    if (isTicketLockedForEdits(oldTicket)) {
      const requestedStatus = Object.prototype.hasOwnProperty.call(req.body, "status") ? normalizeIncomingStatus(req.body.status) : null;
      const reopening = requestedStatus && !isTicketClosedStatus(requestedStatus);
      const hasOtherUpdates = Object.keys(req.body).some(key => {
        if (key === "status") return false;
        return req.body[key] !== undefined;
      });
      if (!reopening || hasOtherUpdates) {
        return res.status(409).json({
          error: "This ticket is closed and can no longer be modified. Reopen it to make changes."
        });
      }
    }
    if (rejectCommunitySalesTicketUpdate(req, res, oldTicket)) return;
    const map = [["title", "title", v => String(v).trim()], ["description", "description", v => v], ["status", "status", v => normalizeIncomingStatus(v)], ["priority", "priority", v => v], ["type", "type", v => v], ["category", "category", v => v ? String(v).trim() : ""], ["channel", "channel", v => v], ["clientId", "client_id", v => v || null], ["requesterUserId", "requester_user_id", v => v || null], ["assignedUserId", "assigned_user_id", v => v || null]];
    if (hasRequesterContact) {
      map.splice(7, 0, ["requesterContactId", "requester_contact_id", v => v || null]);
    }
    if (hasMajorIncident) {
      map.push(["isMajorIncident", "is_major_incident", v => {
        const nextType = Object.prototype.hasOwnProperty.call(req.body, "type") ? req.body.type : oldTicket.type;
        return String(nextType || "").toLowerCase() === "incident" && Boolean(v);
      }]);
    }
    if (hasContactSlots) {
      map.push(["contactSlots", "contact_slots", v => JSON.stringify(normalizeContactSlots(v))]);
    }
    if (hasEquipmentInfo) {
      map.push(["equipmentInfo", "equipment_info", v => JSON.stringify(normalizeEquipmentInfo(v))]);
    }
    const updates = [];
    const values = [];
    let p = 1;
    for (const [bodyKey, dbKey, transform] of map) {
      if (Object.prototype.hasOwnProperty.call(req.body, bodyKey)) {
        updates.push(`${dbKey} = $${p++}`);
        values.push(transform(req.body[bodyKey]));
      }
    }
    const nextType = Object.prototype.hasOwnProperty.call(req.body, "type") ? req.body.type : oldTicket.type;
    const nextMajor = String(nextType || "").toLowerCase() === "incident" && (Object.prototype.hasOwnProperty.call(req.body, "isMajorIncident") ? Boolean(req.body.isMajorIncident) : Boolean(oldTicket.is_major_incident));
    if (nextMajor) {
      const priorityIdx = updates.findIndex(u => u.startsWith("priority ="));
      if (priorityIdx >= 0) {
        values[priorityIdx] = "urgent";
      } else {
        updates.push(`priority = $${p++}`);
        values.push("urgent");
      }
    }
    if (hasRequesterContact && Object.prototype.hasOwnProperty.call(req.body, "requesterContactId") && req.body.requesterContactId && !Object.prototype.hasOwnProperty.call(req.body, "clientId")) {
      const contactClientId = await resolveClientIdFromRequesterContact(req.body.requesterContactId);
      if (contactClientId != null) {
        const clientIdx = updates.findIndex(u => u.startsWith("client_id ="));
        if (clientIdx >= 0) {
          values[clientIdx] = contactClientId;
        } else {
          updates.push(`client_id = $${p++}`);
          values.push(contactClientId);
        }
      }
    }
    if (updates.length === 0) {
      return res.status(400).json({
        error: "No fields to update"
      });
    }
    const newStatus = Object.prototype.hasOwnProperty.call(req.body, "status") && req.body.status ? req.body.status : oldTicket.status;
    if (newStatus === "resolved") updates.push(`resolved_at = COALESCE(resolved_at, NOW())`);
    if (newStatus === "closed") updates.push(`closed_at = COALESCE(closed_at, NOW())`);
    updates.push("updated_at = NOW()");
    values.push(id);
    const result = await pool.query(`UPDATE v_b_tickets SET ${updates.join(", ")} WHERE id = $${p} RETURNING *`, values);
    if (shouldSyncTicketPlanningEvents(req.body, oldTicket, result.rows[0])) {
      await syncTicketPlanningEventClient(result.rows[0].id, result.rows[0].client_id);
    }
    if (oldTicket.status !== result.rows[0].status) {
      await pool.query(`INSERT INTO v_b_ticket_status_history (ticket_id, old_status, new_status, changed_by, note, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`, [id, oldTicket.status, result.rows[0].status, req.user?.id || null, null]);
      if (await hasTicketColumn("sla_info")) {
        await maybeRecordTakeoverSla(id, oldTicket.status, result.rows[0].status);
      }
    }
    await logTicketFieldChanges({
      ticketId: id,
      oldTicket,
      newTicket: result.rows[0],
      actorUserId: req.user?.id || null
    }).catch(() => {});
    await dispatchNotificationEvent({
      source: "tickets",
      element: result.rows[0]?.status === "resolved" ? "resolved" : "updated",
      enterpriseId: String(result.rows[0]?.client_id || ""),
      user: req.user,
      context: {
        ticket: result.rows[0],
        oldTicket,
        entreprise: {
          id: String(result.rows[0]?.client_id || "")
        }
      }
    }).catch(() => {});
    await notifyInAppTicketStatusChanged({
      ticketId: id,
      newStatus: result.rows[0]?.status,
      changedByUserId: req.user?.id || null
    }).catch(() => {});
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating ticket:", err);
    res.status(500).json({
      error: "Error updating ticket"
    });
  }
});
router.delete("/:id", verifyJWT, requirePermission("tickets.delete"), [param("id").isUUID().withMessage("Invalid ID ticket")], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const {
      id
    } = req.params;
    const exists = await pool.query("SELECT id FROM v_b_tickets WHERE id = $1", [id]);
    if (exists.rows.length === 0) return res.status(404).json({
      error: "Ticket not found"
    });
    await softDeleteTicketById(id);
    await logTicketActivity({
      ticketId: id,
      action: "deleted",
      actorUserId: req.user?.id || null
    }).catch(() => {});
    res.json({
      success: true
    });
  } catch (err) {
    if (err?.status === 503) {
      return res.status(503).json({
        error: err.message
      });
    }
    console.error("Failed to delete ticket:", err);
    res.status(500).json({
      error: "Error deleting ticket"
    });
  }
});
router.post("/:id/restore", verifyJWT, requirePermission("tickets.edit"), [param("id").isUUID().withMessage("Invalid ID ticket")], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const {
      id
    } = req.params;
    const exists = await pool.query("SELECT id FROM v_b_tickets WHERE id = $1", [id]);
    if (exists.rows.length === 0) return res.status(404).json({
      error: "Ticket not found"
    });
    const hasDeletedAt = await hasTicketColumn("deleted_at");
    const hasIsDeleted = await hasTicketColumn("is_deleted");
    const assignments = [];
    if (hasDeletedAt) assignments.push("deleted_at = NULL");
    if (hasIsDeleted) assignments.push("is_deleted = FALSE");
    assignments.push("updated_at = NOW()");
    await pool.query(`UPDATE v_b_tickets SET ${assignments.join(", ")} WHERE id = $1`, [id]);
    await logTicketActivity({
      ticketId: id,
      action: "restored",
      actorUserId: req.user?.id || null
    }).catch(() => {});
    res.json({
      success: true
    });
  } catch (err) {
    console.error("Error restore ticket:", err);
    res.status(500).json({
      error: "Error restoring ticket"
    });
  }
});
router.delete("/:id/purge", verifyJWT, requirePermission("tickets.manage"), [param("id").isUUID().withMessage("Invalid ID ticket")], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const {
      id
    } = req.params;
    const exists = await pool.query("SELECT id FROM v_b_tickets WHERE id = $1", [id]);
    if (exists.rows.length === 0) return res.status(404).json({
      error: "Ticket not found"
    });
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only administrators can permanently delete a ticket"
      });
    }
    await pool.query("DELETE FROM v_b_tickets WHERE id = $1", [id]);
    res.json({
      success: true
    });
  } catch (err) {
    console.error("Error purge ticket:", err);
    res.status(500).json({
      error: "Error purging ticket"
    });
  }
});
router.patch("/:id/status", verifyJWT, [param("id").isUUID(), body("status").isIn(STATUS_VALUES), body("note").optional().isString(), body("consumeSupportCredit").optional().isBoolean(), body("supportCreditDebits").optional().isArray(), body("supportCreditDebits.*.packId").optional().isUUID(), body("supportCreditDebits.*.amount").optional().isInt({
  min: 1
}), body("refundSupportCredit").optional().isBoolean()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const {
      id
    } = req.params;
    const {
      status,
      note = null,
      consumeSupportCredit = false,
      supportCreditDebits = null,
      refundSupportCredit = false
    } = req.body;
    const normalizedStatus = normalizeIncomingStatus(status);
    const existing = await pool.query("SELECT id, status, client_id, type, category, ticket_number FROM v_b_tickets WHERE id = $1", [id]);
    if (existing.rows.length === 0) return res.status(404).json({
      error: "Ticket not found"
    });
    const oldStatus = existing.rows[0].status;
    const isReopen = isTicketClosedStatus(oldStatus) && !isTicketClosedStatus(normalizedStatus);
    let creditChanges = {};
    try {
      creditChanges = await handleTicketStatusCreditChange({
        ticketId: id,
        oldStatus,
        newStatus: normalizedStatus,
        userId: req.user?.id || null,
        consumeSupportCredit: Boolean(consumeSupportCredit),
        supportCreditDebits: Array.isArray(supportCreditDebits) ? supportCreditDebits : null,
        refundSupportCredit: Boolean(refundSupportCredit)
      });
    } catch (creditErr) {
      if (creditErr?.code === "INSUFFICIENT_SUPPORT_CREDITS") {
        return res.status(creditErr.status || 402).json({
          error: creditErr.message,
          code: creditErr.code,
          balance: creditErr.balance ?? 0
        });
      }
      throw creditErr;
    }
    const result = await pool.query(`UPDATE v_b_tickets
         SET status = $1::varchar,
             resolved_at = CASE
               WHEN $1::varchar = 'resolved' THEN COALESCE(resolved_at, NOW())
               WHEN $1::varchar IN ('in_progress', 'open', 'pending', 'new') THEN NULL
               ELSE resolved_at
             END,
             closed_at = CASE
               WHEN $1::varchar = 'closed' THEN COALESCE(closed_at, NOW())
               WHEN $1::varchar IN ('in_progress', 'open', 'pending', 'new') THEN NULL
               ELSE closed_at
             END,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`, [normalizedStatus, id]);
    if (oldStatus !== normalizedStatus) {
      await pool.query(`INSERT INTO v_b_ticket_status_history (ticket_id, old_status, new_status, changed_by, note, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`, [id, oldStatus, normalizedStatus, req.user?.id || null, note]);
      if (await hasTicketColumn("sla_info")) {
        await maybeRecordTakeoverSla(id, oldStatus, normalizedStatus);
      }
    }
    if (isReopen) {
      await markResolutionValidationReopened(id);
      const reopenNote = String(note || "").trim();
      if (reopenNote) {
        await pool.query(`INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
             VALUES ($1, $2, $3, true, NOW())`, [id, req.user?.id || null, `[Tickand reopen] ${reopenNote}`]);
        await pool.query("UPDATE v_b_tickets SET updated_at = NOW() WHERE id = $1", [id]);
      }
    }
    await dispatchNotificationEvent({
      source: "tickets",
      element: normalizedStatus === "resolved" ? "resolved" : "updated",
      enterpriseId: String(result.rows[0]?.client_id || existing.rows[0]?.client_id || ""),
      user: req.user,
      context: {
        ticket: result.rows[0],
        oldStatus,
        newStatus: normalizedStatus,
        entreprise: {
          id: String(result.rows[0]?.client_id || existing.rows[0]?.client_id || "")
        }
      }
    }).catch(() => {});
    await notifyInAppTicketStatusChanged({
      ticketId: id,
      newStatus: normalizedStatus,
      changedByUserId: req.user?.id || null
    }).catch(() => {});
    const ticket = await getTicketById(id);
    res.json({
      ...ticket,
      creditChanges
    });
  } catch (err) {
    console.error("Error changement de statut ticket:", err);
    res.status(500).json({
      error: "Error during changing tickand status"
    });
  }
});
router.post("/:id/comments", verifyJWT, attachmentUpload.array("attachments", 10), [param("id").isUUID(), body("isInternal").optional().isBoolean()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const {
      id
    } = req.params;
    const exists = await pool.query("SELECT id, client_id, status, is_deleted FROM v_b_tickets WHERE id = $1", [id]);
    if (exists.rows.length === 0) return res.status(404).json({
      error: "Ticket not found"
    });
    if (isTicketLockedForEdits(exists.rows[0])) {
      return res.status(409).json({
        error: "This ticket is closed. Reopen it to add a message."
      });
    }
    const content = String(req.body?.content || "").trim();
    const files = Array.isArray(req.files) ? req.files : [];
    if (!content && files.length === 0) {
      return res.status(400).json({
        error: "Comment cannot be empty (text or attachment required)."
      });
    }
    const result = await pool.query(`INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING *`, [id, req.user?.id || null, content, Boolean(req.body.isInternal)]);
    const createdComment = result.rows[0];
    if (files.length > 0) {
      for (const file of files) {
        const relativePath = `/uploads/tickets/${path.basename(file.path)}`;
        await pool.query(`INSERT INTO v_b_ticket_attachments
              (ticket_id, comment_id, uploaded_by, file_name, file_path, mime_type, file_size, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`, [id, createdComment.id, req.user?.id || null, file.originalname || path.basename(file.path), relativePath, file.mimetype || "application/octet-stream", Number(file.size || 0)]);
      }
    }
    await pool.query("UPDATE v_b_tickets SET updated_at = NOW() WHERE id = $1", [id]);
    if (!Boolean(req.body.isInternal) && (await hasTicketColumn("sla_info"))) {
      await ensureTicketSlaInfoStored(id);
    }
    const attachmentsResult = await pool.query(`SELECT id, ticket_id, comment_id, uploaded_by, file_name, file_path, mime_type, file_size, created_at
         FROM v_b_ticket_attachments
         WHERE comment_id = $1
         ORDER BY created_at ASC`, [createdComment.id]);
    await dispatchNotificationEvent({
      source: "tickets",
      element: "commented",
      enterpriseId: String(exists.rows[0]?.client_id || ""),
      user: req.user,
      context: {
        ticket: {
          id
        },
        comment: createdComment,
        entreprise: {
          id: String(exists.rows[0]?.client_id || "")
        }
      }
    }).catch(() => {});
    await notifyInAppTicketCommented({
      ticketId: id,
      commentId: createdComment.id,
      authorUserId: req.user?.id || null,
      isInternal: Boolean(req.body.isInternal),
      contentPreview: content
    }).catch(() => {});
    let whatsappDelivery = null;
    if (!Boolean(req.body.isInternal)) {
      whatsappDelivery = {
        attempted: false
      };
      try {
        const waResult = await maybeSendWhatsAppReplyForComment({
          ticketId: id,
          content,
          isInternal: false,
          attachments: attachmentsResult.rows
        });
        if (waResult?.skipped) {
          whatsappDelivery = {
            attempted: false,
            skipped: true,
            reason: waResult.reason
          };
        } else {
          whatsappDelivery = {
            attempted: true,
            success: true,
            ...waResult
          };
        }
      } catch (whatsappErr) {
        console.error("Error sending WhatsApp reply:", whatsappErr);
        whatsappDelivery = {
          attempted: true,
          success: false,
          error: whatsappErr?.message || "WhatsApp send failed."
        };
      }
    }
    res.status(201).json({
      ...(await enrichCommentWithAuthor(createdComment)),
      attachments: attachmentsResult.rows,
      whatsappDelivery
    });
  } catch (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: "Fitoo large. Maximum allowed size: 15 MB."
        });
      }
      return res.status(400).json({
        error: err.message || "File upload error"
      });
    }
    if (err?.message && err.message.includes("File type not allowed")) {
      return res.status(400).json({
        error: err.message
      });
    }
    console.error("Error ajout de commentaire ticket:", err);
    res.status(500).json({
      error: "Error adding comment"
    });
  }
});
function isSystemTicketCommentContent(content) {
  const text = String(content || "").trim();
  if (!text) return true;
  const systemPrefixes = ["[Linked ticket]", "[Linked equipment]", "[Split ticket]", "[Side conversation]", "[WhatsApp]", "[Macro ", "[Resolution"];
  return systemPrefixes.some(prefix => text.startsWith(prefix));
}
function isClientResponseComment(comment, authorRole = null) {
  if (!comment || Boolean(comment.is_internal)) return false;
  const content = String(comment.content || "").trim();
  if (content.startsWith("[WhatsApp]")) return true;
  if (content.startsWith("[Email entrant]")) return true;
  if (String(authorRole || "").toLowerCase() === "client") return true;
  return false;
}
function isSideConversationMessageContent(content) {
  const text = String(content || "").trim();
  if (!text.startsWith("[Side conversation]")) return false;
  return /\[event:message\]/.test(text);
}
function normalizeAttachmentStoragePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, "http://local");
    return parsed.pathname;
  } catch {
    return raw.split("?")[0];
  }
}
router.patch("/:id/comments/:commentId", verifyJWT, [param("id").isUUID(), param("commentId").isUUID(), body("content").isString(), body("removeAttachmentIds").optional().isArray(), body("removeAttachmentIds.*").optional().isUUID(), body("removeAttachmentPaths").optional().isArray(), body("removeAttachmentPaths.*").optional().isString()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const {
      id,
      commentId
    } = req.params;
    const content = String(req.body?.content || "").trim();
    const removeAttachmentIds = Array.isArray(req.body?.removeAttachmentIds) ? [...new Set(req.body.removeAttachmentIds.map(value => String(value)).filter(Boolean))] : [];
    const removeAttachmentPaths = Array.isArray(req.body?.removeAttachmentPaths) ? [...new Set(req.body.removeAttachmentPaths.map(value => normalizeAttachmentStoragePath(value)).filter(Boolean))] : [];
    if (isSystemTicketCommentContent(content)) {
      return res.status(400).json({
        error: "This message type cannot be edited."
      });
    }
    const ticketExists = await pool.query("SELECT id, status, is_deleted FROM v_b_tickets WHERE id = $1", [id]);
    if (ticketExists.rows.length === 0) return res.status(404).json({
      error: "Ticket not found"
    });
    if (isTicketLockedForEdits(ticketExists.rows[0])) {
      return res.status(409).json({
        error: "This ticket is closed. Reopen it to edit a message."
      });
    }
    const hasCommentUpdatedAt = await hasCommentColumn("updated_at");
    if (!hasCommentUpdatedAt) {
      return res.status(503).json({
        error: "Comment editing requires the updated_at migration. Run: node scripts/run-ticket-comment-updated-at-migration.js"
      });
    }
    const commentResult = await pool.query(`SELECT id, ticket_id, author_user_id, content, is_internal, created_at, ${commentUpdatedAtSelectSql(true)}
         FROM v_b_ticket_comments
         WHERE id = $1 AND ticket_id = $2`, [commentId, id]);
    if (commentResult.rows.length === 0) {
      return res.status(404).json({
        error: "Comment not found"
      });
    }
    const existing = commentResult.rows[0];
    const userId = req.user?.id || null;
    if (!userId || !existing.author_user_id || String(existing.author_user_id) !== String(userId)) {
      return res.status(403).json({
        error: "Vous ne pouvez modifier que vos propres messages."
      });
    }
    if (isSystemTicketCommentContent(existing.content)) {
      return res.status(400).json({
        error: "This message type cannot be edited."
      });
    }
    const attachmentsBeforeResult = await pool.query(`SELECT id, file_path
         FROM v_b_ticket_attachments
         WHERE comment_id = $1 AND ticket_id = $2`, [commentId, id]);
    const removeIdSet = new Set(removeAttachmentIds.filter(attachmentId => attachmentsBeforeResult.rows.some(row => String(row.id) === String(attachmentId))));
    const removePathSet = new Set(removeAttachmentPaths);
    const idsToDelete = attachmentsBeforeResult.rows.filter(row => {
      if (removeIdSet.has(String(row.id))) return true;
      const storagePath = normalizeAttachmentStoragePath(row.file_path);
      return storagePath && removePathSet.has(storagePath);
    }).map(row => String(row.id));
    const remainingAttachmentCount = attachmentsBeforeResult.rows.length - idsToDelete.length;
    if (!content && remainingAttachmentCount === 0) {
      return res.status(400).json({
        error: "Comment cannot be empty (text or attachment required)."
      });
    }
    if (idsToDelete.length > 0) {
      await pool.query(`DELETE FROM v_b_ticket_attachments
           WHERE comment_id = $1 AND ticket_id = $2 AND id = ANY($3::uuid[])`, [commentId, id, idsToDelete]);
    }
    const updateResult = await pool.query(`UPDATE v_b_ticket_comments
         SET content = $1, updated_at = NOW()
         WHERE id = $2 AND ticket_id = $3
         RETURNING id, ticket_id, author_user_id, content, is_internal, created_at, updated_at`, [content, commentId, id]);
    await pool.query("UPDATE v_b_tickets SET updated_at = NOW() WHERE id = $1", [id]);
    const updatedComment = updateResult.rows[0];
    const attachmentsResult = await pool.query(`SELECT id, ticket_id, comment_id, uploaded_by, file_name, file_path, mime_type, file_size, created_at
         FROM v_b_ticket_attachments
         WHERE comment_id = $1
         ORDER BY created_at ASC`, [commentId]);
    res.json({
      ...(await enrichCommentWithAuthor(updatedComment)),
      attachments: attachmentsResult.rows
    });
  } catch (err) {
    console.error("Error updating de commentaire ticket:", err);
    res.status(500).json({
      error: "Error updating comment"
    });
  }
});
router.delete("/:id/comments/:commentId", verifyJWT, [param("id").isUUID(), param("commentId").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Only administrators can delete messages."
      });
    }
    const {
      id,
      commentId
    } = req.params;
    const ticketExists = await pool.query("SELECT id, status, is_deleted FROM v_b_tickets WHERE id = $1", [id]);
    if (ticketExists.rows.length === 0) return res.status(404).json({
      error: "Ticket not found"
    });
    if (isTicketLockedForEdits(ticketExists.rows[0])) {
      return res.status(409).json({
        error: "This ticket is closed. Reopen it to delete a message."
      });
    }
    const commentResult = await pool.query(`SELECT id, ticket_id, author_user_id, content, is_internal, created_at
         FROM v_b_ticket_comments
         WHERE id = $1 AND ticket_id = $2`, [commentId, id]);
    if (commentResult.rows.length === 0) {
      return res.status(404).json({
        error: "Comment not found"
      });
    }
    const existing = commentResult.rows[0];
    let authorRole = null;
    if (existing.author_user_id) {
      const authorResult = await pool.query(`SELECT role FROM v_b_users WHERE id = $1`, [existing.author_user_id]);
      authorRole = authorResult.rows[0]?.role || null;
    }
    if (isClientResponseComment(existing, authorRole)) {
      return res.status(403).json({
        error: "Client replies cannot be deleted."
      });
    }
    if (isSystemTicketCommentContent(existing.content) && !isSideConversationMessageContent(existing.content)) {
      return res.status(400).json({
        error: "This message type cannot be deleted."
      });
    }
    await pool.query(`DELETE FROM v_b_ticket_attachments WHERE comment_id = $1`, [commentId]);
    await pool.query(`DELETE FROM v_b_ticket_comments WHERE id = $1 AND ticket_id = $2`, [commentId, id]);
    await pool.query(`UPDATE v_b_tickets SET updated_at = NOW() WHERE id = $1`, [id]);
    res.json({
      success: true,
      id: commentId
    });
  } catch (err) {
    console.error("Error deleting de commentaire ticket:", err);
    res.status(500).json({
      error: "Error deleting comment"
    });
  }
});
router.post("/:id/resolve-with-validation", verifyJWT, [param("id").isUUID(), body("reason").isString().notEmpty(), body("interventionType").isString().notEmpty(), body("actionType").isString().notEmpty(), body("consumeSupportCredit").optional().isBoolean(), body("supportCreditDebits").optional().isArray(), body("supportCreditDebits.*.packId").optional().isUUID(), body("supportCreditDebits.*.amount").optional().isInt({
  min: 1
})], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const result = await resolveTicketWithClientValidation({
      ticketId: req.params.id,
      userId: req.user?.id || null,
      reason: req.body.reason,
      interventionType: req.body.interventionType,
      actionType: req.body.actionType,
      consumeSupportCredit: Boolean(req.body.consumeSupportCredit),
      supportCreditDebits: Array.isArray(req.body.supportCreditDebits) ? req.body.supportCreditDebits : null
    });
    if (!result) return res.status(404).json({
      error: "Ticket not found"
    });
    const ticket = await getTicketById(req.params.id);
    res.status(201).json(ticket || result);
  } catch (err) {
    if (err?.code === "INSUFFICIENT_SUPPORT_CREDITS") {
      return res.status(err.status || 402).json({
        error: err.message,
        code: err.code,
        balance: err.balance ?? 0
      });
    }
    if (err?.message === "REASON_REQUIRED") {
      return res.status(400).json({
        error: "Resolution reason is required."
      });
    }
    if (err?.message === "INTERVENTION_TYPE_REQUIRED") {
      return res.status(400).json({
        error: "Intervention type is required."
      });
    }
    if (err?.message === "ACTION_TYPE_REQUIRED") {
      return res.status(400).json({
        error: "Action type is required."
      });
    }
    if (err?.message === "TICKET_ALREADY_CLOSED") {
      return res.status(400).json({
        error: "This tickand is already closeded."
      });
    }
    if (err?.message === "VALIDATION_ALREADY_PENDING") {
      return res.status(409).json({
        error: "A client validation is already pending on this ticket."
      });
    }
    if (err?.message === "VALIDATION_UNAVAILABLE") {
      return res.status(503).json({
        error: "Client validation moduunavailable. Ra : node scripts/run-ticket-resolution-validation-migration.js"
      });
    }
    console.error("POST /tickets/:id/resolve-with-validation:", err);
    res.status(500).json({
      error: "Error resolving ticket"
    });
  }
});
router.post("/:id/tags", verifyJWT, [param("id").isUUID(), body("label").notEmpty().isString(), body("color").optional().isString()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const {
      id
    } = req.params;
    const label = String(req.body.label).trim().toLowerCase();
    const color = req.body.color || null;
    const ticketExists = await pool.query("SELECT id FROM v_b_tickets WHERE id = $1", [id]);
    if (ticketExists.rows.length === 0) return res.status(404).json({
      error: "Ticket not found"
    });
    const tagResult = await findOrCreateTicketTag(label, color);
    const linkResult = await pool.query(`INSERT INTO v_b_ticket_tag_links (ticket_id, tag_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (ticket_id, tag_id) DO NOTHING
         RETURNING tag_id`, [id, tagResult.id]);
    if (linkResult.rows.length > 0) {
      await logTicketActivity({
        ticketId: id,
        action: "tag_added",
        field: "tag",
        newValue: tagResult.label || label,
        actorUserId: req.user?.id || null,
        meta: {
          tagId: tagResult.id
        }
      }).catch(() => {});
    }
    res.status(201).json(tagResult);
  } catch (err) {
    console.error("Error ajout tag ticket:", err);
    res.status(500).json({
      error: "Error adding tag"
    });
  }
});
router.delete("/:id/tags/:tagId", verifyJWT, [param("id").isUUID(), param("tagId").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const {
      id,
      tagId
    } = req.params;
    const tagLookup = await pool.query(`SELECT t.label
         FROM v_b_ticket_tag_links l
         JOIN v_b_ticket_tags t ON t.id = l.tag_id
         WHERE l.ticket_id = $1 AND l.tag_id = $2
         LIMIT 1`, [id, tagId]);
    const deleted = await pool.query("DELETE FROM v_b_ticket_tag_links WHERE ticket_id = $1 AND tag_id = $2 RETURNING tag_id", [id, tagId]);
    if (deleted.rows.length > 0) {
      await logTicketActivity({
        ticketId: id,
        action: "tag_removed",
        field: "tag",
        oldValue: tagLookup.rows[0]?.label || tagId,
        actorUserId: req.user?.id || null,
        meta: {
          tagId
        }
      }).catch(() => {});
    }
    res.json({
      success: true
    });
  } catch (err) {
    console.error("Failed to delete tag ticket:", err);
    res.status(500).json({
      error: "Error deleting tag"
    });
  }
});
router.post("/:id/watchers", verifyJWT, [param("id").isUUID(), body("userId").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const {
      id
    } = req.params;
    const {
      userId
    } = req.body;
    const insertResult = await pool.query(`INSERT INTO v_b_ticket_watchers (ticket_id, user_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (ticket_id, user_id) DO NOTHING
         RETURNING user_id`, [id, userId]);
    if (insertResult.rows.length > 0) {
      await logTicketActivity({
        ticketId: id,
        action: "watcher_added",
        field: "watcher",
        newValue: userId,
        actorUserId: req.user?.id || null
      }).catch(() => {});
    }
    res.status(201).json({
      success: true
    });
  } catch (err) {
    console.error("Error ajout watcher:", err);
    res.status(500).json({
      error: "Error adding follower"
    });
  }
});
router.delete("/:id/watchers/:userId", verifyJWT, [param("id").isUUID(), param("userId").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const {
      id,
      userId
    } = req.params;
    const deleted = await pool.query("DELETE FROM v_b_ticket_watchers WHERE ticket_id = $1 AND user_id = $2 RETURNING user_id", [id, userId]);
    if (deleted.rows.length > 0) {
      await logTicketActivity({
        ticketId: id,
        action: "watcher_removed",
        field: "watcher",
        oldValue: userId,
        actorUserId: req.user?.id || null
      }).catch(() => {});
    }
    res.json({
      success: true
    });
  } catch (err) {
    console.error("Failed to delete watcher:", err);
    res.status(500).json({
      error: "Error deleting follower"
    });
  }
});
router.post("/:id/assignees", verifyJWT, [param("id").isUUID(), body("userId").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const hasAssignees = await hasTicketAssigneesTable();
    if (!hasAssignees) {
      return res.status(400).json({
        error: "Multi-assignee support is not available (ticketing_multi_assignees_core migration not applied)."
      });
    }
    const {
      id
    } = req.params;
    const {
      userId
    } = req.body;
    const insertResult = await pool.query(`INSERT INTO v_b_ticket_assignees (ticket_id, user_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (ticket_id, user_id) DO NOTHING
         RETURNING user_id`, [id, userId]);
    await pool.query(`UPDATE v_b_tickets
         SET assigned_user_id = $1, updated_at = NOW()
         WHERE id = $2`, [userId, id]);
    if (insertResult.rows.length > 0) {
      await logTicketActivity({
        ticketId: id,
        action: "assignee_added",
        field: "assignee",
        newValue: userId,
        actorUserId: req.user?.id || null
      }).catch(() => {});
    }
    await notifyInAppTicketAssigned({
      ticketId: id,
      assignedUserId: userId,
      assignedByUserId: req.user?.id || null
    }).catch(() => {});
    res.status(201).json({
      success: true
    });
  } catch (err) {
    console.error("Error adding assignee:", err);
    res.status(500).json({
      error: "Error adding assignee"
    });
  }
});
router.delete("/:id/assignees/:userId", verifyJWT, [param("id").isUUID(), param("userId").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const hasAssignees = await hasTicketAssigneesTable();
    if (!hasAssignees) {
      return res.status(400).json({
        error: "Multi-assignee support is not available (ticketing_multi_assignees_core migration not applied)."
      });
    }
    const {
      id,
      userId
    } = req.params;
    const deleted = await pool.query("DELETE FROM v_b_ticket_assignees WHERE ticket_id = $1 AND user_id = $2 RETURNING user_id", [id, userId]);
    const nextAssigneeResult = await pool.query(`SELECT user_id
         FROM v_b_ticket_assignees
         WHERE ticket_id = $1
         ORDER BY created_at DESC
         LIMIT 1`, [id]);
    const fallbackAssignedUserId = nextAssigneeResult.rows.length > 0 ? nextAssigneeResult.rows[0].user_id : null;
    await pool.query(`UPDATE v_b_tickets
         SET assigned_user_id = $1, updated_at = NOW()
         WHERE id = $2`, [fallbackAssignedUserId, id]);
    if (deleted.rows.length > 0) {
      await logTicketActivity({
        ticketId: id,
        action: "assignee_removed",
        field: "assignee",
        oldValue: userId,
        actorUserId: req.user?.id || null
      }).catch(() => {});
    }
    res.json({
      success: true
    });
  } catch (err) {
    console.error("Failed to delete assignee:", err);
    res.status(500).json({
      error: "Error deleting assignee"
    });
  }
});
export default router;
