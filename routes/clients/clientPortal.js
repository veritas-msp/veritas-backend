import express from "express";
import fs from "fs";
import { body, param, query, validationResult } from "express-validator";
import multer from "multer";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import {
  addPortalTicketComment,
  updatePortalTicketComment,
  countPortalTicketsActionRequired,
  createPortalTicket,
  getPortalTicketDetail,
  getPortalUserContext,
  listPortalTickets,
  listPortalTicketsActionRequired,
  portalAttachmentUpload,
  submitPortalTicketSatisfaction,
  updatePortalTicketSatisfaction,
  submitPortalResolutionValidation,
} from "../../services/clientPortalTicketService.js";
import {
  countPortalVaultFiles,
  getPortalVaultFileRecord,
  listPortalVaultFiles,
  resolveClientFileDiskPath,
} from "../../services/clientPortalVaultService.js";
import {
  countPortalVaultSecrets,
  listPortalVaultSecrets,
  revealPortalVaultSecret,
  requestPortalVaultSecretRevocation,
} from "../../services/clientVaultSecretService.js";
import { isCommunity } from "../../utils/edition.js";
import { COMMUNITY_SALES_TICKET_SQL_PLAIN } from "../../utils/ticketEditionGuard.js";
import { transformClientModulesToFrontend } from "../../utils/transformClientModules.js";
import { expandCloudServiceRows } from "../../utils/portalCloudServices.js";
import {
  normalizeContactCommunications,
  syncLegacyContactFields,
  validateContactCommunications,
} from "../../utils/contactCommunications.js";
import { syncPortalUserFromContact } from "../../utils/contactPortal.js";

const router = express.Router();

router.use(verifyJWT, requireRole("client"));

const INFRA_TABLES = [
  { type: "internet",  label: "Internet",   icon: "mdi:web" },
  { type: "firewall",  label: "Pare-feu",   icon: "mdi:shield-lock" },
  { type: "servers",   label: "Serveur",    icon: "mdi:server" },
  { type: "stockage",  label: "Stockage",   icon: "mdi:harddisk" },
  { type: "switch",    label: "Switch",     icon: "mdi:lan" },
  { type: "wifi",      label: "Wi-Fi",      icon: "mdi:wifi" },
  { type: "alimentation", label: "Alimentation", icon: "mdi:power-plug" },
  { type: "routeur",   label: "Routeur",    icon: "mdi:router-wireless" },
  { type: "toip",      label: "TOIP",       icon: "mdi:phone-voip" },
];

const CLOUD_TABLES = [
  { type: "o365",      label: "Microsoft 365", icon: "mdi:microsoft-office" },
  { type: "save",      label: "Sauvegarde",    icon: "mdi:backup-restore" },
  { type: "antivirus", label: "Antivirus",     icon: "mdi:shield-check" },
  { type: "antispam",  label: "Antispam",      icon: "mdi:email-lock" },
  { type: "ndd",       label: "Noms de domaine", icon: "mdi:domain" },
];

const TABLE_MAP = {
  internet:  "v_b_clients_m_internet",
  firewall:  "v_b_clients_m_firewall",
  servers:   "v_b_clients_m_servers",
  stockage:  "v_b_clients_m_stockage",
  switch:    "v_b_clients_m_switch",
  wifi:      "v_b_clients_m_wifi",
  alimentation: "v_b_clients_m_alimentation",
  routeur:   "v_b_clients_m_routeur",
  toip:      "v_b_clients_m_toip",
  o365:      "v_b_clients_m_o365",
  save:      "v_b_clients_m_save",
  antivirus: "v_b_clients_m_antivirus",
  antispam:  "v_b_clients_m_antispam",
  ndd:       "v_b_clients_m_ndd",
};

