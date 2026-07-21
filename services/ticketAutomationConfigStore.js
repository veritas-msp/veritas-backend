import { pool } from "../database/db.js";
const SINGLETON_ID = 1;
const TABLES = {
  commentTemplates: "v_b_ticket_comment_templates_config",
  macros: "v_b_ticket_macros_config",
  emailInboxes: "v_b_ticket_email_inboxes_config",
  exclusionRules: "v_b_ticket_exclusion_rules_config",
  autoReplyRules: "v_b_ticket_auto_reply_rules_config",
  autoReplyTemplate: "v_b_ticket_auto_reply_template_config",
  scheduledAlertRules: "v_b_ticket_scheduled_alert_rules_config",
  chatUiSettings: "v_b_ticket_chat_ui_settings_config",
  mailCollectors: "v_b_ticket_mail_collectors_config",
  mailCollectSettings: "v_b_ticket_mail_collect_settings_config",
  notificationEvents: "v_b_notification_events_config",
  notificationWebhooks: "v_b_notification_webhooks_config",
  notificationTemplates: "v_b_notification_templates_config",
  notificationLogs: "v_b_notification_logs_config"
};
const LEGACY_AUTOMATION_TABLE = "v_b_ticket_automation_config";
const LEGACY_COLUMN_BY_TABLE = {
  [TABLES.commentTemplates]: "comment_templates",
  [TABLES.macros]: "macros",
  [TABLES.emailInboxes]: "email_inboxes",
  [TABLES.exclusionRules]: "exclusion_rules",
  [TABLES.autoReplyRules]: "auto_reply_rules",
  [TABLES.autoReplyTemplate]: "auto_reply_template",
  [TABLES.scheduledAlertRules]: "scheduled_alert_rules",
  [TABLES.chatUiSettings]: "chat_ui_settings",
  [TABLES.mailCollectors]: "mail_collectors"
};
const tableColumnsCache = new Map();
async function hasLegacyAutomationColumn(columnName) {
  const cacheKey = `${LEGACY_AUTOMATION_TABLE}.${columnName}`;
  if (tableColumnsCache.has(cacheKey)) return tableColumnsCache.get(cacheKey);
  try {
    const result = await pool.query(`SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1
           AND column_name = $2
       ) AS has_column`, [LEGACY_AUTOMATION_TABLE, columnName]);
    const exists = Boolean(result.rows?.[0]?.has_column);
    tableColumnsCache.set(cacheKey, exists);
    return exists;
  } catch (_err) {
    tableColumnsCache.set(cacheKey, false);
    return false;
  }
}
async function writeLegacyAutomationColumn(tableName, value) {
  const columnName = LEGACY_COLUMN_BY_TABLE[tableName];
  if (!columnName) return false;
  const hasColumn = await hasLegacyAutomationColumn(columnName);
  if (!hasColumn) return false;
  const isTemplateText = tableName === TABLES.autoReplyTemplate;
  const payload = isTemplateText ? String(value || "") : JSON.stringify(value);
  const cast = isTemplateText ? "" : "::jsonb";
  const update = await pool.query(`UPDATE ${LEGACY_AUTOMATION_TABLE}
     SET ${columnName} = $1${cast},
         updated_at = NOW()
     WHERE id = $2`, [payload, SINGLETON_ID]);
  if (update.rowCount === 0) {
    await pool.query(`INSERT INTO ${LEGACY_AUTOMATION_TABLE} (id, ${columnName}, created_at, updated_at)
       VALUES ($1, $2${cast}, NOW(), NOW())`, [SINGLETON_ID, payload]);
  }
  return true;
}
async function getTableColumns(tableName) {
  if (tableColumnsCache.has(tableName)) return tableColumnsCache.get(tableName);
  try {
    const result = await pool.query(`SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1`, [tableName]);
    const columns = new Set((Array.isArray(result.rows) ? result.rows : []).map(row => String(row?.column_name || "")));
    tableColumnsCache.set(tableName, columns);
    return columns;
  } catch (_err) {
    return new Set();
  }
}
async function readJsonTable(tableName, defaultValue) {
  try {
    const result = await pool.query(`SELECT data
       FROM ${tableName}
       WHERE id = $1
       LIMIT 1`, [SINGLETON_ID]);
    if (!result.rows.length) return defaultValue;
    const value = result.rows[0]?.data;
    if (Array.isArray(defaultValue)) return Array.isArray(value) ? value : defaultValue;
    if (defaultValue && typeof defaultValue === "object" && !Array.isArray(defaultValue)) {
      return value && typeof value === "object" && !Array.isArray(value) ? value : defaultValue;
    }
    if (typeof defaultValue === "string") return typeof value === "string" ? value : defaultValue;
    return value ?? defaultValue;
  } catch (err) {
    if (err?.code === "42703") return defaultValue;
    if (err?.code === "42P01") return defaultValue;
    throw err;
  }
}
async function writeJsonTable(tableName, value) {
  const payload = JSON.stringify(value);
  try {
    const update = await pool.query(`UPDATE ${tableName}
       SET data = $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`, [payload, SINGLETON_ID]);
    if (update.rowCount === 0) {
      await pool.query(`INSERT INTO ${tableName} (id, data, created_at, updated_at)
         VALUES ($1, $2::jsonb, NOW(), NOW())`, [SINGLETON_ID, payload]);
    }
  } catch (err) {
    if (err?.code === "42703" || err?.code === "42P01" || err?.code === "42501") {
      const fallbackDone = await writeLegacyAutomationColumn(tableName, value).catch(() => false);
      if (fallbackDone) return;
      if (err?.code === "42703") return;
    }
    throw err;
  }
}
function normalizeNotificationLogRow(row = {}) {
  return {
    id: String(row?.id || ""),
    source: String(row?.source || ""),
    status: String(row?.status || ""),
    channel: String(row?.channel || ""),
    element: String(row?.element || ""),
    message: String(row?.message || ""),
    createdAt: String(row?.created_at || row?.createdAt || new Date().toISOString()),
    enterpriseId: String(row?.enterprise_id || row?.enterpriseId || "")
  };
}
function normalizeTimestampForSql(value) {
  const raw = String(value || "").trim();
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}
async function readNotificationLogsRows(defaultValue = []) {
  const columns = await getTableColumns(TABLES.notificationLogs);
  if (columns.has("data")) {
    return readJsonTable(TABLES.notificationLogs, defaultValue);
  }
  if (!columns.has("id")) return defaultValue;
  const hasEnterpriseId = columns.has("enterprise_id");
  const result = await pool.query(`SELECT id, source, status, channel, element, message, created_at${hasEnterpriseId ? ", enterprise_id" : ""}
     FROM ${TABLES.notificationLogs}
     ORDER BY created_at DESC
     LIMIT 500`);
  return (Array.isArray(result.rows) ? result.rows : []).map(row => normalizeNotificationLogRow({
    ...row,
    enterprise_id: hasEnterpriseId ? row?.enterprise_id : ""
  }));
}
function buildUniqueLogs(logs = []) {
  const seen = new Set();
  return (Array.isArray(logs) ? logs : []).map((log, idx) => ({
    ...log,
    id: String(log?.id || `notif-log-${Date.now()}-${idx}-${Math.random().toString(16).slice(2, 8)}`)
  })).map((log, idx) => {
    if (!seen.has(log.id)) {
      seen.add(log.id);
      return log;
    }
    const nextId = `${log.id}-${idx}-${Math.random().toString(16).slice(2, 6)}`;
    seen.add(nextId);
    return {
      ...log,
      id: nextId
    };
  });
}
async function writeNotificationLogsRows(logs = []) {
  const safeLogs = buildUniqueLogs(logs).slice(0, 500);
  const columns = await getTableColumns(TABLES.notificationLogs);
  if (columns.has("data")) {
    await writeJsonTable(TABLES.notificationLogs, safeLogs);
    return;
  }
  if (!columns.has("id")) {
    await writeJsonTable(TABLES.notificationLogs, safeLogs);
    return;
  }
  const hasEnterpriseId = columns.has("enterprise_id");
  await pool.query(`DELETE FROM ${TABLES.notificationLogs}`);
  for (const log of safeLogs) {
    if (hasEnterpriseId) {
      await pool.query(`INSERT INTO ${TABLES.notificationLogs}
          (id, source, status, channel, element, message, created_at, enterprise_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [String(log?.id || `notif-log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`), String(log?.source || ""), String(log?.status || ""), String(log?.channel || ""), String(log?.element || ""), String(log?.message || ""), normalizeTimestampForSql(log?.createdAt), String(log?.enterpriseId || "")]);
    } else {
      await pool.query(`INSERT INTO ${TABLES.notificationLogs}
          (id, source, status, channel, element, message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [String(log?.id || `notif-log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`), String(log?.source || ""), String(log?.status || ""), String(log?.channel || ""), String(log?.element || ""), String(log?.message || ""), normalizeTimestampForSql(log?.createdAt)]);
    }
  }
}
export async function loadTicketAutomationRawConfig() {
  const [commentTemplates, macros, emailInboxes, exclusionRules, autoReplyRules, autoReplyTemplateValue, scheduledAlertRules, mailCollectors, mailCollectSettings, notificationEvents, notificationWebhooks, notificationTemplates, notificationLogs] = await Promise.all([readJsonTable(TABLES.commentTemplates, []), readJsonTable(TABLES.macros, []), readJsonTable(TABLES.emailInboxes, []), readJsonTable(TABLES.exclusionRules, []), readJsonTable(TABLES.autoReplyRules, []), readJsonTable(TABLES.autoReplyTemplate, ""), readJsonTable(TABLES.scheduledAlertRules, []), readJsonTable(TABLES.mailCollectors, []), readJsonTable(TABLES.mailCollectSettings, {}), readJsonTable(TABLES.notificationEvents, {}), readJsonTable(TABLES.notificationWebhooks, []), readJsonTable(TABLES.notificationTemplates, []), readNotificationLogsRows([])]);
  const eventConfig = notificationEvents && typeof notificationEvents === "object" && !Array.isArray(notificationEvents) ? notificationEvents : {};
  return {
    commentTemplates,
    macros,
    emailInboxes,
    exclusionRules,
    autoReplyRules,
    autoReplyTemplate: String(autoReplyTemplateValue || ""),
    scheduledAlertRules,
    mailCollectors,
    mailCollectSettings,
    notificationSettings: {
      ...eventConfig,
      webhooks: notificationWebhooks,
      templates: notificationTemplates,
      logs: notificationLogs
    }
  };
}
export async function saveTicketAutomationRawConfig(config = {}) {
  const settings = config?.notificationSettings && typeof config.notificationSettings === "object" ? config.notificationSettings : {};
  const {
    webhooks = [],
    templates = [],
    logs = [],
    ...eventConfig
  } = settings;
  await Promise.all([writeJsonTable(TABLES.commentTemplates, Array.isArray(config?.commentTemplates) ? config.commentTemplates : []), writeJsonTable(TABLES.macros, Array.isArray(config?.macros) ? config.macros : []), writeJsonTable(TABLES.emailInboxes, Array.isArray(config?.emailInboxes) ? config.emailInboxes : []), writeJsonTable(TABLES.exclusionRules, Array.isArray(config?.exclusionRules) ? config.exclusionRules : []), writeJsonTable(TABLES.autoReplyRules, Array.isArray(config?.autoReplyRules) ? config.autoReplyRules : []), writeJsonTable(TABLES.autoReplyTemplate, String(config?.autoReplyTemplate || "")), writeJsonTable(TABLES.scheduledAlertRules, Array.isArray(config?.scheduledAlertRules) ? config.scheduledAlertRules : []), writeJsonTable(TABLES.mailCollectors, Array.isArray(config?.mailCollectors) ? config.mailCollectors : []), writeJsonTable(TABLES.mailCollectSettings, config?.mailCollectSettings && typeof config.mailCollectSettings === "object" && !Array.isArray(config.mailCollectSettings) ? config.mailCollectSettings : {})]);
  const optionalSaveResults = await Promise.allSettled([writeJsonTable(TABLES.notificationEvents, eventConfig && typeof eventConfig === "object" ? eventConfig : {}), writeJsonTable(TABLES.notificationWebhooks, Array.isArray(webhooks) ? webhooks : []), writeJsonTable(TABLES.notificationTemplates, Array.isArray(templates) ? templates : []), writeNotificationLogsRows(Array.isArray(logs) ? logs : [])]);
  for (const result of optionalSaveResults) {
    if (result.status === "rejected") {
      console.warn("[ticketAutomationConfigStore] Optional config save skipped:", result.reason?.message || result.reason);
    }
  }
}
export async function loadExclusionRulesRaw() {
  return readJsonTable(TABLES.exclusionRules, []);
}
export async function loadMailCollectorsRaw() {
  return readJsonTable(TABLES.mailCollectors, []);
}
export async function saveMailCollectorsRaw(collectors = []) {
  await writeJsonTable(TABLES.mailCollectors, Array.isArray(collectors) ? collectors : []);
}
export async function loadMailCollectSettingsRaw() {
  return readJsonTable(TABLES.mailCollectSettings, {});
}
export async function saveMailCollectSettingsRaw(settings = {}) {
  await writeJsonTable(TABLES.mailCollectSettings, settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {});
}
export async function loadNotificationSettingsRaw() {
  const [eventConfig, webhooks, templates, logs] = await Promise.all([readJsonTable(TABLES.notificationEvents, {}), readJsonTable(TABLES.notificationWebhooks, []), readJsonTable(TABLES.notificationTemplates, []), readNotificationLogsRows([])]);
  return {
    ...(eventConfig && typeof eventConfig === "object" && !Array.isArray(eventConfig) ? eventConfig : {}),
    webhooks,
    templates,
    logs
  };
}
export async function saveNotificationLogsRaw(logs = []) {
  await writeNotificationLogsRows(Array.isArray(logs) ? logs : []);
}
