import { ImapFlow } from "imapflow";
import { pool } from "../database/db.js";
import { isPro } from "../utils/edition.js";
import {
  loadExclusionRulesRaw,
  loadMailCollectorsRaw,
  loadMailCollectSettingsRaw,
  saveMailCollectorsRaw,
} from "./ticketAutomationConfigStore.js";
import { normalizeMailCollectSettings } from "./mailCollectSettings.js";
import {
  enrichMailContextWithThreadHeaders,
  isInboundEmailAlreadyProcessed,
  recordTicketEmailMessage,
  resolveTicketFromEmailContext,
} from "./ticketEmailThread.js";
import { ensureTicketEmailThreadSchema } from "./ensureTicketEmailThreadSchema.js";
import { ensureMailCollectSettingsSchema } from "./ensureMailCollectSettingsSchema.js";
import {
  buildMailContextFromEnvelope,
  findMatchingExclusionRule,
  getAllMatchingExclusionRules,
  normalizeExclusionRule,
  normalizeIngestionAction,
} from "./mailIngestionRules.js";

export {
  findMatchingExclusionRule,
  getAllMatchingExclusionRules,
  normalizeExclusionRule,
} from "./mailIngestionRules.js";

function normalizeCollectorStats(stats) {
  return {
    collected: Math.max(0, Number(stats?.collected) || 0),
    validated: Math.max(0, Number(stats?.validated) || 0),
    ignored: Math.max(0, Number(stats?.ignored) || 0),
  };
}

export function normalizeMailCollector(row, idx = 0) {
  return {
    id: row?.id || `collector-${Date.now()}-${idx}`,
    name: String(row?.name || "").trim(),
    enabled: row?.enabled !== false,
    server: String(row?.server || "").trim(),
    protocol: String(row?.protocol || "imap").trim() || "imap",
    security: String(row?.security || "ssl").trim() || "ssl",
    validateCertMode: String(row?.validateCertMode || "no-validate-cert").trim() || "no-validate-cert",
    inboxFolder: String(row?.inboxFolder || "INBOX").trim() || "INBOX",
    port: String(row?.port || "").trim(),
    username: String(row?.username || "").trim(),
    password: String(row?.password || "").trim(),
    acceptedFolder: String(row?.acceptedFolder || "").trim(),
    refusedFolder: String(row?.refusedFolder || "").trim(),
    maxImportSizeMb: Number.isFinite(Number(row?.maxImportSizeMb)) ? Number(row.maxImportSizeMb) : 30,
    useMailDate: row?.useMailDate !== false,
    useReplyToAsRequester: Boolean(row?.useReplyToAsRequester),
    addCcAsFollowers: Boolean(row?.addCcAsFollowers),
    unreadOnly: row?.unreadOnly !== false,
    comments: String(row?.comments || "").trim(),
    checkIntervalMinutes: Number.isFinite(Number(row?.checkIntervalMinutes))
      ? Number(row.checkIntervalMinutes)
      : 5,
    ingestEnabled: row?.ingestEnabled !== false,
    logs: Array.isArray(row?.logs)
      ? row.logs.map((log, logIdx) => ({
          id: String(log?.id || `collector-log-${Date.now()}-${idx}-${logIdx}`),
          level: String(log?.level || "info"),
          message: String(log?.message || ""),
          createdAt: String(log?.createdAt || new Date().toISOString()),
        }))
      : [],
    lastCheckedAt: String(row?.lastCheckedAt || "").trim(),
    stats: normalizeCollectorStats(row?.stats),
  };
}

export function buildImapClientConfig(collector = {}) {
  const security = String(collector?.security || "ssl").toLowerCase();
  const validateCertMode = String(collector?.validateCertMode || "no-validate-cert").toLowerCase();
  const parsedPort = Number(collector?.port);
  const hasCustomPort = Number.isFinite(parsedPort) && parsedPort > 0;
  const secure = security === "ssl";
  return {
    host: String(collector?.server || "").trim(),
    port: hasCustomPort ? parsedPort : secure ? 993 : 143,
    secure,
    auth: {
      user: String(collector?.username || "").trim(),
      pass: String(collector?.password || ""),
    },
    tls: {
      rejectUnauthorized: validateCertMode !== "no-validate-cert",
    },
    logger: false,
  };
}