function parseJsonField(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

const CLIENT_DASHBOARD_COLUMNS = [
  "id",
  "name",
  "email",
  "phone",
  "address",
  "siret",
  "secteur",
  "contrat",
  "modules",
  "options",
  "commercial_id",
  "created_at",
];

function extractLocationFromAddress(address) {
  if (!address) {
    return { city: null, country: null, addressLine: null };
  }

  if (typeof address === "string") {
    const trimmed = address.trim();
    if (!trimmed) {
      return { city: null, country: null, addressLine: null };
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = parseJsonField(trimmed, null);
      if (parsed && typeof parsed === "object") {
        return extractLocationFromAddress(parsed);
      }
    }

    const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
    const city = parts.length >= 2 ? parts[parts.length - 1] : trimmed;
    return { city, country: null, addressLine: trimmed };
  }

  if (typeof address === "object") {
    const city =
      address.city ||
      address.addressCity ||
      address.ville ||
      null;
    const country = address.country || address.pays || null;
    const street = address.street || address.addressStreet || address.voie || "";
    const postal =
      address.postalCode || address.addressPostalCode || address.codePostal || "";
    const addressLine = [street, [postal, city].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join(", ");

    return {
      city,
      country,
      addressLine: addressLine || null,
    };
  }

  return { city: null, country: null, addressLine: null };
}

async function loadClientRow(clientId) {
  const buildQuery = (columns) => `
    SELECT ${columns.map((column) => `c.${column}`).join(", ")},
           u.username AS commercial_name,
           u.email AS commercial_email
    FROM v_b_clients c
    LEFT JOIN v_b_users u ON c.commercial_id::text = u.id::text
    WHERE c.id = $1
  `;

  try {
    const { rows } = await pool.query(buildQuery(CLIENT_DASHBOARD_COLUMNS), [clientId]);
    return rows[0] || null;
  } catch (err) {
    if (err.code !== "42703") throw err;

    const { rows: columnRows } = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'v_b_clients'`
    );
    const available = new Set(
      columnRows.map((row) => String(row.column_name || "").trim())
    );
    const selected = CLIENT_DASHBOARD_COLUMNS.filter((column) => available.has(column));
    if (!selected.includes("id")) selected.unshift("id");

    const { rows } = await pool.query(buildQuery(selected), [clientId]);
    return rows[0] || null;
  }
}

function mapClientForPortal(client) {
  const location = extractLocationFromAddress(client.address);
  const options = parseJsonField(client.options, {});

  return {
    id: client.id,
    name: client.name,
    city: location.city,
    country: location.country,
    phone: client.phone || null,
    email: client.email || null,
    website: options.website || options.siteWeb || options.site_web || null,
    address: location.addressLine,
    siret: client.siret || null,
    secteur: client.secteur || null,
    created_at: client.created_at || null,
  };
}

function getClientId(req, res) {
  const clientId = req.user.client_id;
  if (!clientId) {
    res.status(403).json({ error: "Aucune entreprise associée à ce compte." });
    return null;
  }
  return clientId;
}

function validationErrorOrNull(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json({
    error: "Erreur de validation",
    errors: errors.array(),
  });
}

async function getPortalContext(req, res) {
  const clientId = getClientId(req, res);
  if (!clientId) return null;
  const userRow = await getPortalUserContext(req.user.id);
  if (!userRow) {
    res.status(403).json({ error: "Compte portail introuvable." });
    return null;
  }
  return {
    clientId,
    userId: userRow.id,
    contactId: userRow.contact_id || null,
    email: userRow.email,
  };
}

function parseModuleRowData(row) {
  if (row.data && typeof row.data === "string") {
    try {
      row.data = JSON.parse(row.data);
    } catch {
      row.data = {};
    }
  } else if (!row.data) {
    row.data = {};
  }
  return row;
}

async function fetchClientComputersForPortal(clientId) {
  const table = "v_b_clients_m_ordinateurs";
  try {
    let moduleResult;
    const baseSelect =
      "SELECT id, item_key, name, data, is_active, agent_id, checkmk_host_name, checkmk_site, checkmk_service_name";

    try {
      moduleResult = await pool.query(
        `${baseSelect}
         FROM ${table}
         WHERE client_id = $1 AND is_active IS DISTINCT FROM false
         ORDER BY name NULLS LAST, item_key NULLS LAST`,
        [clientId]
      );
    } catch (colErr) {
      if (colErr.code !== "42703") throw colErr;
      moduleResult = await pool.query(
        `SELECT id, item_key, name, data, is_active
         FROM ${table}
         WHERE client_id = $1 AND is_active IS DISTINCT FROM false
         ORDER BY name NULLS LAST, item_key NULLS LAST`,
        [clientId]
      );
      moduleResult.rows.forEach((row) => {
        row.agent_id = row.data?.agentId ?? row.data?.agent_id ?? null;
        row.checkmk_host_name = null;
        row.checkmk_site = null;
        row.checkmk_service_name = null;
      });
    }

    const parsedRows = moduleResult.rows.map(parseModuleRowData);
    const transformed = transformClientModulesToFrontend({ ordinateurs: parsedRows }, {});
    return transformed.equipements?.Ordinateurs || [];
  } catch (err) {
    if (err.code === "42P01") return [];
    throw err;
  }
}

async function fetchEquipmentItems(clientId, type, { cloudPortal = false } = {}) {
  const table = TABLE_MAP[type];
  if (!table) return [];
  const selectWithCheckmk = `SELECT id, name, item_key, is_active, data, checkmk_host_name
       FROM ${table}
       WHERE client_id = $1
       ORDER BY name NULLS LAST, item_key NULLS LAST`;
  const selectBasic = `SELECT id, name, item_key, is_active, data
           FROM ${table} WHERE client_id = $1
           ORDER BY name NULLS LAST, item_key NULLS LAST`;

  const mapRow = (row, hasCheckmk) => {
    const data = parseJsonField(row.data, {});
    if (cloudPortal) {
      return expandCloudServiceRows(type, row, data);
    }
    return [
      {
        id: row.id,
        name: row.name || data.nom || row.item_key || "Sans nom",
        type,
        active: row.is_active !== false,
        monitored: hasCheckmk ? Boolean(row.checkmk_host_name) : false,
      },
    ];
  };

  try {
    const { rows } = await pool.query(selectWithCheckmk, [clientId]);
    return rows.flatMap((row) => mapRow(row, true));
  } catch (err) {
    if (err.code === "42703") {
      try {
        const { rows } = await pool.query(selectBasic, [clientId]);
        return rows.flatMap((row) => mapRow(row, false));
      } catch {
        return [];
      }
    }
    if (err.code === "42P01") return [];
    throw err;
  }
}

// ── Dashboard complet ─────────────────────────────────────────────────
router.get("/dashboard", async (req, res) => {
  const clientId = getClientId(req, res);
  if (!clientId) return;

  try {
    const client = await loadClientRow(clientId);

    if (!client) return res.status(404).json({ error: "Entreprise introuvable." });

    const contrat = parseJsonField(client.contrat, {});
    const modules = parseJsonField(client.modules, {});

    const infraItems = (
      await Promise.all(INFRA_TABLES.map((t) => fetchEquipmentItems(clientId, t.type)))
    ).flat();

    const cloudItems = (
      await Promise.all(
        CLOUD_TABLES.map((t) => fetchEquipmentItems(clientId, t.type, { cloudPortal: true }))
      )
    ).flat();

    const computers = await fetchClientComputersForPortal(clientId);
    const computerCount = computers.length;

    const allItems = [...infraItems, ...cloudItems];
    const activeCount = allItems.filter((i) => i.active).length + computerCount;

    let tickets = [];
    try {
      const salesFilter = isCommunity() ? ` AND ${COMMUNITY_SALES_TICKET_SQL_PLAIN}` : "";
      const { rows } = await pool.query(
        `SELECT id, title, status, priority, created_at, updated_at
         FROM v_b_tickets WHERE client_id = $1${salesFilter}
         ORDER BY created_at DESC LIMIT 10`,
        [clientId]
      );
      tickets = rows.map((row) => ({
        ...row,
        status: row.status === "open" ? "new" : row.status,
      }));
    } catch (err) {
      if (err.code !== "42P01") throw err;
    }

    let actionRequiredTickets = [];
    let actionRequiredCount = 0;
    try {
      actionRequiredCount = await countPortalTicketsActionRequired(clientId);
      if (actionRequiredCount > 0) {
        actionRequiredTickets = await listPortalTicketsActionRequired(clientId, { limit: 5 });
      }
    } catch (err) {
      if (err.code !== "42P01") throw err;
    }

    let files = [];
    let vaultFileCount = 0;
    try {
      vaultFileCount = await countPortalVaultFiles(clientId);
      files = await listPortalVaultFiles(clientId, { limit: 5 });
    } catch (err) {
      if (err.code !== "42P01") throw err;
    }

    const openTickets = tickets.filter((t) => !["resolved", "closed"].includes(t.status)).length;

    res.json({
      client: mapClientForPortal(client),
      contrat: {
        debut: contrat.debut || null,
        expiration: contrat.expiration || null,
        suspendu: Boolean(contrat.suspendu),
      },
      commercial: client.commercial_name
        ? { name: client.commercial_name, email: client.commercial_email }
        : null,
      modules,
      options: parseJsonField(client.options, {}),
      stats: {
        totalEquipment: allItems.length + computerCount,
        activeEquipment: activeCount,
        openTickets,
        actionRequiredCount,
        pendingValidationCount: actionRequiredCount,
        infraCount: infraItems.length,
        cloudCount: cloudItems.length,
        computerCount,
        vaultFileCount,
      },
      computers,
      infrastructure: INFRA_TABLES.map((t) => ({
        ...t,
        items: infraItems.filter((i) => i.type === t.type),
      })).filter((g) => g.items.length > 0),
      cloudServices: CLOUD_TABLES.map((t) => ({
        ...t,
        items: cloudItems.filter((i) => i.type === t.type),
      })).filter((g) => g.items.length > 0),
      tickets,
      actionRequiredTickets,
      pendingValidationTickets: actionRequiredTickets,
      files,
    });
  } catch (err) {
    console.error("Erreur /client-portal/dashboard:", err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ── Tickets support (portail client) ────────────────────────────────
router.get(
  "/tickets",
  [
    query("status").optional().isString(),
    query("search").optional().isString(),
    query("limit").optional().isInt({ min: 1, max: 200 }),
    query("offset").optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    const ctx = await getPortalContext(req, res);
    if (!ctx) return;

    try {
      const tickets = await listPortalTickets(ctx.clientId, {
        status: req.query.status,
        search: req.query.search,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ tickets });
    } catch (err) {
      console.error("Erreur GET /client-portal/tickets:", err);
      res.status(500).json({ error: "Erreur lors de la récupération des tickets." });
    }
  }
);

router.get("/tickets/:id", [param("id").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;

  const ctx = await getPortalContext(req, res);
  if (!ctx) return;

  try {
    const ticket = await getPortalTicketDetail(ctx.clientId, req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket introuvable." });
    res.json(ticket);
  } catch (err) {
    console.error("Erreur GET /client-portal/tickets/:id:", err);
    res.status(500).json({ error: "Erreur lors de la récupération du ticket." });
  }
});

router.post(
  "/tickets",
  [
    body("title").notEmpty().withMessage("Le titre est requis"),
    body("description").optional().isString(),
    body("priority").optional().isIn(["low", "normal", "high", "urgent"]),
    body("type").optional().isString(),
    body("attemptedActions").optional().isString(),
    body("issueNature").optional().isIn(["hardware", "software", "unsure", ""]),
    body("contactSlots").optional().isArray(),
    body("equipmentInfo").optional().isObject(),
    body("linkedTicketId").optional({ nullable: true }).isUUID(),
  ],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    const ctx = await getPortalContext(req, res);
    if (!ctx) return;

    try {
      const ticket = await createPortalTicket({
        clientId: ctx.clientId,
        contactId: ctx.contactId,
        userId: ctx.userId,
        title: req.body.title,
        description: req.body.description,
        priority: req.body.priority,
        type: req.body.type,
        attemptedActions: req.body.attemptedActions,
        issueNature: req.body.issueNature,
        contactSlots: req.body.contactSlots,
        equipmentInfo: req.body.equipmentInfo,
        linkedTicketId: req.body.linkedTicketId || null,
      });
      res.status(201).json(ticket);
    } catch (err) {
      console.error("Erreur POST /client-portal/tickets:", err);
      res.status(500).json({ error: "Erreur lors de la création du ticket." });
    }
  }
);

router.post(
  "/tickets/:id/comments",
  portalAttachmentUpload.array("attachments", 10),
  [param("id").isUUID(), body("content").optional().isString()],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    const ctx = await getPortalContext(req, res);
    if (!ctx) return;

    try {
      const comment = await addPortalTicketComment({
        clientId: ctx.clientId,
        ticketId: req.params.id,
        userId: ctx.userId,
        content: req.body?.content,
        files: Array.isArray(req.files) ? req.files : [],
      });
      if (!comment) return res.status(404).json({ error: "Ticket introuvable." });
      res.status(201).json(comment);
    } catch (err) {
      if (err?.message === "EMPTY_COMMENT") {
        return res.status(400).json({
          error: "Le message ne peut pas être vide (texte ou pièce jointe requis).",
        });
      }
      if (err?.message === "TICKET_CLOSED") {
        return res.status(409).json({ error: "Ce ticket est clos. Vous ne pouvez plus y répondre." });
      }
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "Fichier trop volumineux (max. 15 Mo)." });
        }
        return res.status(400).json({ error: err.message || "Erreur upload fichier" });
      }
      if (err?.message && err.message.includes("Type de fichier non autorisé")) {
        return res.status(400).json({ error: err.message });
      }
      console.error("Erreur POST /client-portal/tickets/:id/comments:", err);
      res.status(500).json({ error: "Erreur lors de l'envoi du message." });
    }
  }
);

router.patch(
  "/tickets/:id/comments/:commentId",
  [
    param("id").isUUID(),
    param("commentId").isUUID(),
    body("content").isString(),
  ],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    const ctx = await getPortalContext(req, res);
    if (!ctx) return;

    try {
      const comment = await updatePortalTicketComment({
        clientId: ctx.clientId,
        ticketId: req.params.id,
        userId: ctx.userId,
        commentId: req.params.commentId,
        content: req.body.content,
      });
      if (!comment) return res.status(404).json({ error: "Ticket introuvable." });
      res.json(comment);
    } catch (err) {
      if (err?.message === "EMPTY_COMMENT") {
        return res.status(400).json({
          error: "Le message ne peut pas être vide (texte ou pièce jointe requis).",
        });
      }
      if (err?.message === "NOT_AUTHOR") {
        return res.status(403).json({ error: "Vous ne pouvez modifier que vos propres messages." });
      }
      if (err?.message === "COMMENT_NOT_FOUND") {
        return res.status(404).json({ error: "Message introuvable." });
      }
      if (err?.message === "SYSTEM_COMMENT" || err?.message === "INVALID_CONTENT") {
        return res.status(400).json({ error: "Ce type de message ne peut pas être modifié." });
      }
      if (err?.message === "TICKET_LOCKED") {
        return res.status(409).json({
          error: "Ce ticket est terminé. Vous ne pouvez plus modifier vos messages.",
        });
      }
      if (err?.message === "UPDATED_AT_MIGRATION_REQUIRED") {
        return res.status(503).json({
          error: "La modification des messages est temporairement indisponible.",
        });
      }
      console.error("Erreur PATCH /client-portal/tickets/:id/comments/:commentId:", err);
      res.status(500).json({ error: "Erreur lors de la modification du message." });
    }
  }
);

router.post(
  "/tickets/:id/validate-resolution",
  [
    param("id").isUUID(),
    body("accepted").isBoolean(),
    body("message").optional().isString(),
  ],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    const ctx = await getPortalContext(req, res);
    if (!ctx) return;

    try {
      const result = await submitPortalResolutionValidation({
        clientId: ctx.clientId,
        ticketId: req.params.id,
        userId: ctx.userId,
        accepted: req.body.accepted === true,
        message: req.body.message,
      });
      if (!result) return res.status(404).json({ error: "Ticket introuvable." });

      const ticket = await getPortalTicketDetail(ctx.clientId, req.params.id);
      res.json({ ...result, ticket });
    } catch (err) {
      if (err?.message === "TICKET_NOT_AWAITING_VALIDATION") {
        return res.status(400).json({
          error: "Ce ticket n'est pas en attente de validation de votre part.",
        });
      }
      if (err?.message === "VALIDATION_NOT_PENDING") {
        return res.status(409).json({ error: "Vous avez déjà répondu à cette demande de validation." });
      }
      if (err?.message === "VALIDATION_UNAVAILABLE") {
        return res.status(503).json({ error: "Module de validation indisponible." });
      }
      if (err?.message === "FAILED_TO_CLOSE_TICKET") {
        return res.status(500).json({
          error: "La validation a été enregistrée mais le ticket n'a pas pu être clos. Réessayez ou contactez le support.",
        });
      }
      console.error("Erreur POST /client-portal/tickets/:id/validate-resolution:", err);
      res.status(500).json({ error: "Erreur lors de l'enregistrement de votre réponse." });
    }
  }
);

router.post(
  "/tickets/:id/satisfaction",
  [
    param("id").isUUID(),
    body("ratings").optional().isObject(),
    body("rating").optional().isInt({ min: 1, max: 5 }),
    body("message").optional().isString(),
  ],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    const ctx = await getPortalContext(req, res);
    if (!ctx) return;

    try {
      const satisfaction = await submitPortalTicketSatisfaction({
        clientId: ctx.clientId,
        ticketId: req.params.id,
        userId: ctx.userId,
        ratings: req.body.ratings,
        rating: req.body.rating,
        message: req.body.message,
      });
      if (!satisfaction) return res.status(404).json({ error: "Ticket introuvable." });
      res.status(201).json(satisfaction);
    } catch (err) {
      if (err?.message === "TICKET_NOT_CLOSED") {
        return res.status(400).json({
          error: "Vous ne pouvez laisser un retour que sur un ticket résolu ou clos.",
        });
      }
      if (err?.message === "VALIDATION_PENDING") {
        return res.status(400).json({
          error: "Validez d'abord la résolution proposée avant de laisser votre retour.",
        });
      }
      if (err?.message === "ALREADY_SUBMITTED") {
        return res.status(409).json({ error: "Un retour a déjà été enregistré pour ce ticket." });
      }
      if (err?.message === "INVALID_RATINGS" || err?.message === "INVALID_RATING") {
        return res.status(400).json({
          error: "Chaque critère doit être noté de 1 à 5 étoiles.",
        });
      }
      if (err?.message === "SATISFACTION_UNAVAILABLE") {
        return res.status(503).json({
          error:
            "Le module de satisfaction n'est pas activé. Exécutez : node scripts/run-ticket-satisfaction-migration.js",
        });
      }
      console.error("Erreur POST /client-portal/tickets/:id/satisfaction:", err);
      res.status(500).json({ error: "Erreur lors de l'enregistrement du retour." });
    }
  }
);

router.patch(
  "/tickets/:id/satisfaction",
  [
    param("id").isUUID(),
    body("ratings").optional().isObject(),
    body("rating").optional().isInt({ min: 1, max: 5 }),
    body("message").optional().isString(),
  ],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    const ctx = await getPortalContext(req, res);
    if (!ctx) return;

    try {
      const satisfaction = await updatePortalTicketSatisfaction({
        clientId: ctx.clientId,
        ticketId: req.params.id,
        userId: ctx.userId,
        ratings: req.body.ratings,
        rating: req.body.rating,
        message: req.body.message,
      });
      if (!satisfaction) return res.status(404).json({ error: "Ticket introuvable." });
      res.json(satisfaction);
    } catch (err) {
      if (err?.message === "TICKET_NOT_CLOSED") {
        return res.status(400).json({
          error: "Vous ne pouvez modifier un retour que sur un ticket résolu ou clos.",
        });
      }
      if (err?.message === "VALIDATION_PENDING") {
        return res.status(400).json({
          error: "Validez d'abord la résolution proposée avant de modifier votre retour.",
        });
      }
      if (err?.message === "NOT_FOUND") {
        return res.status(404).json({ error: "Aucun retour enregistré pour ce ticket." });
      }
      if (err?.message === "NOT_AUTHOR") {
        return res.status(403).json({ error: "Vous ne pouvez modifier que votre propre évaluation." });
      }
      if (err?.message === "INVALID_RATINGS" || err?.message === "INVALID_RATING") {
        return res.status(400).json({
          error: "Chaque critère doit être noté de 1 à 5 étoiles.",
        });
      }
      if (err?.message === "SATISFACTION_UNAVAILABLE") {
        return res.status(503).json({
          error: "Le module de satisfaction n'est pas activé.",
        });
      }
      console.error("Erreur PATCH /client-portal/tickets/:id/satisfaction:", err);
      res.status(500).json({ error: "Erreur lors de la mise à jour du retour." });
    }
  }
);

// ── Coffre-fort documentaire (portail client) ─────────────────────────
router.get(
  "/vault-files",
  [
    query("category").optional().isString(),
    query("search").optional().isString(),
    query("limit").optional().isInt({ min: 1, max: 500 }),
    query("offset").optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    const ctx = await getPortalContext(req, res);
    if (!ctx) return;

    try {
      const files = await listPortalVaultFiles(ctx.clientId, {
        category: req.query.category,
        search: req.query.search,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      const total = await countPortalVaultFiles(ctx.clientId, {
        category: req.query.category,
        search: req.query.search,
      });
      res.json({ files, total });
    } catch (err) {
      console.error("Erreur GET /client-portal/vault-files:", err);
      res.status(500).json({ error: "Erreur lors de la récupération des documents." });
    }
  }
);

router.get("/vault-files/:id/download", [param("id").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;

  const ctx = await getPortalContext(req, res);
  if (!ctx) return;

  try {
    const file = await getPortalVaultFileRecord(ctx.clientId, req.params.id);
    if (!file) return res.status(404).json({ error: "Document introuvable." });

    const fullPath = resolveClientFileDiskPath(file.file_path);
    if (!fullPath) return res.status(404).json({ error: "Fichier manquant sur le disque." });

    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(file.file_name)}"`
    );
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    console.error("Erreur GET /client-portal/vault-files/:id/download:", err);
    res.status(500).json({ error: "Erreur lors du téléchargement." });
  }
});

