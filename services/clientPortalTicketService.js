import fs from "fs";
import path from "path";
import multer from "multer";
import { pool } from "../database/db.js";
import { loadAuthorProfilesByUserIds } from "../utils/userAvatar.js";
import { dispatchNotificationEvent } from "./notificationDispatcher.js";
import { notifyInAppTicketCommented } from "./userNotificationService.js";
import { getTicketSatisfaction, submitPortalTicketSatisfaction, updatePortalTicketSatisfaction, hasSatisfactionTable } from "./ticketSatisfactionService.js";
import {
  ensureTicketStatusMatchesValidation,
  getTicketResolutionValidation,
  submitPortalResolutionValidation,
  hasResolutionValidationTable,
} from "./ticketResolutionValidationService.js";
import { buildSlaInfoForTicket, loadClientContrat } from "../utils/ticketSla.js";

const TICKET_UPLOAD_DIR = path.resolve(process.cwd(), "uploads", "tickets");
fs.mkdirSync(TICKET_UPLOAD_DIR, { recursive: true });

const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".doc",
  ".docx",
  ".csv",
  ".xls",
  ".xlsx",
]);

export const portalAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TICKET_UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safeName = String(file.originalname || "piece-jointe")
        .replace(/[^\w.\-]+/g, "_")
        .slice(0, 120);
      cb(null, `${Date.now()}-${safeName}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(String(file.originalname || "")).toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) {
      return cb(
        new Error(
          "Type de fichier non autorisé. Formats acceptés: PDF, JPG, PNG, DOC, DOCX, CSV, XLS, XLSX."
        )
      );
    }
    cb(null, true);
  },
});

const SYSTEM_COMMENT_PREFIXES = [
  "[Linked ticket]",
  "[Split ticket]",
  "[Linked equipment]",
  "[Side conversation]",
  "[Resolution]",
  "[Resolution auto-clôture]",
  "[Resolution client]",
  "[Resolution client acceptée]",
];

function isSystemComment(content) {
  const text = String(content || "").trim();
  return SYSTEM_COMMENT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function normalizeContactSlots(rawSlots) {
  if (!Array.isArray(rawSlots)) return [];
  return rawSlots
    .map((slot) => ({
      date: String(slot?.date || "").trim(),
      startTime: String(slot?.startTime || slot?.start_time || "").trim(),
      endTime: String(slot?.endTime || slot?.end_time || "").trim(),
      note: String(slot?.note || "").trim(),
    }))
    .filter((slot) => slot.date || slot.startTime || slot.endTime || slot.note);
}

function normalizeEquipmentInfo(rawInfo) {
  const info = rawInfo && typeof rawInfo === "object" ? rawInfo : {};
  if (!info.concerned) return { concerned: false };
  const source = String(info.source || "").trim() === "external" ? "external" : "veritas";
  if (source === "external") {
    return {
      concerned: true,
      source: "external",
      brand: String(info.brand || "").trim(),
      model: String(info.model || "").trim(),
      serial: String(info.serial || "").trim(),
    };
  }
  return {
    concerned: true,
    source: "veritas",
    equipmentId: String(info.equipmentId || info.equipment_id || "").trim(),
    name: String(info.name || "").trim(),
    type: String(info.type || "").trim(),
    clientId: String(info.clientId || info.client_id || "").trim(),
  };
}

function buildPortalTicketDescription(baseDescription, { attemptedActions, issueNature } = {}) {
  const parts = [String(baseDescription || "").trim()];
  const attempted = String(attemptedActions || "").trim();
  if (attempted) {
    parts.push("", "--- Actions déjà tentées ---", attempted);
  }
  const natureLabels = {
    hardware: "Matériel",
    software: "Logiciel",
    unsure: "Non précisé",
  };
  const natureKey = String(issueNature || "").trim();
  if (natureKey && natureKey !== "unsure") {
    parts.push("", "--- Nature du problème ---", natureLabels[natureKey] || natureKey);
  }
  return parts.filter((line, index) => line !== "" || index === 0).join("\n").trim() || null;
}

function buildLinkedEquipmentComment(equipment, clientId) {
  const safeName = String(equipment?.name || equipment?.model || "Matériel").replace(/[\\\]]/g, "");
  const safeType = String(equipment?.type || "").replace(/[\\\]]/g, "");
  const safeClientId = String(clientId || "").replace(/[\\\]]/g, "");
  return (
    `[Linked equipment] [event:added] [equipment_id:${equipment.id}] [name:${safeName}] [type:${safeType}] ` +
    `[client_id:${safeClientId}] [warranty:] [licenses:]`
  );
}

function buildLinkedTicketComment(ticket) {
  const safeTitle = String(ticket?.title || "Ticket lié").replace(/[\\\]]/g, "");
  const safeNumber = String(ticket?.ticket_number || ticket?.id || "").replace(/[\\\]]/g, "");
  return (
    `[Linked ticket] [event:added] [linked_ticket_id:${ticket.id}] ` +
    `[ticket_number:${safeNumber}] [title:${safeTitle}]`
  );
}

async function insertInternalTicketComment(ticketId, userId, content) {
  const trimmed = String(content || "").trim();
  if (!trimmed) return;
  await pool.query(
    `INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
     VALUES ($1, $2, $3, true, NOW())`,
    [ticketId, userId || null, trimmed]
  );
}

async function assertPortalLinkedTicket(clientId, ticketId) {
  if (!ticketId) return null;
  const { rows } = await pool.query(
    `SELECT id, ticket_number, title, status, type, client_id
     FROM v_b_tickets
     WHERE id = $1 AND client_id = $2
     LIMIT 1`,
    [ticketId, clientId]
  );
  return rows[0] || null;
}

async function hasTicketColumn(columnName) {
  const key = String(columnName || "").trim();
  if (!key) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'v_b_tickets'
         AND column_name = $1
       LIMIT 1`,
      [key]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function hasRequesterContactColumn() {
  return hasTicketColumn("requester_contact_id");
}

async function hasCommentColumn(columnName) {
  const key = String(columnName || "").trim();
  if (!key) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'v_b_ticket_comments'
         AND column_name = $1
       LIMIT 1`,
      [key]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

function commentUpdatedAtSelectSql(hasCommentUpdatedAt) {
  return hasCommentUpdatedAt ? "updated_at" : "NULL::timestamptz AS updated_at";
}

function isPortalTicketLockedForEdits(status) {
  const normalized = String(status || "").toLowerCase();
  return normalized === "closed" || normalized === "resolved";
}

function mapPortalStatus(status) {
  return status === "open" ? "new" : status;
}

function mapPortalValidationMeta(row) {
  if (!row?.validation_outcome && !row?.auto_close_at && !row?.resolution_reason) return null;
  return {
    isPending: String(row.validation_outcome || row.outcome || "") === "pending",
    autoCloseAt: row.auto_close_at || null,
    resolutionReason: row.resolution_reason || "",
    requestedAt: row.requested_at || null,
  };
}

function mapPortalListRow(row) {
  const resolutionValidation = mapPortalValidationMeta(row);
  return {
    id: row.id,
    ticket_number: row.ticket_number,
    title: row.title,
    status: mapPortalStatus(row.status),
    priority: row.priority,
    type: row.type,
    channel: row.channel,
    created_at: row.created_at,
    updated_at: row.updated_at,
    requester_contact_id: row.requester_contact_id ?? null,
    hasSatisfaction: Boolean(row.has_satisfaction),
    ...(resolutionValidation?.isPending ? { resolutionValidation } : {}),
  };
}

function buildPortalTicketSoftDeleteClauses(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return {
    async clauses() {
      const parts = [];
      if (await hasTicketColumn("deleted_at")) parts.push(`${prefix}deleted_at IS NULL`);
      if (await hasTicketColumn("is_deleted")) {
        parts.push(`COALESCE(${prefix}is_deleted, false) = false`);
      }
      return parts;
    },
  };
}

function mapPortalComment(row, attachments = [], authorProfile = null) {
  const authorLabel =
    authorProfile && typeof authorProfile === "object"
      ? authorProfile.display_name
      : authorProfile;
  return {
    id: row.id,
    content: row.content,
    is_internal: false,
    created_at: row.created_at,
    updated_at: row.updated_at || null,
    author_user_id: row.author_user_id || null,
    author_name: authorLabel || "Support",
    author_avatar:
      authorProfile && typeof authorProfile === "object" ? authorProfile.avatar || null : null,
    attachments: attachments.map((file) => ({
      id: file.id,
      file_name: file.file_name,
      file_path: file.file_path,
      mime_type: file.mime_type,
      file_size: file.file_size,
      created_at: file.created_at,
    })),
  };
}

export async function getPortalUserContext(userId) {
  const { rows } = await pool.query(
    `SELECT id, email, username, client_id, contact_id
     FROM v_b_users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

export async function countPortalTicketsPendingValidation(clientId) {
  if (!(await hasResolutionValidationTable())) return 0;

  const softDelete = buildPortalTicketSoftDeleteClauses("t");
  const softDeleteClauses = await softDelete.clauses();
  const where = [
    "t.client_id = $1",
    "LOWER(t.status) = 'resolved'",
    "v.outcome = 'pending'",
    ...softDeleteClauses,
  ];

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM v_b_ticket_resolution_validations v
     INNER JOIN v_b_tickets t ON t.id = v.ticket_id
     WHERE ${where.join(" AND ")}`,
    [clientId]
  );
  return Number(rows[0]?.total) || 0;
}

export async function countPortalTicketsPendingClientResponse(clientId) {
  const softDelete = buildPortalTicketSoftDeleteClauses("t");
  const softDeleteClauses = await softDelete.clauses();
  const where = ["t.client_id = $1", "LOWER(t.status) = 'pending'", ...softDeleteClauses];

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM v_b_tickets t
     WHERE ${where.join(" AND ")}`,
    [clientId]
  );
  return Number(rows[0]?.total) || 0;
}

export async function countPortalTicketsActionRequired(clientId) {
  const [validationCount, pendingCount] = await Promise.all([
    countPortalTicketsPendingValidation(clientId),
    countPortalTicketsPendingClientResponse(clientId),
  ]);
  return validationCount + pendingCount;
}

export async function listPortalTicketsPendingClientResponse(
  clientId,
  { search, limit = 50, offset = 0 } = {}
) {
  return listPortalTickets(clientId, { status: "pending", search, limit, offset });
}

export async function listPortalTicketsActionRequired(clientId, { search, limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const [validationRows, pendingRows] = await Promise.all([
    listPortalTicketsPendingValidation(clientId, { search, limit: safeLimit }),
    listPortalTicketsPendingClientResponse(clientId, { search, limit: safeLimit }),
  ]);

  const merged = [...validationRows, ...pendingRows];
  merged.sort((a, b) => {
    const ta = new Date(a.updated_at || a.created_at || 0).getTime();
    const tb = new Date(b.updated_at || b.created_at || 0).getTime();
    return tb - ta;
  });
  return merged.slice(0, safeLimit);
}

export async function listPortalTicketsPendingValidation(
  clientId,
  { search, limit = 50, offset = 0 } = {}
) {
  if (!(await hasResolutionValidationTable())) return [];

  const softDelete = buildPortalTicketSoftDeleteClauses("t");
  const softDeleteClauses = await softDelete.clauses();
  const params = [clientId];
  const where = [
    "t.client_id = $1",
    "LOWER(t.status) = 'resolved'",
    "v.outcome = 'pending'",
    ...softDeleteClauses,
  ];

  if (search) {
    params.push(`%${String(search).trim()}%`);
    where.push(
      `(t.title ILIKE $${params.length} OR CAST(t.ticket_number AS TEXT) ILIKE $${params.length})`
    );
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  params.push(safeLimit, safeOffset);

  const hasSatTable = await hasSatisfactionTable();
  const satJoin = hasSatTable
    ? "LEFT JOIN v_b_ticket_satisfaction sat ON sat.ticket_id = t.id"
    : "";
  const satSelect = hasSatTable ? ", (sat.id IS NOT NULL) AS has_satisfaction" : ", false AS has_satisfaction";

  const { rows } = await pool.query(
    `SELECT t.id, t.ticket_number, t.title, t.status, t.priority, t.type, t.channel,
            t.created_at, t.updated_at, t.requester_contact_id,
            v.outcome AS validation_outcome, v.auto_close_at, v.resolution_reason, v.requested_at
            ${satSelect}
     FROM v_b_ticket_resolution_validations v
     INNER JOIN v_b_tickets t ON t.id = v.ticket_id
     ${satJoin}
     WHERE ${where.join(" AND ")}
     ORDER BY v.requested_at ASC NULLS LAST, t.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return rows.map(mapPortalListRow);
}

export async function listPortalTickets(clientId, { status, search, limit = 50, offset = 0 } = {}) {
  if (status === "pending_validation") {
    return listPortalTicketsPendingValidation(clientId, { search, limit, offset });
  }

  const hasDeletedAt = await hasTicketColumn("deleted_at");
  const hasIsDeleted = await hasTicketColumn("is_deleted");
  const params = [clientId];
  const where = ["t.client_id = $1"];

  if (hasDeletedAt) where.push("t.deleted_at IS NULL");
  if (hasIsDeleted) where.push("COALESCE(t.is_deleted, false) = false");

  if (status) {
    const normalized = status === "new" ? "open" : status;
    params.push(normalized);
    where.push(`t.status = $${params.length}`);
  }

  if (search) {
    params.push(`%${String(search).trim()}%`);
    where.push(
      `(t.title ILIKE $${params.length} OR CAST(t.ticket_number AS TEXT) ILIKE $${params.length})`
    );
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  params.push(safeLimit, safeOffset);

  const hasSatTable = await hasSatisfactionTable();
  const satJoin = hasSatTable
    ? "LEFT JOIN v_b_ticket_satisfaction sat ON sat.ticket_id = t.id"
    : "";
  const satSelect = hasSatTable ? ", (sat.id IS NOT NULL) AS has_satisfaction" : ", false AS has_satisfaction";

  const hasValidationTable = await hasResolutionValidationTable();
  const validationJoin = hasValidationTable
    ? `LEFT JOIN LATERAL (
         SELECT outcome, auto_close_at, resolution_reason, requested_at
         FROM v_b_ticket_resolution_validations
         WHERE ticket_id = t.id
         ORDER BY
           CASE WHEN outcome = 'pending' THEN 0 ELSE 1 END,
           requested_at DESC NULLS LAST
         LIMIT 1
       ) v ON true`
    : "";
  const validationSelect = hasValidationTable
    ? ", v.outcome AS validation_outcome, v.auto_close_at, v.resolution_reason, v.requested_at"
    : "";

  const { rows } = await pool.query(
    `SELECT t.id, t.ticket_number, t.title, t.status, t.priority, t.type, t.channel,
            t.created_at, t.updated_at, t.requester_contact_id
            ${validationSelect}
            ${satSelect}
     FROM v_b_tickets t
     ${validationJoin}
     ${satJoin}
     WHERE ${where.join(" AND ")}
     ORDER BY t.updated_at DESC NULLS LAST, t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return rows.map(mapPortalListRow);
}

async function assertPortalTicketAccess(clientId, ticketId) {
  const hasDeletedAt = await hasTicketColumn("deleted_at");
  const hasIsDeleted = await hasTicketColumn("is_deleted");
  const params = [ticketId, clientId];
  const where = ["id = $1", "client_id = $2"];
  if (hasDeletedAt) where.push("deleted_at IS NULL");
  if (hasIsDeleted) where.push("COALESCE(is_deleted, false) = false");

  const { rows } = await pool.query(
    `SELECT id, ticket_number, title, description, status, priority, type, channel,
            client_id, requester_contact_id, created_at, updated_at, closed_at, resolved_at
     FROM v_b_tickets
     WHERE ${where.join(" AND ")}
     LIMIT 1`,
    params
  );
  return rows[0] || null;
}

async function resolveAuthorProfiles(userIds = []) {
  return loadAuthorProfilesByUserIds(userIds);
}

export async function getPortalTicketDetail(clientId, ticketId) {
  const ticket = await assertPortalTicketAccess(clientId, ticketId);
  if (!ticket) return null;

  await ensureTicketStatusMatchesValidation(ticketId).catch((err) => {
    console.error(`[portal] ensureTicketStatusMatchesValidation ${ticketId}:`, err.message);
  });
  const refreshedTicket = await assertPortalTicketAccess(clientId, ticketId);
  if (!refreshedTicket) return null;

  const hasCommentUpdatedAt = await hasCommentColumn("updated_at");
  const commentsResult = await pool.query(
    `SELECT id, ticket_id, author_user_id, content, is_internal, created_at, ${commentUpdatedAtSelectSql(hasCommentUpdatedAt)}
     FROM v_b_ticket_comments
     WHERE ticket_id = $1 AND is_internal = false
     ORDER BY created_at ASC`,
    [ticketId]
  );

  const publicComments = commentsResult.rows.filter((row) => !isSystemComment(row.content));
  const commentIds = publicComments.map((row) => row.id);
  let attachmentsByComment = new Map();

  if (commentIds.length > 0) {
    const attachmentsResult = await pool.query(
      `SELECT id, ticket_id, comment_id, file_name, file_path, mime_type, file_size, created_at
       FROM v_b_ticket_attachments
       WHERE ticket_id = $1 AND comment_id = ANY($2::uuid[])
       ORDER BY created_at ASC`,
      [ticketId, commentIds]
    );
    attachmentsResult.rows.forEach((file) => {
      const key = String(file.comment_id);
      const bucket = attachmentsByComment.get(key) || [];
      bucket.push(file);
      attachmentsByComment.set(key, bucket);
    });
  }

  const authorMap = await resolveAuthorProfiles(publicComments.map((row) => row.author_user_id));
  const satisfaction = await getTicketSatisfaction(ticketId);
  const resolutionValidation = await getTicketResolutionValidation(ticketId);

  return {
    id: refreshedTicket.id,
    ticket_number: refreshedTicket.ticket_number,
    title: refreshedTicket.title,
    description: refreshedTicket.description,
    status: mapPortalStatus(refreshedTicket.status),
    priority: refreshedTicket.priority,
    type: refreshedTicket.type,
    channel: refreshedTicket.channel,
    client_id: refreshedTicket.client_id,
    requester_contact_id: refreshedTicket.requester_contact_id,
    created_at: refreshedTicket.created_at,
    updated_at: refreshedTicket.updated_at,
    closed_at: refreshedTicket.closed_at,
    resolved_at: refreshedTicket.resolved_at,
    comments: publicComments.map((row) =>
      mapPortalComment(
        row,
        attachmentsByComment.get(String(row.id)) || [],
        authorMap.get(String(row.author_user_id)) || null
      )
    ),
    satisfaction,
    resolutionValidation,
  };
}

export async function createPortalTicket({
  clientId,
  contactId,
  userId,
  title,
  description,
  priority = "normal",
  type = "incident",
  contactSlots = [],
  equipmentInfo = { concerned: false },
  linkedTicketId = null,
  attemptedActions = "",
  issueNature = "",
}) {
  const hasRequesterContact = await hasRequesterContactColumn();
  const hasContactSlots = await hasTicketColumn("contact_slots");
  const hasEquipmentInfo = await hasTicketColumn("equipment_info");
  const hasSlaInfo = await hasTicketColumn("sla_info");

  const normalizedContactSlots = normalizeContactSlots(contactSlots);
  const normalizedEquipmentInfo = normalizeEquipmentInfo(equipmentInfo);
  const fullDescription = buildPortalTicketDescription(description, { attemptedActions, issueNature });

  const columns = [
    "title",
    "description",
    "status",
    "priority",
    "type",
    "category",
    "channel",
    "client_id",
  ];
  const values = [
    String(title).trim(),
    fullDescription,
    "open",
    ["low", "normal", "high", "urgent"].includes(priority) ? priority : "normal",
    ["incident", "demande", "request", "probleme", "changement"].includes(type) ? type : "incident",
    "",
    "web",
    clientId,
  ];

  if (hasRequesterContact) {
    columns.push("requester_contact_id");
    values.push(contactId || null);
  }

  columns.push("requester_user_id", "assigned_user_id", "created_by");
  values.push(userId || null, null, userId || null);

  if (hasContactSlots) {
    columns.push("contact_slots");
    values.push(JSON.stringify(normalizedContactSlots));
  }

  if (hasEquipmentInfo) {
    columns.push("equipment_info");
    values.push(JSON.stringify(normalizedEquipmentInfo));
  }

  if (hasSlaInfo) {
    const clientContrat = await loadClientContrat(clientId);
    const slaInfo = await buildSlaInfoForTicket({
      priority: values[3],
      clientContrat,
      createdAt: new Date(),
    });
    columns.push("sla_info");
    values.push(JSON.stringify(slaInfo));
  }

  columns.push("created_at", "updated_at");
  const placeholders = values.map((_, idx) => `$${idx + 1}`);
  placeholders.push("NOW()", "NOW()");

  const result = await pool.query(
    `INSERT INTO v_b_tickets (${columns.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING *`,
    values
  );

  const created = result.rows[0];

  await pool.query(
    `INSERT INTO v_b_ticket_status_history (ticket_id, old_status, new_status, changed_by, note, created_at)
     VALUES ($1, NULL, $2, $3, $4, NOW())`,
    [created.id, created.status, userId || null, "Création via portail client"]
  );

  if (
    normalizedEquipmentInfo.concerned &&
    normalizedEquipmentInfo.source === "veritas" &&
    normalizedEquipmentInfo.equipmentId
  ) {
    await insertInternalTicketComment(
      created.id,
      userId,
      buildLinkedEquipmentComment(
        {
          id: normalizedEquipmentInfo.equipmentId,
          name: normalizedEquipmentInfo.name,
          type: normalizedEquipmentInfo.type,
        },
        normalizedEquipmentInfo.clientId || clientId
      )
    ).catch(() => {});
  }

  const linkedTicket = linkedTicketId
    ? await assertPortalLinkedTicket(clientId, linkedTicketId)
    : null;
  if (linkedTicket) {
    await insertInternalTicketComment(
      created.id,
      userId,
      buildLinkedTicketComment(linkedTicket)
    ).catch(() => {});
  }

  await dispatchNotificationEvent({
    source: "tickets",
    element: "created",
    enterpriseId: String(clientId || ""),
    user: { id: userId },
    context: {
      ticket: created,
      entreprise: { id: String(clientId || "") },
    },
  }).catch(() => {});

  return mapPortalListRow(created);
}

export async function addPortalTicketComment({
  clientId,
  ticketId,
  userId,
  content,
  files = [],
}) {
  const ticket = await assertPortalTicketAccess(clientId, ticketId);
  if (!ticket) return null;

  if (String(ticket.status || "").toLowerCase() === "closed") {
    const err = new Error("TICKET_CLOSED");
    throw err;
  }

  const trimmed = String(content || "").trim();
  if (!trimmed && files.length === 0) {
    const err = new Error("EMPTY_COMMENT");
    throw err;
  }

  const result = await pool.query(
    `INSERT INTO v_b_ticket_comments (ticket_id, author_user_id, content, is_internal, created_at)
     VALUES ($1, $2, $3, false, NOW())
     RETURNING *`,
    [ticketId, userId || null, trimmed]
  );

  const createdComment = result.rows[0];
  const savedAttachments = [];

  for (const file of files) {
    const relativePath = `/uploads/tickets/${path.basename(file.path)}`;
    const attachmentResult = await pool.query(
      `INSERT INTO v_b_ticket_attachments
        (ticket_id, comment_id, uploaded_by, file_name, file_path, mime_type, file_size, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [
        ticketId,
        createdComment.id,
        userId || null,
        file.originalname || path.basename(file.path),
        relativePath,
        file.mimetype || "application/octet-stream",
        Number(file.size || 0),
      ]
    );
    savedAttachments.push(attachmentResult.rows[0]);
  }

  await pool.query("UPDATE v_b_tickets SET updated_at = NOW() WHERE id = $1", [ticketId]);

  await dispatchNotificationEvent({
    source: "tickets",
    element: "commented",
    enterpriseId: String(clientId || ""),
    user: { id: userId },
    context: {
      ticket: { id: ticketId },
      comment: createdComment,
      entreprise: { id: String(clientId || "") },
    },
  }).catch(() => {});
  await notifyInAppTicketCommented({
    ticketId,
    commentId: createdComment.id,
    authorUserId: userId || null,
    isInternal: false,
    contentPreview: trimmed,
  }).catch(() => {});

  const authorMap = await resolveAuthorProfiles([userId]);
  return mapPortalComment(
    createdComment,
    savedAttachments,
    authorMap.get(String(userId)) || { display_name: "Vous", avatar: null }
  );
}

export async function updatePortalTicketComment({
  clientId,
  ticketId,
  userId,
  commentId,
  content,
}) {
  const ticket = await assertPortalTicketAccess(clientId, ticketId);
  if (!ticket) return null;

  if (isPortalTicketLockedForEdits(ticket.status)) {
    const err = new Error("TICKET_LOCKED");
    throw err;
  }

  const hasCommentUpdatedAt = await hasCommentColumn("updated_at");
  if (!hasCommentUpdatedAt) {
    const err = new Error("UPDATED_AT_MIGRATION_REQUIRED");
    throw err;
  }

  const trimmed = String(content || "").trim();

  const commentResult = await pool.query(
    `SELECT id, ticket_id, author_user_id, content, is_internal, created_at, updated_at
     FROM v_b_ticket_comments
     WHERE id = $1 AND ticket_id = $2 AND is_internal = false`,
    [commentId, ticketId]
  );
  if (commentResult.rows.length === 0) {
    const err = new Error("COMMENT_NOT_FOUND");
    throw err;
  }

  const existing = commentResult.rows[0];
  if (isSystemComment(existing.content)) {
    const err = new Error("SYSTEM_COMMENT");
    throw err;
  }
  if (!userId || !existing.author_user_id || String(existing.author_user_id) !== String(userId)) {
    const err = new Error("NOT_AUTHOR");
    throw err;
  }

  const attachmentsResult = await pool.query(
    `SELECT id, ticket_id, comment_id, file_name, file_path, mime_type, file_size, created_at
     FROM v_b_ticket_attachments
     WHERE comment_id = $1 AND ticket_id = $2
     ORDER BY created_at ASC`,
    [commentId, ticketId]
  );
  const savedAttachments = attachmentsResult.rows;

  if (!trimmed && savedAttachments.length === 0) {
    const err = new Error("EMPTY_COMMENT");
    throw err;
  }
  if (trimmed && isSystemComment(trimmed)) {
    const err = new Error("INVALID_CONTENT");
    throw err;
  }

  const updateResult = await pool.query(
    `UPDATE v_b_ticket_comments
     SET content = $1, updated_at = NOW()
     WHERE id = $2 AND ticket_id = $3
     RETURNING id, ticket_id, author_user_id, content, is_internal, created_at, updated_at`,
    [trimmed, commentId, ticketId]
  );

  await pool.query("UPDATE v_b_tickets SET updated_at = NOW() WHERE id = $1", [ticketId]);

  const authorMap = await resolveAuthorProfiles([userId]);
  return mapPortalComment(
    updateResult.rows[0],
    savedAttachments,
    authorMap.get(String(userId)) || { display_name: "Vous", avatar: null }
  );
}

export { submitPortalTicketSatisfaction, submitPortalResolutionValidation, updatePortalTicketSatisfaction };