export async function withImapClient(collector, callback) {
  const config = buildImapClientConfig(collector);
  if (!config.host) throw new Error("Serveur IMAP requis");
  if (!config.auth.user) throw new Error("Adresse email requise");
  if (!config.auth.pass) throw new Error("Mot de passe requis");
  const client = new ImapFlow(config);
  try {
    await client.connect();
    return await callback(client);
  } finally {
    if (client && !client.closed) {
      await client.logout().catch(() => {});
    }
  }
}

function stripReplyPrefix(subject = "") {
  return String(subject || "")
    .replace(/^((re|fw|fwd)\s*:\s*)+/i, "")
    .trim();
}

export function extractTicketNumberFromSubject(subject = "") {
  const normalized = stripReplyPrefix(subject);
  const hashMatch = normalized.match(/#\s*(\d{1,12})/);
  if (hashMatch) return Number(hashMatch[1]);
  const ticketMatch = normalized.match(/ticket\s*(?:n[°o]\s*)?(\d{1,12})/i);
  if (ticketMatch) return Number(ticketMatch[1]);
  return null;
}

export function extractBodyFromRfc822(sourceValue) {
  const raw = Buffer.isBuffer(sourceValue) ? sourceValue.toString("utf8") : String(sourceValue || "");
  const normalizedRaw = raw.replace(/\r/g, "");

  const decodeQuotedPrintable = (value) =>
    String(value || "")
      .replace(/=\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));

  const decodePartBody = (partHeaders, partBody) => {
    const headers = String(partHeaders || "").toLowerCase();
    const bodyValue = String(partBody || "");
    if (/content-transfer-encoding:\s*base64/i.test(headers)) {
      const cleaned = bodyValue.replace(/[^A-Za-z0-9+/=]/g, "");
      try {
        return Buffer.from(cleaned, "base64").toString("utf8");
      } catch (_error) {
        return bodyValue;
      }
    }
    if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
      return decodeQuotedPrintable(bodyValue);
    }
    return bodyValue;
  };

  const htmlToText = (html) =>
    String(html || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<\/(p|div|li|br|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

  const mimeParts = normalizedRaw.split(/\n--[^\n]+/g);
  const readMimePart = (typeRegex) => {
    for (const part of mimeParts) {
      if (!typeRegex.test(part)) continue;
      const idx = part.indexOf("\n\n");
      if (idx < 0) continue;
      const headers = part.slice(0, idx);
      const body = part.slice(idx + 2);
      return decodePartBody(headers, body);
    }
    return "";
  };

  const plainPart = readMimePart(/content-type:\s*text\/plain/i);
  if (plainPart) return plainPart.trim().slice(0, 10000);

  const htmlPart = readMimePart(/content-type:\s*text\/html/i);
  if (htmlPart) return htmlToText(htmlPart).slice(0, 10000);

  const sections = normalizedRaw.split(/\n\n/);
  const fallbackBody = sections.length > 1 ? sections.slice(1).join("\n\n") : normalizedRaw;
  return fallbackBody.trim().slice(0, 10000);
}

async function resolveRequesterUserIdByEmail(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;
  const result = await pool.query(
    `SELECT id
     FROM v_b_users
     WHERE LOWER(email) = $1
     LIMIT 1`,
    [normalizedEmail]
  );
  return result.rows?.[0]?.id || null;
}

async function createTicketFromCollectorEmail({
  subject,
  body,
  fromName,
  fromAddress,
  ticketKind = "support",
}) {
  const safeSubject = String(subject || "").trim();
  const normalizedTitle = stripReplyPrefix(safeSubject) || safeSubject || "Nouveau ticket depuis email";
  const senderLabel = [String(fromName || "").trim(), String(fromAddress || "").trim()].filter(Boolean).join(" ");
  const ticketDescription = `[Email entrant] ${senderLabel || "Expéditeur inconnu"}\nObjet: ${safeSubject || "(sans objet)"}\n\n${
    String(body || "").trim() || "(message vide)"
  }`;
  const requesterUserId = await resolveRequesterUserIdByEmail(fromAddress);
  const isServices = ticketKind === "services";
  const type = isServices ? "demande" : "incident";
  const category = isServices ? "prestation-intervention-distante" : null;

  const result = category
    ? await pool.query(
        `INSERT INTO v_b_tickets
          (title, description, status, priority, type, category, channel, requester_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
         RETURNING id, ticket_number`,
        [
          normalizedTitle.slice(0, 255),
          ticketDescription,
          "open",
          "normal",
          type,
          category,
          "email",
          requesterUserId,
        ]
      )
    : await pool.query(
        `INSERT INTO v_b_tickets
          (title, description, status, priority, type, channel, requester_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         RETURNING id, ticket_number`,
        [normalizedTitle.slice(0, 255), ticketDescription, "open", "normal", type, "email", requesterUserId]
      );
  return result.rows?.[0] || null;
}

async function attachEmailToTicket({
  ticketId,
  subject,
  body,
  fromName,
  fromAddress,
  ticketNumber,
}) {
  const content = `[Email entrant] ${fromName || fromAddress || "Expéditeur inconnu"}\nObjet: ${subject}\n\n${body || "(message vide)"}`;
  await pool.query(
    `INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [ticketId, null, content, false]
  );
  await pool.query(`UPDATE v_b_tickets SET updated_at = NOW() WHERE id = $1`, [ticketId]);
  return ticketNumber;
}

async function archiveMatchedMail(collector, matchingRule, client, messageUid) {
  if (collector.acceptedFolder && matchingRule.archiveOnMatch !== false) {
    await client.messageMove(messageUid, collector.acceptedFolder).catch(() => {});
  }
}

async function moveMailToRefused(collector, client, messageUid) {
  if (collector.refusedFolder) {
    await client.messageMove(messageUid, collector.refusedFolder).catch(() => {});
  }
}

async function attachInboundMailToTicket({
  ticketRow,
  collector,
  matchingRule,
  client,
  message,
  mailContext,
  stats,
  actionLabel,
  subjectPreview,
  logDetail = "",
}) {
  const subject = mailContext.subject;
  const { body, fromName, fromAddress } = mailContext;

  await attachEmailToTicket({
    ticketId: ticketRow.id,
    subject,
    body,
    fromName,
    fromAddress,
    ticketNumber: ticketRow.ticket_number,
  });
  await recordTicketEmailMessage({
    ticketId: ticketRow.id,
    collectorId: collector.id,
    mailContext,
    direction: "inbound",
  });
  stats.attached += 1;
  await archiveMatchedMail(collector, matchingRule, client, message.uid);
  const detail = logDetail ? ` ${logDetail}` : "";
  await appendCollectorLogInConfig(
    collector.id,
    "success",
    `Mail rattaché au ticket #${ticketRow.ticket_number} via règle "${actionLabel}"${detail} ("${subjectPreview}").`
  ).catch(() => {});
}

async function createInboundTicketAndRecord({
  collector,
  matchingRule,
  client,
  message,
  mailContext,
  stats,
  actionLabel,
  subjectPreview,
  ticketKind,
  successLogLabel,
}) {
  const { subject, body, fromName, fromAddress } = mailContext;
  const created = await createTicketFromCollectorEmail({
    subject,
    body,
    fromName,
    fromAddress,
    ticketKind,
  });

  if (!created?.id) {
    stats.ignored += 1;
    await moveMailToRefused(collector, client, message.uid);
    await appendCollectorLogInConfig(
      collector.id,
      "warning",
      `Échec création ${successLogLabel} pour "${subjectPreview}".`
    ).catch(() => {});
    return null;
  }

  await recordTicketEmailMessage({
    ticketId: created.id,
    collectorId: collector.id,
    mailContext,
    direction: "inbound",
  });
  stats.attached += 1;
  await archiveMatchedMail(collector, matchingRule, client, message.uid);
  await appendCollectorLogInConfig(
    collector.id,
    "success",
    `${successLogLabel} #${created.ticket_number || "?"} via règle "${actionLabel}" ("${subjectPreview}").`
  ).catch(() => {});
  return created;
}

async function handleThreadedTicketMail({
  collector,
  matchingRule,
  client,
  message,
  mailContext,
  stats,
  actionLabel,
  subjectPreview,
  ticketKind,
  successLogLabel,
  mailCollectSettings,
}) {
  const threadLookupEnabled = mailCollectSettings?.threadRepliesEnabled !== false;
  const existingTicket = await resolveTicketFromEmailContext(mailContext, {
    extractTicketNumberFromSubject,
    threadLookupEnabled,
  });

  if (existingTicket?.id) {
    const threadDetail =
      mailContext.isReply === "yes" ? "(fil de discussion)" : "(référence ticket)";
    await attachInboundMailToTicket({
      ticketRow: existingTicket,
      collector,
      matchingRule,
      client,
      message,
      mailContext,
      stats,
      actionLabel,
      subjectPreview,
      logDetail: threadDetail,
    });
    return;
  }

  if (mailContext.isReply === "yes" && threadLookupEnabled) {
    stats.ignored += 1;
    if (mailCollectSettings?.orphanReplyBehavior === "refuse") {
      await moveMailToRefused(collector, client, message.uid);
      await appendCollectorLogInConfig(
        collector.id,
        "warning",
        `Réponse refusée : aucun ticket lié au fil de discussion ("${subjectPreview}").`
      ).catch(() => {});
    } else {
      await appendCollectorLogInConfig(
        collector.id,
        "info",
        `Réponse ignorée : aucun ticket lié au fil de discussion ("${subjectPreview}").`
      ).catch(() => {});
    }
    return;
  }

  await createInboundTicketAndRecord({
    collector,
    matchingRule,
    client,
    message,
    mailContext,
    stats,
    actionLabel,
    subjectPreview,
    ticketKind,
    successLogLabel,
  });
}

async function processMatchedMail({
  collector,
  matchingRule,
  client,
  message,
  mailContext,
  stats,
  mailCollectSettings,
}) {
  const subjectPreview = mailContext?.subject || "(sans objet)";
  const actionLabel = String(matchingRule.name || matchingRule.id || "Règle");
  const action = normalizeIngestionAction(matchingRule.action);
  const threadLookupEnabled = mailCollectSettings?.threadRepliesEnabled !== false;

  if (action === "ignore_mail") {
    stats.ignored += 1;
    await archiveMatchedMail(collector, matchingRule, client, message.uid);
    await appendCollectorLogInConfig(
      collector.id,
      "info",
      `Mail ignoré via règle "${actionLabel}" (objet "${subjectPreview}").`
    ).catch(() => {});
    return;
  }

  if (action === "create_ticket_services" && !isPro()) {
    stats.ignored += 1;
    await moveMailToRefused(collector, client, message.uid);
    await appendCollectorLogInConfig(
      collector.id,
      "warning",
      `Action prestations/services réservée à Veritas Pro — mail ignoré ("${subjectPreview}").`
    ).catch(() => {});
    return;
  }

  if (action === "attach_comment") {
    const ticketRow = await resolveTicketFromEmailContext(mailContext, {
      extractTicketNumberFromSubject,
      threadLookupEnabled,
    });
    if (!ticketRow?.id) {
      stats.ignored += 1;
      await moveMailToRefused(collector, client, message.uid);
      await appendCollectorLogInConfig(
        collector.id,
        "warning",
        `Rattachement impossible : ticket introuvable pour ce fil ("${subjectPreview}").`
      ).catch(() => {});
      return;
    }

    await attachInboundMailToTicket({
      ticketRow,
      collector,
      matchingRule,
      client,
      message,
      mailContext,
      stats,
      actionLabel,
      subjectPreview,
    });
    return;
  }

  if (action === "create_ticket_services") {
    await handleThreadedTicketMail({
      collector,
      matchingRule,
      client,
      message,
      mailContext,
      stats,
      actionLabel,
      subjectPreview,
      ticketKind: "services",
      successLogLabel: "Ticket prestations",
      mailCollectSettings,
    });
    return;
  }

  if (action === "create_ticket_support") {
    await handleThreadedTicketMail({
      collector,
      matchingRule,
      client,
      message,
      mailContext,
      stats,
      actionLabel,
      subjectPreview,
      ticketKind: "support",
      successLogLabel: "Nouveau ticket support",
      mailCollectSettings,
    });
    return;
  }
}

export function filterExclusionRulesForCollector(rules = [], collectorId = "") {
  const normalizedCollectorId = String(collectorId || "").trim();
  return (Array.isArray(rules) ? rules : []).filter((rule) => {
    const ruleCollectorId = String(rule?.collectorId || "").trim();
    if (!ruleCollectorId) return true;
    return ruleCollectorId === normalizedCollectorId;
  });
}

export async function appendCollectorLogInConfig(collectorId, level, message) {
  if (!collectorId) return;
  const [existingCollectors, rawSettings] = await Promise.all([
    loadMailCollectorsRaw(),
    loadMailCollectSettingsRaw(),
  ]);
  const mailCollectSettings = normalizeMailCollectSettings(rawSettings);
  const maxLogs = mailCollectSettings.maxLogEntriesPerCollector;
  const nextCollectors = existingCollectors.map((collector, idx) => {
    const normalized = normalizeMailCollector(collector, idx);
    if (String(normalized.id) !== String(collectorId)) return normalized;
    const nextLog = {
      id: `collector-log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      level: String(level || "info"),
      message: String(message || ""),
      createdAt: new Date().toISOString(),
    };
    return {
      ...normalized,
      logs: [nextLog, ...(Array.isArray(normalized.logs) ? normalized.logs : [])].slice(0, maxLogs),
      lastCheckedAt: new Date().toISOString(),
    };
  });
  await saveMailCollectorsRaw(nextCollectors);
}

export async function incrementCollectorStats(
  collectorId,
  { inspected = 0, attached = 0, ignored = 0 } = {}
) {
  if (!collectorId || (inspected === 0 && attached === 0 && ignored === 0)) return;
  const existingCollectors = await loadMailCollectorsRaw();
  const nextCollectors = existingCollectors.map((collector, idx) => {
    const normalized = normalizeMailCollector(collector, idx);
    if (String(normalized.id) !== String(collectorId)) return normalized;
    const prev = normalizeCollectorStats(normalized.stats);
    return {
      ...normalized,
      stats: {
        collected: prev.collected + inspected,
        validated: prev.validated + attached,
        ignored: prev.ignored + ignored,
      },
    };
  });
  await saveMailCollectorsRaw(nextCollectors);
}

async function processMessagesInMailbox(client, collector, exclusionRules, mailCollectSettings) {
  const inboxFolder = String(collector?.inboxFolder || "INBOX").trim() || "INBOX";
  const stats = { inspected: 0, attached: 0, ignored: 0 };
  const fetchQuery = collector.unreadOnly ? { seen: false } : { all: true };

  const lock = await client.getMailboxLock(inboxFolder);
  try {
    const fetched = [];
    for await (const message of client.fetch(fetchQuery, { uid: true, envelope: true, source: true })) {
      fetched.push(message);
    }

    for (const message of fetched) {
      let mailContext = buildMailContextFromEnvelope(message);
      mailContext.body = extractBodyFromRfc822(message?.source);
      mailContext = enrichMailContextWithThreadHeaders(mailContext, message?.source, message?.envelope);

      if (
        mailCollectSettings.deduplicateByMessageId !== false &&
        mailContext.messageId &&
        (await isInboundEmailAlreadyProcessed(mailContext.messageId))
      ) {
        continue;
      }

      const matchingRule = findMatchingExclusionRule(exclusionRules, mailContext);

      if (!matchingRule) {
        continue;
      }

      stats.inspected += 1;
      await processMatchedMail({
        collector,
        matchingRule,
        client,
        message,
        mailContext,
        stats,
        mailCollectSettings,
      });
    }
  } finally {
    lock.release();
  }

  return stats;
}

export async function processMailCollector(collectorInput, { force = false } = {}) {
  await Promise.all([
    ensureTicketEmailThreadSchema().catch(() => {}),
    ensureMailCollectSettingsSchema().catch(() => {}),
  ]);

  const collector = normalizeMailCollector(collectorInput, 0);
  if (!collector.id || !collector.enabled || !collector.ingestEnabled) {
    return { skipped: true, reason: "disabled", inspected: 0, attached: 0, ignored: 0 };
  }
  if (String(collector.protocol || "imap").toLowerCase() !== "imap") {
    return { skipped: true, reason: "unsupported_protocol", inspected: 0, attached: 0, ignored: 0 };
  }
  if (!collector.server || !collector.username || !collector.password) {
    return { skipped: true, reason: "incomplete_config", inspected: 0, attached: 0, ignored: 0 };
  }

  if (!force) {
    const now = Date.now();
    const lastCheckedAtMs = collector.lastCheckedAt ? new Date(collector.lastCheckedAt).getTime() : 0;
    const intervalMs = Math.max(1, Number(collector.checkIntervalMinutes || 5)) * 60 * 1000;
    if (lastCheckedAtMs && now - lastCheckedAtMs < intervalMs) {
      return { skipped: true, reason: "interval", inspected: 0, attached: 0, ignored: 0 };
    }
  }

  const rawRules = await loadExclusionRulesRaw();
  const exclusionRules = filterExclusionRulesForCollector(
    (Array.isArray(rawRules) ? rawRules : []).map(normalizeExclusionRule),
    collector.id
  );
  const mailCollectSettings = normalizeMailCollectSettings(await loadMailCollectSettingsRaw());

  const stats = await withImapClient(collector, async (client) =>
    processMessagesInMailbox(client, collector, exclusionRules, mailCollectSettings)
  );

  await incrementCollectorStats(collector.id, stats).catch(() => {});

  await appendCollectorLogInConfig(
    collector.id,
    "info",
    `Vérification effectuée (${stats.inspected} mail(s) inspecté(s), ${stats.attached} rattaché(s), ${stats.ignored} ignoré(s)).`
  ).catch(() => {});

  return { ...stats, skipped: false };
}