router.get("/vault-files/:id/preview", [param("id").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;

  const ctx = await getPortalContext(req, res);
  if (!ctx) return;

  try {
    const file = await getPortalVaultFileRecord(ctx.clientId, req.params.id);
    if (!file) return res.status(404).json({ error: "Document introuvable." });

    const fullPath = resolveClientFileDiskPath(file.file_path);
    if (!fullPath) return res.status(404).json({ error: "Fichier manquant sur le disque." });

    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(file.file_name)}"`
    );
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    console.error("Erreur GET /client-portal/vault-files/:id/preview:", err);
    res.status(500).json({ error: "Erreur lors de la prévisualisation." });
  }
});

// ── Accès / mots de passe partagés (portail client) ─────────────────
router.get("/vault-secrets", async (req, res) => {
  const ctx = await getPortalContext(req, res);
  if (!ctx) return;

  try {
    const secrets = await listPortalVaultSecrets(ctx.contactId);
    const total = await countPortalVaultSecrets(ctx.contactId);
    res.json({ secrets, total });
  } catch (err) {
    console.error("Erreur GET /client-portal/vault-secrets:", err);
    res.status(500).json({ error: "Erreur lors de la récupération des accès." });
  }
});

router.post("/vault-secrets/:id/reveal", [param("id").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;

  const ctx = await getPortalContext(req, res);
  if (!ctx) return;

  try {
    const revealed = await revealPortalVaultSecret(ctx.contactId, req.params.id);
    res.json(revealed);
  } catch (err) {
    console.error("Erreur POST /client-portal/vault-secrets/:id/reveal:", err);
    const code = String(err.code || "").toUpperCase();
    const status = code === "NOT_FOUND" ? 404 : code === "ACTIVE" ? 500 : 410;
    res.status(status === 410 ? 410 : status).json({
      error: err.message || "Impossible d'afficher cet accès.",
      code: code || "UNAVAILABLE",
    });
  }
});

