import crypto from "crypto";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { pool } from "../database/db.js";
import { getSettingsMap } from "../utils/settingsHelper.js";
import { dispatchNotificationEvent } from "./notificationDispatcher.js";
const SETTINGS_KEYS = ["INTEGRATION_WHATSAPP_ENABLED", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_API_VERSION"];
const DEFAULT_API_VERSION = "v21.0";
const MAX_WHATSAPP_TEXT_LENGTH = 4096;
const MAX_WHATSAPP_CAPTION_LENGTH = 1024;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const TICKET_UPLOAD_DIR = path.resolve(process.cwd(), "uploads", "tickets");
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx", ".csv", ".xls", ".xlsx", ".mp4", ".3gp", ".mp3", ".mpeg", ".ogg", ".aac", ".amr", ".m4a"]);
const MIME_EXTENSION_MAP = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "text/csv": ".csv",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/amr": ".amr",
  "audio/ogg": ".ogg",
  "audio/ogg; codecs=opus": ".ogg"
};
const VIDEO_EXTENSIONS = new Set([".mp4", ".3gp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".mpeg", ".ogg", ".aac", ".amr", ".m4a"]);
fs.mkdirSync(TICKET_UPLOAD_DIR, {
  recursive: true
});
export function normalizeWaPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}
export function stripHtmlToText(value) {
  return String(value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function extensionFromMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase().split(";")[0].trim();
  return MIME_EXTENSION_MAP[mime] || "";
}
function sanitizeDiskFilename(name, mimeType) {
  const base = String(name || "whatsapp-file").replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const ext = path.extname(base).toLowerCase();
  if (ext && ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) return base;
  const inferred = extensionFromMime(mimeType);
  if (inferred) return `${base.replace(/\.+$/, "")}${inferred}`;
  return base;
}
function isImageMime(mimeType) {
  return String(mimeType || "").toLowerCase().startsWith("image/");
}
function isVideoMime(mimeType) {
  return String(mimeType || "").toLowerCase().startsWith("video/");
}
function isAudioMime(mimeType) {
  return String(mimeType || "").toLowerCase().startsWith("audio/");
}
function inboundMediaFallbackLabel(mediaType) {
  if (mediaType === "audio") return "(Audio WhatsApp)";
  if (mediaType === "video") return "(WhatsApp video)";
  return "(WhatsApp file)";
}
function resolveOutboundMediaKind(mimeType, filename) {
  const mime = String(mimeType || "").toLowerCase().split(";")[0].trim();
  if (isImageMime(mime)) return "image";
  if (isVideoMime(mime)) return "video";
  if (isAudioMime(mime)) return "audio";
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "document";
}
function resolveTicketAttachmentAbsolutePath(filePath) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return null;
  const relative = normalized.replace(/^\/+/, "");
  return path.resolve(process.cwd(), relative);
}
export async function getWhatsAppConfig() {
  const settings = await getSettingsMap(SETTINGS_KEYS);
  const enabledFlag = String(settings.INTEGRATION_WHATSAPP_ENABLED ?? "").toLowerCase();
  const hasCredentials = Boolean(settings.WHATSAPP_ACCESS_TOKEN) && Boolean(settings.WHATSAPP_PHONE_NUMBER_ID);
  const enabled = enabledFlag === "true" || enabledFlag !== "false" && hasCredentials;
  return {
    enabled,
    phoneNumberId: settings.WHATSAPP_PHONE_NUMBER_ID || "",
    accessToken: settings.WHATSAPP_ACCESS_TOKEN || "",
    appSecret: settings.WHATSAPP_APP_SECRET || "",
    verifyToken: settings.WHATSAPP_VERIFY_TOKEN || "",
    businessAccountId: settings.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
    apiVersion: (settings.WHATSAPP_API_VERSION || DEFAULT_API_VERSION).replace(/^\/+|\/+$/g, "")
  };
}
export function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return true;
  if (!signatureHeader || !rawBody) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const received = String(signatureHeader).replace(/^sha256=/i, "");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    return false;
  }
}
async function isMessageAlreadyProcessed(waMessageId) {
  if (!waMessageId) return false;
  const result = await pool.query("SELECT 1 FROM v_b_whatsapp_processed_messages WHERE wa_message_id = $1 LIMIT 1", [waMessageId]);
  return result.rows.length > 0;
}
async function markMessageProcessed(waMessageId) {
  if (!waMessageId) return;
  await pool.query(`INSERT INTO v_b_whatsapp_processed_messages (wa_message_id, processed_at)
     VALUES ($1, NOW())
     ON CONFLICT (wa_message_id) DO NOTHING`, [waMessageId]);
}
async function resolveContactByPhone(waPhone) {
  const normalized = normalizeWaPhone(waPhone);
  if (!normalized) return null;
  const suffix = normalized.length > 9 ? normalized.slice(-9) : normalized;
  const result = await pool.query(`SELECT id, client_id, nom, prenom, telephone
     FROM v_b_contacts
     WHERE telephone IS NOT NULL
       AND regexp_replace(telephone, '\\D', '', 'g') LIKE '%' || $1
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`, [suffix]);
  return result.rows[0] || null;
}
async function findOpenTicketForPhone(waPhone) {
  const result = await pool.query(`SELECT w.ticket_id, t.ticket_number, t.status
     FROM v_b_whatsapp_conversations w
     JOIN v_b_tickets t ON t.id = w.ticket_id
     WHERE w.wa_phone = $1
       AND t.status NOT IN ('closed', 'resolved')
       AND COALESCE(t.is_deleted, FALSE) = FALSE
     ORDER BY w.last_message_at DESC
     LIMIT 1`, [waPhone]);
  return result.rows[0] || null;
}
async function linkConversation({
  waPhone,
  ticketId,
  contactName
}) {
  await pool.query(`INSERT INTO v_b_whatsapp_conversations (wa_phone, ticket_id, wa_contact_name, last_message_at, created_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (ticket_id)
     DO UPDATE SET
       wa_phone = EXCLUDED.wa_phone,
       wa_contact_name = COALESCE(EXCLUDED.wa_contact_name, v_b_whatsapp_conversations.wa_contact_name),
       last_message_at = NOW()`, [waPhone, ticketId, contactName || null]);
}
async function touchConversation(ticketId) {
  await pool.query(`UPDATE v_b_whatsapp_conversations SET last_message_at = NOW() WHERE ticket_id = $1`, [ticketId]);
}
function buildInboundComment({
  contactName,
  waPhone,
  text
}) {
  const label = [contactName, waPhone].filter(Boolean).join(" — ") || waPhone || "Client WhatsApp";
  return `[WhatsApp] ${label}\n\n${String(text || "").trim() || "(empty message)"}`;
}
async function insertTicketAttachment({
  ticketId,
  commentId,
  fileName,
  relativePath,
  mimeType,
  fileSize
}) {
  await pool.query(`INSERT INTO v_b_ticket_attachments
      (ticket_id, comment_id, uploaded_by, file_name, file_path, mime_type, file_size, created_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, NOW())`, [ticketId, commentId || null, fileName, relativePath, mimeType || null, fileSize || 0]);
}
async function saveBufferAsTicketAttachment({
  ticketId,
  commentId,
  buffer,
  mimeType,
  fileName
}) {
  if (!buffer || buffer.length === 0) {
    throw new Error("WhatsApp file is empty.");
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error("WhatsApp file is too large (maximum 15 MB).");
  }
  const safeName = sanitizeDiskFilename(fileName, mimeType);
  const ext = path.extname(safeName).toLowerCase();
  if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported WhatsApp file type (${mimeType || ext || "unknown"}).`);
  }
  const diskName = `${Date.now()}-wa-${safeName}`;
  const absolutePath = path.join(TICKET_UPLOAD_DIR, diskName);
  fs.writeFileSync(absolutePath, buffer);
  const relativePath = `/uploads/tickets/${diskName}`;
  await insertTicketAttachment({
    ticketId,
    commentId,
    fileName: safeName,
    relativePath,
    mimeType,
    fileSize: buffer.length
  });
  return {
    fileName: safeName,
    relativePath,
    mimeType,
    fileSize: buffer.length
  };
}
async function createTicketFromWhatsApp({
  waPhone,
  contactName,
  text,
  contact,
  withComment = false
}) {
  const displayName = contactName || [contact?.prenom, contact?.nom].filter(Boolean).join(" ").trim();
  const titleSource = String(text || "").trim();
  const title = (titleSource.split(/\n/)[0] || `Message WhatsApp de ${displayName || waPhone}`).slice(0, 255);
  const description = buildInboundComment({
    contactName: displayName,
    waPhone,
    text
  });
  const result = await pool.query(`INSERT INTO v_b_tickets
      (title, description, status, priority, type, channel, client_id, requester_contact_id, created_at, updated_at)
     VALUES ($1, $2, 'open', 'normal', 'incident', 'whatsapp', $3, $4, NOW(), NOW())
     RETURNING id, ticket_number, client_id`, [title, description, contact?.client_id || null, contact?.id || null]);
  const ticket = result.rows[0];
  if (!ticket?.id) return null;
  await linkConversation({
    waPhone,
    ticketId: ticket.id,
    contactName: displayName
  });
  let commentId = null;
  if (withComment) {
    const comment = await addWhatsAppCommentToTicket({
      ticketId: ticket.id,
      waPhone,
      contactName: displayName,
      text
    });
    commentId = comment?.id || null;
  }
  await dispatchNotificationEvent({
    source: "tickets",
    element: "created",
    enterpriseId: String(ticket.client_id || ""),
    context: {
      ticket: {
        id: ticket.id,
        ticket_number: ticket.ticket_number
      },
      entreprise: {
        id: String(ticket.client_id || "")
      }
    }
  }).catch(() => {});
  return {
    ...ticket,
    commentId
  };
}
async function addWhatsAppCommentToTicket({
  ticketId,
  waPhone,
  contactName,
  text
}) {
  const content = buildInboundComment({
    contactName,
    waPhone,
    text
  });
  const result = await pool.query(`INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
     VALUES ($1, NULL, $2, FALSE, NOW())
     RETURNING id`, [ticketId, content]);
  await pool.query("UPDATE v_b_tickets SET updated_at = NOW() WHERE id = $1", [ticketId]);
  await touchConversation(ticketId);
  const ticketRow = await pool.query("SELECT client_id FROM v_b_tickets WHERE id = $1", [ticketId]);
  await dispatchNotificationEvent({
    source: "tickets",
    element: "commented",
    enterpriseId: String(ticketRow.rows[0]?.client_id || ""),
    context: {
      ticket: {
        id: ticketId
      },
      comment: {
        id: result.rows[0]?.id
      },
      entreprise: {
        id: String(ticketRow.rows[0]?.client_id || "")
      }
    }
  }).catch(() => {});
  return result.rows[0];
}
function extractMessageText(message) {
  if (!message) return "";
  if (message.type === "text" && message.text?.body) return String(message.text.body);
  if (message.type === "button" && message.button?.text) return String(message.button.text);
  if (message.type === "interactive") {
    const interactive = message.interactive || {};
    if (interactive.button_reply?.title) return String(interactive.button_reply.title);
    if (interactive.list_reply?.title) return String(interactive.list_reply.title);
  }
  if (message.type === "image" && message.image?.caption) return String(message.image.caption);
  if (message.type === "document" && message.document?.caption) return String(message.document.caption);
  if (message.type === "video" && message.video?.caption) return String(message.video.caption);
  return "";
}
export function extractInboundMedia(message) {
  if (!message) return null;
  if (message.type === "image" && message.image?.id) {
    return {
      mediaId: message.image.id,
      mimeType: message.image.mime_type || "image/jpeg",
      type: "image",
      filename: `whatsapp-image-${Date.now()}.jpg`
    };
  }
  if (message.type === "audio" && message.audio?.id) {
    return {
      mediaId: message.audio.id,
      mimeType: message.audio.mime_type || "audio/ogg",
      type: "audio",
      filename: `whatsapp-audio-${Date.now()}.ogg`
    };
  }
  if (message.type === "video" && message.video?.id) {
    return {
      mediaId: message.video.id,
      mimeType: message.video.mime_type || "video/mp4",
      type: "video",
      filename: `whatsapp-video-${Date.now()}.mp4`
    };
  }
  if (message.type === "document" && message.document?.id) {
    return {
      mediaId: message.document.id,
      mimeType: message.document.mime_type || "application/octet-stream",
      type: "document",
      filename: message.document.filename || `whatsapp-document-${Date.now()}`
    };
  }
  return null;
}
async function fetchWhatsAppMediaBuffer(mediaId, config) {
  const metaUrl = `https://graph.facebook.com/${config.apiVersion}/${mediaId}`;
  const metaResponse = await fetch(metaUrl, {
    headers: {
      Authorization: `Bearer ${config.accessToken}`
    }
  });
  const meta = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok) {
    throw new Error(meta?.error?.message || "Unable to retrieve WhatsApp media metadata.");
  }
  const downloadUrl = meta.url;
  if (!downloadUrl) throw new Error("Missing WhatsApp media URL.");
  const downloadResponse = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${config.accessToken}`
    }
  });
  if (!downloadResponse.ok) {
    throw new Error("Failed to download WhatsApp media.");
  }
  const buffer = Buffer.from(await downloadResponse.arrayBuffer());
  const mimeType = meta.mime_type || downloadResponse.headers.get("content-type") || "application/octet-stream";
  return {
    buffer,
    mimeType
  };
}
async function downloadAndAttachWhatsAppMedia({
  ticketId,
  commentId,
  media,
  config
}) {
  const {
    buffer,
    mimeType
  } = await fetchWhatsAppMediaBuffer(media.mediaId, config);
  const fileName = media.filename || sanitizeDiskFilename("whatsapp-file", mimeType);
  return saveBufferAsTicketAttachment({
    ticketId,
    commentId,
    buffer,
    mimeType: mimeType || media.mimeType,
    fileName
  });
}
export async function processInboundWhatsAppMessage({
  waPhone,
  contactName,
  text,
  waMessageId,
  message
}) {
  const config = await getWhatsAppConfig();
  if (!config.enabled) return {
    skipped: true,
    reason: "integration_disabled"
  };
  const normalizedPhone = normalizeWaPhone(waPhone);
  if (!normalizedPhone) return {
    skipped: true,
    reason: "missing_phone"
  };
  if (await isMessageAlreadyProcessed(waMessageId)) {
    return {
      skipped: true,
      reason: "duplicate"
    };
  }
  const media = extractInboundMedia(message);
  const trimmedText = String(text || "").trim();
  const displayText = trimmedText || (media ? inboundMediaFallbackLabel(media.type) : "");
  if (!displayText && !media) {
    await markMessageProcessed(waMessageId);
    return {
      skipped: true,
      reason: "unsupported_message_type"
    };
  }
  const contact = await resolveContactByPhone(normalizedPhone);
  const openTicket = await findOpenTicketForPhone(normalizedPhone);
  let ticketId;
  let ticketNumber;
  let commentId = null;
  let action;
  if (openTicket?.ticket_id) {
    const comment = await addWhatsAppCommentToTicket({
      ticketId: openTicket.ticket_id,
      waPhone: normalizedPhone,
      contactName,
      text: displayText
    });
    ticketId = openTicket.ticket_id;
    ticketNumber = openTicket.ticket_number;
    commentId = comment?.id || null;
    action = "comment";
  } else {
    const created = await createTicketFromWhatsApp({
      waPhone: normalizedPhone,
      contactName,
      text: displayText,
      contact,
      withComment: Boolean(media)
    });
    if (!created?.id) {
      await markMessageProcessed(waMessageId);
      return {
        skipped: true,
        reason: "ticket_creation_failed"
      };
    }
    ticketId = created.id;
    ticketNumber = created.ticket_number;
    commentId = created.commentId || null;
    action = "created";
  }
  if (media && ticketId) {
    await downloadAndAttachWhatsAppMedia({
      ticketId,
      commentId,
      media,
      config
    });
  }
  await markMessageProcessed(waMessageId);
  return {
    action,
    ticketId,
    ticketNumber,
    hasMedia: Boolean(media)
  };
}
export async function handleWhatsAppWebhookPayload(payload) {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const results = [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field !== "messages") continue;
      const value = change?.value || {};
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const contactName = contacts[0]?.profile?.name || "";
      for (const message of messages) {
        if (message?.type === "status") continue;
        const waPhone = normalizeWaPhone(message?.from);
        const text = extractMessageText(message);
        const result = await processInboundWhatsAppMessage({
          waPhone,
          contactName,
          text,
          waMessageId: message?.id,
          message
        });
        results.push(result);
      }
    }
  }
  return results;
}
async function postWhatsAppMessagePayload(config, payload) {
  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || response.statusText || "WhatsApp API error";
    throw new Error(detail);
  }
  return data;
}
export async function sendWhatsAppText({
  to,
  text
}) {
  const config = await getWhatsAppConfig();
  if (!config.enabled) {
    throw new Error("WhatsApp integration is inactive or not configured.");
  }
  const recipient = normalizeWaPhone(to);
  const body = String(text || "").trim();
  if (!recipient) throw new Error("Invalid WhatsApp recipient number.");
  if (!body) throw new Error("WhatsApp message cannot be empty.");
  const truncated = body.length > MAX_WHATSAPP_TEXT_LENGTH ? `${body.slice(0, MAX_WHATSAPP_TEXT_LENGTH - 1)}…` : body;
  return postWhatsAppMessagePayload(config, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "text",
    text: {
      preview_url: false,
      body: truncated
    }
  });
}
async function uploadWhatsAppMedia({
  buffer,
  mimeType,
  filename
}) {
  const config = await getWhatsAppConfig();
  if (!config.enabled) {
    throw new Error("WhatsApp integration is inactive or not configured.");
  }
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType || "application/octet-stream");
  form.append("file", new Blob([buffer], {
    type: mimeType || "application/octet-stream"
  }), filename);
  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/media`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`
    },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || "Failed to upload WhatsApp media.");
  }
  return data.id;
}
async function sendWhatsAppMediaMessage({
  to,
  buffer,
  mimeType,
  filename,
  caption,
  mediaType
}) {
  const config = await getWhatsAppConfig();
  const recipient = normalizeWaPhone(to);
  if (!recipient) throw new Error("Invalid WhatsApp recipient number.");
  const kind = mediaType || resolveOutboundMediaKind(mimeType, filename);
  const mediaId = await uploadWhatsAppMedia({
    buffer,
    mimeType,
    filename
  });
  const trimmedCaption = String(caption || "").trim();
  const safeCaption = trimmedCaption.length > MAX_WHATSAPP_CAPTION_LENGTH ? `${trimmedCaption.slice(0, MAX_WHATSAPP_CAPTION_LENGTH - 1)}…` : trimmedCaption;
  const basePayload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient
  };
  if (kind === "image") {
    return postWhatsAppMessagePayload(config, {
      ...basePayload,
      type: "image",
      image: {
        id: mediaId,
        ...(safeCaption ? {
          caption: safeCaption
        } : {})
      }
    });
  }
  if (kind === "video") {
    return postWhatsAppMessagePayload(config, {
      ...basePayload,
      type: "video",
      video: {
        id: mediaId,
        ...(safeCaption ? {
          caption: safeCaption
        } : {})
      }
    });
  }
  if (kind === "audio") {
    return postWhatsAppMessagePayload(config, {
      ...basePayload,
      type: "audio",
      audio: {
        id: mediaId
      }
    });
  }
  return postWhatsAppMessagePayload(config, {
    ...basePayload,
    type: "document",
    document: {
      id: mediaId,
      ...(safeCaption ? {
        caption: safeCaption
      } : {}),
      filename: filename || "document"
    }
  });
}
export async function getWhatsAppPhoneForTicket(ticketId) {
  const result = await pool.query("SELECT wa_phone FROM v_b_whatsapp_conversations WHERE ticket_id = $1 LIMIT 1", [ticketId]);
  return result.rows[0]?.wa_phone || null;
}
export async function maybeSendWhatsAppReplyForComment({
  ticketId,
  content,
  isInternal,
  attachments = []
}) {
  if (isInternal) return {
    skipped: true,
    reason: "internal_comment"
  };
  const ticketResult = await pool.query("SELECT id, channel FROM v_b_tickets WHERE id = $1", [ticketId]);
  const ticket = ticketResult.rows[0];
  if (!ticket || ticket.channel !== "whatsapp") {
    return {
      skipped: true,
      reason: "not_whatsapp_channel"
    };
  }
  const waPhone = await getWhatsAppPhoneForTicket(ticketId);
  if (!waPhone) return {
    skipped: true,
    reason: "missing_phone_mapping"
  };
  const plainText = stripHtmlToText(content);
  const ticketNumberResult = await pool.query("SELECT ticket_number FROM v_b_tickets WHERE id = $1", [ticketId]);
  const ticketNumber = ticketNumberResult.rows[0]?.ticket_number;
  const prefix = ticketNumber ? `[Ticket #${ticketNumber}] ` : "";
  const messagePrefix = plainText ? `${prefix}${plainText}` : prefix.trim();
  const fileRows = Array.isArray(attachments) ? attachments : [];
  const sent = [];
  let textDelivered = false;
  let captionDelivered = false;
  for (const attachment of fileRows) {
    const absolutePath = resolveTicketAttachmentAbsolutePath(attachment.file_path);
    if (!absolutePath || !fs.existsSync(absolutePath)) continue;
    const buffer = fs.readFileSync(absolutePath);
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`File is too large for WhatsApp: ${attachment.file_name || "attachment"}`);
    }
    const mimeType = attachment.mime_type || "application/octet-stream";
    const fileName = attachment.file_name || path.basename(absolutePath);
    const ext = path.extname(String(fileName || "")).toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) {
      throw new Error(`File type cannot be sent through WhatsApp: ${fileName || ext}`);
    }
    const mediaKind = resolveOutboundMediaKind(mimeType, fileName);
    const canCaption = mediaKind !== "audio";
    if (messagePrefix && !textDelivered && !captionDelivered && mediaKind === "audio") {
      await sendWhatsAppText({
        to: waPhone,
        text: messagePrefix
      });
      textDelivered = true;
    }
    const caption = canCaption && messagePrefix && !captionDelivered && !textDelivered ? messagePrefix.slice(0, MAX_WHATSAPP_CAPTION_LENGTH) : undefined;
    if (caption) captionDelivered = true;
    await sendWhatsAppMediaMessage({
      to: waPhone,
      buffer,
      mimeType,
      filename: fileName,
      caption,
      mediaType: mediaKind
    });
    sent.push(fileName);
  }
  if (fileRows.length === 0) {
    if (!plainText) return {
      skipped: true,
      reason: "empty_content"
    };
    await sendWhatsAppText({
      to: waPhone,
      text: messagePrefix
    });
    sent.push("text");
  } else if (messagePrefix && !textDelivered && !captionDelivered) {
    await sendWhatsAppText({
      to: waPhone,
      text: messagePrefix
    });
    sent.push("text");
  }
  if (sent.length === 0) {
    return {
      skipped: true,
      reason: "no_sendable_attachments"
    };
  }
  return {
    sent: true,
    items: sent
  };
}
export async function testWhatsAppConnection() {
  const config = await getWhatsAppConfig();
  if (!config.phoneNumberId || !config.accessToken) {
    throw new Error("Phone Number ID and access token are required.");
  }
  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.accessToken}`
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || "Failed to connect to the WhatsApp API.");
  }
  return {
    displayPhoneNumber: data.display_phone_number || null,
    verifiedName: data.verified_name || null,
    qualityRating: data.quality_rating || null
  };
}