router.post("/vault-secrets/:id/request-revocation", [param("id").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;

  const ctx = await getPortalContext(req, res);
  if (!ctx) return;

  try {
    const result = await requestPortalVaultSecretRevocation(
      ctx.contactId,
      req.params.id,
      ctx.userId
    );
    res.json(result);
  } catch (err) {
    console.error("Erreur POST /client-portal/vault-secrets/:id/request-revocation:", err);
    const status = err.message?.includes("introuvable") ? 404 : 400;
    res.status(status).json({ error: err.message || "Impossible de supprimer cet accès." });
  }
});

async function loadPortalContactForUser(contactId, clientId) {
  const { rows } = await pool.query(
    `SELECT id, nom, prenom, email, telephone,
            COALESCE(communications, '[]'::jsonb) AS communications
     FROM v_b_contacts
     WHERE id = $1 AND client_id = $2`,
    [contactId, clientId]
  );
  return hydratePortalContactRow(rows[0] || null);
}

function hydratePortalContactRow(row) {
  if (!row) return null;
  const synced = syncLegacyContactFields(normalizeContactCommunications(row));
  return {
    id: row.id,
    nom: row.nom,
    prenom: row.prenom,
    email: synced.email,
    telephone: synced.telephone,
    communications: synced.communications,
  };
}

// ── Fiche contact du client connecté ─────────────────────────────────
router.get("/contact", async (req, res) => {
  const ctx = await getPortalContext(req, res);
  if (!ctx) return;

  if (!ctx.contactId) {
    return res.status(404).json({ error: "Aucune fiche contact associée à ce compte." });
  }

  try {
    const contact = await loadPortalContactForUser(ctx.contactId, ctx.clientId);
    if (!contact) {
      return res.status(404).json({ error: "Contact introuvable." });
    }
    res.json({ contact });
  } catch (err) {
    console.error("Erreur GET /client-portal/contact:", err);
    res.status(500).json({ error: "Erreur lors de la récupération du contact." });
  }
});

router.patch(
  "/contact",
  [body("communications").isArray()],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    const ctx = await getPortalContext(req, res);
    if (!ctx) return;

    if (!ctx.contactId) {
      return res.status(404).json({ error: "Aucune fiche contact associée à ce compte." });
    }

    const commError = validateContactCommunications(req.body.communications);
    if (commError) {
      return res.status(400).json({ error: commError });
    }

    try {
      const current = await loadPortalContactForUser(ctx.contactId, ctx.clientId);
      if (!current) {
        return res.status(404).json({ error: "Contact introuvable." });
      }

      const synced = syncLegacyContactFields(req.body.communications);

      const result = await pool.query(
        `UPDATE v_b_contacts
         SET email = $1, telephone = $2, communications = $3::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4 AND client_id = $5
         RETURNING id, nom, prenom, email, telephone, communications`,
        [
          synced.email,
          synced.telephone,
          JSON.stringify(synced.communications),
          ctx.contactId,
          ctx.clientId,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Contact introuvable." });
      }

      const updated = hydratePortalContactRow(result.rows[0]);

      await syncPortalUserFromContact({
        ...updated,
        id: ctx.contactId,
        client_id: ctx.clientId,
        statut: "actif",
      });

      res.json({ contact: updated });
    } catch (err) {
      if (String(err.message || "").includes("déjà utilisé")) {
        return res.status(409).json({ error: err.message });
      }
      console.error("Erreur PATCH /client-portal/contact:", err);
      res.status(500).json({ error: "Erreur lors de la mise à jour du contact." });
    }
  }
);

export default router;
