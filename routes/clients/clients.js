import express from 'express';
import { pool } from '../../database/db.js';
import { transformClientModulesToFrontend } from '../../utils/transformClientModules.js';
import { buildEquipmentLogQuery } from '../../utils/equipmentLogs.js';
import { checkSslCertificate, isSslCheckStale, resolveSslCheckIntervalHours } from '../../utils/sslCertificateChecker.js';
import verifyJWT from '../../middleware/auth.js';
import { dispatchNotificationEvent } from "../../services/notificationDispatcher.js";
import { assertCommunityClientsLimit, assertCommunitySitesLimit, sendCommunityLimitError } from '../../utils/communityLimits.js';
import { registerClientMetaRoutes } from './clientMeta.js';
import { attachDeletionSummary, fetchDeletionSummaryByClientId, getClientDeletionStatus } from '../../utils/clientDeletionGuard.js';
import { createClientCustomEquipment, deleteClientCustomEquipment, listClientCustomEquipment, listEquipmentFamilies, updateClientCustomEquipment } from '../../utils/equipmentFamilies.js';
import { isCommunity } from '../../utils/edition.js';
import { requireProForClientInfra } from '../../middleware/clientInfraRoutes.js';
import { requirePermission, requireAnyPermission } from '../../middleware/permissions.js';
import { attachEquipmentCounts, fetchEquipmentCountsByClientId } from '../../utils/equipmentCountsByClient.js';
const router = express.Router();
router.use(requireProForClientInfra);
router.use(verifyJWT);
function normalizeClientNumber(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}
async function fetchTagsByClientId() {
  const byClientId = {};
  try {
    const result = await pool.query(`
      SELECT l.client_id::text AS client_id,
             t.id,
             t.label,
             t.color
      FROM v_b_client_tag_links l
      JOIN v_b_client_tags t ON t.id = l.tag_id
      ORDER BY t.label ASC
    `);
    for (const row of result.rows) {
      const clientId = String(row.client_id);
      if (!byClientId[clientId]) {
        byClientId[clientId] = [];
      }
      byClientId[clientId].push({
        id: row.id,
        label: row.label,
        color: row.color
      });
    }
  } catch (err) {
    if (err.code === "42P01") {
      console.warn("[client-tags] tables missing, tags skipped");
      return byClientId;
    }
    throw err;
  }
  return byClientId;
}
const attachClientTags = (clients, tagsByClientId = {}) => clients.map(client => ({
  ...client,
  tags: tagsByClientId[String(client.id)] || []
}));
function pickPrimaryContactFromRows(contacts) {
  if (!Array.isArray(contacts) || contacts.length === 0) return null;
  const principal = contacts.find(contact => String(contact.poste || "").toLowerCase().includes("principal"));
  if (principal) return principal;
  const active = contacts.find(contact => {
    const status = String(contact.statut || "").toLowerCase();
    return status.includes("actif") && !status.includes("inactif");
  });
  return active || contacts[0];
}
function formatPrimaryContactName(contact) {
  if (!contact) return null;
  const prenom = String(contact.prenom || "").trim();
  const nom = String(contact.nom || "").trim();
  if (prenom && nom) return `${prenom} ${nom}`;
  return nom || prenom || null;
}
async function fetchPrimaryContactsByClientId() {
  const byClientId = {};
  try {
    const result = await pool.query(`
      SELECT client_id::text AS client_id,
             nom,
             prenom,
             poste,
             statut
      FROM v_b_contacts
      ORDER BY client_id ASC, nom ASC, prenom ASC
    `);
    const grouped = {};
    for (const row of result.rows) {
      const clientId = String(row.client_id);
      if (!grouped[clientId]) grouped[clientId] = [];
      grouped[clientId].push(row);
    }
    for (const [clientId, contacts] of Object.entries(grouped)) {
      const primary = pickPrimaryContactFromRows(contacts);
      const name = formatPrimaryContactName(primary);
      if (name) byClientId[clientId] = name;
    }
  } catch (err) {
    if (err.code === "42P01") {
      console.warn("[client-contacts] table missing, contacts skipped");
      return byClientId;
    }
    throw err;
  }
  return byClientId;
}
const attachPrimaryContacts = (clients, primaryContactsByClientId = {}) => clients.map(client => ({
  ...client,
  primaryContactName: primaryContactsByClientId[String(client.id)] || null
}));
const enrichClientsListPayload = async clients => {
  const [countsByClientId, tagsByClientId, deletionByClientId, primaryContactsByClientId] = await Promise.all([fetchEquipmentCountsByClientId(), fetchTagsByClientId(), fetchDeletionSummaryByClientId(), fetchPrimaryContactsByClientId()]);
  return attachDeletionSummary(attachPrimaryContacts(attachClientTags(attachEquipmentCounts(clients, countsByClientId), tagsByClientId), primaryContactsByClientId), deletionByClientId);
};
const invalidateClientsListCache = () => {};
const MODULE_TABLES = {
  internet: "v_b_clients_m_internet",
  servers: "v_b_clients_m_servers",
  stockage: "v_b_clients_m_stockage",
  firewall: "v_b_clients_m_firewall",
  switch: "v_b_clients_m_switch",
  wifi: "v_b_clients_m_wifi",
  alimentation: "v_b_clients_m_alimentation",
  routeur: "v_b_clients_m_routeur",
  toip: "v_b_clients_m_toip",
  save: "v_b_clients_m_save",
  antivirus: "v_b_clients_m_antivirus",
  antispam: "v_b_clients_m_antispam",
  ndd: "v_b_clients_m_ndd",
  ssl: "v_b_clients_m_ssl",
  licences: "v_b_clients_m_licences",
  o365: "v_b_clients_m_o365",
  ordinateurs: "v_b_clients_m_ordinateurs"
};
async function resolveNumericClientId(id) {
  let clientId = id;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(String(id))) {
    const clientResult = await pool.query("SELECT id FROM v_b_clients WHERE id::text = $1", [id]);
    if (clientResult.rows.length === 0) return null;
    clientId = clientResult.rows[0].id;
  }
  clientId = parseInt(clientId, 10);
  if (Number.isNaN(clientId)) return null;
  return clientId;
}
function mapSslCertificateRow(row) {
  const data = row.data && typeof row.data === "object" ? row.data : {};
  const hostname = data.hostname || data.host || row.name || row.item_key || "—";
  const checkIntervalHours = resolveSslCheckIntervalHours(data);
  let nextCheckAt = null;
  if (data.lastChecked) {
    const last = new Date(data.lastChecked);
    if (!Number.isNaN(last.getTime())) {
      nextCheckAt = new Date(last.getTime() + checkIntervalHours * 3600000).toISOString();
    }
  }
  return {
    id: row.id,
    client_id: row.client_id,
    item_key: row.item_key,
    hostname,
    port: data.port || 443,
    subject: data.subject || null,
    subjectCN: data.subjectCN || null,
    subjectO: data.subjectO || null,
    issuer: data.issuer || null,
    issuerCN: data.issuerCN || null,
    issuerO: data.issuerO || null,
    expiration: data.expiration || null,
    daysRemaining: data.daysRemaining ?? null,
    validFrom: data.validFrom || null,
    lastChecked: data.lastChecked || null,
    nextCheckAt,
    checkIntervalHours,
    serialNumber: data.serialNumber || null,
    fingerprint: data.fingerprint || null,
    subjectAltNames: data.subjectAltNames || null,
    protocol: data.protocol || null,
    authorized: data.authorized ?? null,
    authorizationError: data.authorizationError || null,
    error: data.error || null,
    valid: data.valid !== false && !data.error,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
async function checkAndPersistSslRow(row) {
  const data = row.data && typeof row.data === "object" ? row.data : {};
  const hostname = data.hostname || data.host || row.name || row.item_key;
  const port = Number(data.port) || 443;
  if (!hostname) return null;
  let payload;
  try {
    payload = await checkSslCertificate(hostname, port);
  } catch (error) {
    payload = {
      hostname,
      port,
      valid: false,
      error: error.message || "Verification not possible",
      lastChecked: new Date().toISOString()
    };
  }
  const merged = {
    ...data,
    ...payload
  };
  if (data.checkIntervalHours != null) {
    merged.checkIntervalHours = resolveSslCheckIntervalHours(data);
  }
  const updateResult = await pool.query(`UPDATE v_b_clients_m_ssl
     SET data = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, client_id, item_key, name, data, is_active, created_at, updated_at`, [JSON.stringify(merged), row.id]);
  return updateResult.rows[0] ? mapSslCertificateRow(updateResult.rows[0]) : null;
}
function computeLicenceDaysRemaining(expiration) {
  if (!expiration) return null;
  const expiry = new Date(expiration);
  if (Number.isNaN(expiry.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expiry.setHours(0, 0, 0, 0);
  return Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
}
function mapLicenceRow(row) {
  const data = row.data && typeof row.data === "object" ? row.data : {};
  const nom = String(data.nom || data.name || row.name || row.item_key || "").trim();
  const expiration = data.expiration || null;
  return {
    id: row.id,
    client_id: row.client_id,
    nom,
    name: nom,
    expiration,
    fournisseur: data.fournisseur || data.vendor || null,
    notes: data.notes || data.note || null,
    daysRemaining: computeLicenceDaysRemaining(expiration),
    is_active: row.is_active !== false,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
const CYBER_MODULE_TABLES = {
  antivirus: "v_b_clients_m_antivirus",
  antispam: "v_b_clients_m_antispam",
  save: "v_b_clients_m_save"
};
function parseModuleRowForCyber(row, table) {
  let parsedData = row.data;
  if (row.data && typeof row.data === "string") {
    try {
      parsedData = JSON.parse(row.data);
    } catch {
      parsedData = {};
    }
  } else if (!row.data) {
    parsedData = {};
  }
  const baseRow = {
    id: row.id,
    item_key: row.item_key,
    name: row.name,
    is_active: row.is_active,
    data: parsedData,
    created_at: row.created_at,
    updated_at: row.updated_at,
    checkmk_host_name: row.checkmk_host_name ?? null,
    checkmk_site: row.checkmk_site ?? null,
    checkmk_service_name: row.checkmk_service_name ?? null
  };
  if (table === "v_b_clients_m_save") {
    const rawDate = row.last_backup_date;
    baseRow.last_backup_date = rawDate != null ? rawDate instanceof Date ? rawDate.toISOString() : String(rawDate) : null;
    baseRow.last_backup_duration = row.last_backup_duration != null ? String(row.last_backup_duration) : null;
    const rawStart = row.last_backup_start;
    baseRow.last_backup_start = rawStart != null ? rawStart instanceof Date ? rawStart.toISOString() : String(rawStart) : null;
  }
  return baseRow;
}
async function queryCyberFamilyRows(pool, table, clientIds) {
  if (!clientIds.length) return [];
  const baseSelect = `SELECT client_id, id, item_key, name, data, is_active, created_at, updated_at, checkmk_host_name, checkmk_site, checkmk_service_name`;
  const saveExtraSelect = table === "v_b_clients_m_save" ? ", last_backup_date, last_backup_duration, last_backup_start" : "";
  try {
    const result = await pool.query(`${baseSelect}${saveExtraSelect}
       FROM ${table}
       WHERE client_id = ANY($1::int[])
       ORDER BY client_id, name NULLS LAST, item_key NULLS LAST`, [clientIds]);
    return result.rows;
  } catch (colErr) {
    if (colErr.code === "42703") {
      const result = await pool.query(`SELECT client_id, id, item_key, name, data, is_active, created_at, updated_at
         FROM ${table}
         WHERE client_id = ANY($1::int[])
         ORDER BY client_id, name NULLS LAST, item_key NULLS LAST`, [clientIds]);
      result.rows.forEach(r => {
        r.checkmk_host_name = null;
        r.checkmk_site = null;
        r.checkmk_service_name = null;
        if (table === "v_b_clients_m_save") {
          r.last_backup_date = null;
          r.last_backup_duration = null;
          r.last_backup_start = null;
        }
      });
      return result.rows;
    }
    if (colErr.code === "42P01") {
      return [];
    }
    throw colErr;
  }
}
const getFieldNameFromUpdate = field => {
  if (!field) return null;
  return field.split('=')[0].trim();
};
const buildChanges = (modifiedFields, valueMap) => modifiedFields.map(field => ({
  field,
  newValue: valueMap[field] !== undefined ? valueMap[field] : null
}));
async function getClientSnapshotForNotification(clientId) {
  const preferredColumns = ["id", "name", "client_number", "email", "phone", "address", "siret", "secteur", "commercial_id", "contrat", "options", "modules", "sites", "office365_data"];
  try {
    const result = await pool.query(`SELECT ${preferredColumns.join(", ")}
       FROM v_b_clients
       WHERE id::text = $1
       LIMIT 1`, [String(clientId || "")]);
    return result.rows?.[0] || null;
  } catch (error) {
    if (error?.code !== "42703") throw error;
    const columnsResult = await pool.query(`SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'v_b_clients'`);
    const availableColumns = new Set(columnsResult.rows.map(row => String(row.column_name || "").trim()));
    const selectedColumns = preferredColumns.filter(column => availableColumns.has(column));
    if (!selectedColumns.includes("id")) {
      selectedColumns.unshift("id");
    }
    const safeResult = await pool.query(`SELECT ${selectedColumns.join(", ")}
       FROM v_b_clients
       WHERE id::text = $1
       LIMIT 1`, [String(clientId || "")]);
    return safeResult.rows?.[0] || null;
  }
}
function stringifyComparable(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return String(value);
    }
  }
  return String(value);
}
function buildNotificationChanges(previousSnapshot = {}, changedFields = [], nextValueMap = {}) {
  const changes = [];
  for (const field of changedFields) {
    const oldValue = previousSnapshot?.[field] ?? null;
    const newValue = nextValueMap?.[field] ?? null;
    if (stringifyComparable(oldValue) === stringifyComparable(newValue)) continue;
    changes.push({
      field,
      oldValue,
      newValue
    });
  }
  return changes;
}
let clientsColumnsCache = null;
async function getClientsAvailableColumns() {
  if (clientsColumnsCache instanceof Set && clientsColumnsCache.size > 0) {
    return clientsColumnsCache;
  }
  const columnsResult = await pool.query(`SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'v_b_clients'`);
  clientsColumnsCache = new Set(columnsResult.rows.map(row => String(row.column_name || "").trim()));
  return clientsColumnsCache;
}
function resolveClientSsidColumn(hasClientColumn) {
  if (hasClientColumn("ssid")) return "ssid";
  if (hasClientColumn("ssids")) return "ssids";
  return null;
}
function appendClientSsidUpdate({
  ssid,
  ssids,
  hasClientColumn,
  updateFields,
  updateValues,
  paramIndex
}) {
  if (ssid === undefined && ssids === undefined) return paramIndex;
  const column = resolveClientSsidColumn(hasClientColumn);
  if (!column) return paramIndex;
  const payload = ssids !== undefined ? ssids : ssid;
  updateFields.push(`${column} = $${paramIndex}`);
  updateValues.push(JSON.stringify(Array.isArray(payload) ? payload : []));
  return paramIndex + 1;
}
const CLIENTS_LIST_SELECT_COLUMNS = ["id", "name", "client_number", "address", "siret", "secteur", "contrat", "options", "modules", "commercial_id", "created_at", "updated_at"];
async function queryClientsListBaseRows() {
  const available = await getClientsAvailableColumns();
  const clientCols = CLIENTS_LIST_SELECT_COLUMNS.filter(col => available.has(col));
  if (!clientCols.includes("id")) {
    clientCols.unshift("id");
  }
  const selectList = clientCols.map(col => `c.${col}`).join(",\n        ");
  return pool.query(`
      SELECT
        ${selectList},
        u.username,
        u.email AS user_email,
        (SELECT EXISTS (SELECT 1 FROM v_b_clients_azure a WHERE a.client_id = c.id)) AS has_azure_credentials,
        (SELECT EXISTS (
          SELECT 1 FROM v_b_clients_m_o365 o WHERE o.client_id = c.id
        )) AS has_o365_equipment,
        (SELECT EXISTS (
          SELECT 1 FROM v_b_clients_m_ndd n WHERE n.client_id = c.id
        )) AS has_ndd_equipment
      FROM v_b_clients c
      LEFT JOIN v_b_users u ON c.commercial_id::text = u.id::text
      ORDER BY c.name ASC
    `);
}
function mapClientsListRow(row) {
  const {
    has_azure_credentials: hasAzureCredentials,
    has_o365_equipment: hasO365Equipment,
    has_ndd_equipment: hasNddEquipment,
    ...client
  } = row;
  let options = client.options || {};
  if (typeof options === "string") {
    try {
      options = JSON.parse(options);
    } catch {
      options = {};
    }
  }
  let contrat = client.contrat || {};
  if (typeof contrat === "string") {
    try {
      contrat = JSON.parse(contrat);
    } catch {
      contrat = {};
    }
  }
  let modules = client.modules || {};
  if (typeof modules === "string") {
    try {
      modules = JSON.parse(modules);
    } catch {
      modules = {};
    }
  }
  if (!modules || typeof modules !== "object") {
    modules = {};
  }
  if (hasAzureCredentials || hasO365Equipment) {
    modules = {
      ...modules,
      Office365: true
    };
  }
  if (hasNddEquipment) {
    modules = {
      ...modules,
      NDD: true
    };
  }
  return {
    ...client,
    client_number: client.client_number ?? null,
    options,
    contrat,
    modules,
    email: null,
    phone: null,
    sites: [],
    commercial: client.username || client.user_email || null
  };
}
async function logClientUpdate({
  req,
  updateFields,
  valueMap
}) {
  try {
    let clientId = req.params.id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(req.params.id)) {
      const clientResult = await pool.query('SELECT id FROM v_b_clients WHERE id::text = $1', [req.params.id]);
      if (clientResult.rows.length > 0) {
        clientId = clientResult.rows[0].id;
        console.log(`🔄 PUT general logs: UUID conversion ${req.params.id} → numeric ID ${clientId}`);
      }
    }
    if (isNaN(parseInt(clientId))) {
      console.error(`❌ PUT general logs: clientId is not a number: ${clientId} (type: ${typeof clientId})`);
      return;
    }
    const rawUserId = req.user?.id || req.user?.user_id || null;
    const uuidRegexUser = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const userId = rawUserId && uuidRegexUser.test(String(rawUserId)) ? String(rawUserId) : null;
    const modifiedFields = updateFields.map(getFieldNameFromUpdate).filter(Boolean).filter(field => field !== 'updated_at');
    const action = 'Client update';
    const details = {
      modifiedFields,
      changes: buildChanges(modifiedFields, valueMap)
    };
    await pool.query(`INSERT INTO v_b_clients_logs
       (client_id, user_id, action, details)
       VALUES ($1, $2, $3, $4)`, [clientId, userId, action, JSON.stringify(details)]);
  } catch (logError) {
    console.warn('Error writing log:', logError);
  }
}
router.get('/', requirePermission('clients.view'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, u.username, u.email as user_email
      FROM v_b_clients c
      LEFT JOIN v_b_users u ON c.commercial_id::text = u.id::text
    `);
    const clientsWithCommercial = result.rows.map(client => ({
      ...client,
      commercial: client.username || client.user_email || null
    }));
    res.json(clientsWithCommercial);
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message,
      code: err.code
    });
  }
});
router.get('/list', requirePermission('clients.view'), async (req, res) => {
  try {
    const result = await queryClientsListBaseRows();
    const payload = result.rows.map(mapClientsListRow);
    const enriched = await enrichClientsListPayload(payload);
    res.set('Cache-Control', 'no-store');
    return res.json(enriched);
  } catch (err) {
    console.error("[GET /clients/list]", err.message, err.code || "");
    return res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message,
      code: err.code
    });
  }
});
router.get("/equipment-counts", async (req, res) => {
  try {
    const byClientId = await fetchEquipmentCountsByClientId();
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    return res.json({
      byClientId
    });
  } catch (err) {
    console.error("[GET /equipment-counts]", err);
    return res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message,
      code: err.code
    });
  }
});
router.get("/cyber-page-data", verifyJWT, async (req, res) => {
  try {
    const clientsResult = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.client_number,
        c.address,
        c.siret,
        c.secteur,
        c.contrat,
        c.options,
        c.modules,
        c.commercial_id,
        c.created_at,
        c.updated_at,
        u.username,
        u.email AS user_email,
        (SELECT EXISTS (SELECT 1 FROM v_b_clients_azure a WHERE a.client_id = c.id)) AS has_azure_credentials,
        (SELECT EXISTS (
          SELECT 1 FROM v_b_clients_m_o365 o WHERE o.client_id = c.id
        )) AS has_o365_equipment,
        (SELECT EXISTS (
          SELECT 1 FROM v_b_clients_m_ndd n WHERE n.client_id = c.id
        )) AS has_ndd_equipment
      FROM v_b_clients c
      LEFT JOIN v_b_users u ON c.commercial_id::text = u.id::text
      ORDER BY c.name ASC
    `);
    const clientIds = clientsResult.rows.map(r => r.id).filter(id => id != null);
    const [avRows, asRows, svRows, campaignsResult] = await Promise.all([queryCyberFamilyRows(pool, CYBER_MODULE_TABLES.antivirus, clientIds), queryCyberFamilyRows(pool, CYBER_MODULE_TABLES.antispam, clientIds), queryCyberFamilyRows(pool, CYBER_MODULE_TABLES.save, clientIds), pool.query(`
      SELECT
        c.id, c.client_id, c.name, c.type, c.status, c.start_date, c.end_date,
        c.global_progress, c.description, c.objectif_adoption, c.created_at, c.updated_at, c.created_by,
        c.updated_by,
        cl.name as client_name
      FROM v_b_clients_c_campaign c
      LEFT JOIN v_b_clients cl ON c.client_id::text = cl.id::text
      ORDER BY c.created_at DESC
    `).catch(e => {
      if (e.code === "42P01") return {
        rows: []
      };
      throw e;
    })]);
    const rowsByClient = new Map();
    for (const id of clientIds) {
      rowsByClient.set(Number(id), {
        antivirus: [],
        antispam: [],
        save: []
      });
    }
    const pushRows = (rows, family, table) => {
      for (const row of rows) {
        const cid = Number(row.client_id);
        if (!rowsByClient.has(cid)) {
          rowsByClient.set(cid, {
            antivirus: [],
            antispam: [],
            save: []
          });
        }
        rowsByClient.get(cid)[family].push(parseModuleRowForCyber(row, table));
      }
    };
    pushRows(avRows, "antivirus", CYBER_MODULE_TABLES.antivirus);
    pushRows(asRows, "antispam", CYBER_MODULE_TABLES.antispam);
    pushRows(svRows, "save", CYBER_MODULE_TABLES.save);
    const azureByClient = new Map();
    if (clientIds.length) {
      try {
        const az = await pool.query(`SELECT DISTINCT client_id FROM v_b_clients_azure WHERE client_id = ANY($1::int[])`, [clientIds]);
        az.rows.forEach(r => azureByClient.set(Number(r.client_id), true));
      } catch {}
    }
    const clientsPayload = clientsResult.rows.map(row => {
      const {
        has_azure_credentials: hasAzureCredentials,
        has_o365_equipment: hasO365Equipment,
        has_ndd_equipment: hasNddEquipment,
        ...client
      } = row;
      let options = client.options || {};
      if (typeof options === "string") {
        try {
          options = JSON.parse(options);
        } catch {
          options = {};
        }
      }
      let contrat = client.contrat || {};
      if (typeof contrat === "string") {
        try {
          contrat = JSON.parse(contrat);
        } catch {
          contrat = {};
        }
      }
      let modules = client.modules || {};
      if (typeof modules === "string") {
        try {
          modules = JSON.parse(modules);
        } catch {
          modules = {};
        }
      }
      if (!modules || typeof modules !== "object") {
        modules = {};
      }
      if (hasAzureCredentials || hasO365Equipment) {
        modules = {
          ...modules,
          Office365: true
        };
      }
      if (hasNddEquipment) {
        modules = {
          ...modules,
          NDD: true
        };
      }
      const cid = Number(client.id);
      const raw = rowsByClient.get(cid) || {
        antivirus: [],
        antispam: [],
        save: []
      };
      const azureHasCredentials = !!azureByClient.get(cid);
      const transformed = transformClientModulesToFrontend({
        antivirus: raw.antivirus,
        antispam: raw.antispam,
        save: raw.save
      }, {
        azureHasCredentials
      });
      return {
        ...client,
        options,
        contrat,
        modules,
        email: null,
        phone: null,
        sites: [],
        commercial: client.username || client.user_email || null,
        equipements: transformed.equipements || {},
        modules_monitoring: {}
      };
    });
    res.json({
      clients: clientsPayload,
      campaigns: campaignsResult.rows || []
    });
  } catch (err) {
    console.error("GET /cyber-page-data:", err);
    res.status(500).json({
      error: "Error loading cybersecurity data",
      details: err.message,
      code: err.code
    });
  }
});
router.get('/general', requirePermission('clients.view'), async (req, res) => {
  try {
    const clientsResult = await pool.query(`
      SELECT c.*, u.username, u.email as user_email
      FROM v_b_clients c
      LEFT JOIN v_b_users u ON c.commercial_id::text = u.id::text
      ORDER BY c.name
    `);
    const clients = clientsResult.rows;
    const clientsWithModules = await Promise.all(clients.map(async client => {
      let equipements = {};
      if (!isCommunity()) {
        try {
          const rawModulesData = {};
          for (const [family, table] of Object.entries(MODULE_TABLES)) {
            try {
              let result;
              const baseSelect = `SELECT id, item_key, name, data, is_active, created_at, updated_at, checkmk_host_name, checkmk_site, checkmk_service_name`;
              const saveExtraSelect = table === 'v_b_clients_m_save' ? ', last_backup_date, last_backup_duration, last_backup_start' : '';
              try {
                result = await pool.query(`${baseSelect}${saveExtraSelect}
                     FROM ${table}
                     WHERE client_id = $1
                     ORDER BY name NULLS LAST, item_key NULLS LAST`, [client.id]);
              } catch (colErr) {
                if (colErr.code === '42703') {
                  result = await pool.query(`SELECT id, item_key, name, data, is_active, created_at, updated_at
                       FROM ${table}
                       WHERE client_id = $1
                       ORDER BY name NULLS LAST, item_key NULLS LAST`, [client.id]);
                  result.rows.forEach(r => {
                    r.checkmk_host_name = null;
                    r.checkmk_site = null;
                    r.checkmk_service_name = null;
                    if (table === 'v_b_clients_m_save') {
                      r.last_backup_date = null;
                      r.last_backup_duration = null;
                      r.last_backup_start = null;
                    }
                  });
                } else throw colErr;
              }
              const parsedRows = result.rows.map(row => {
                if (row.data && typeof row.data === 'string') {
                  try {
                    row.data = JSON.parse(row.data);
                  } catch (e) {
                    row.data = {};
                  }
                } else if (!row.data) {
                  row.data = {};
                }
                return row;
              });
              rawModulesData[family] = parsedRows;
            } catch (err) {
              if (err.code === '42P01') {
                rawModulesData[family] = [];
              } else {
                throw err;
              }
            }
          }
          let azureHasCredentials = false;
          try {
            const azureResult = await pool.query("SELECT 1 FROM v_b_clients_azure WHERE client_id = $1 LIMIT 1", [client.id]);
            azureHasCredentials = azureResult.rows.length > 0;
          } catch (azureErr) {}
          const transformed = transformClientModulesToFrontend(rawModulesData, {
            azureHasCredentials
          });
          equipements = transformed.equipements || {};
        } catch (error) {
          return client;
        }
      }
      try {
        let parsedSites = client.sites;
        if (parsedSites && typeof parsedSites === 'string') {
          try {
            parsedSites = JSON.parse(parsedSites);
          } catch (e) {
            parsedSites = [];
          }
        }
        let parsedSSID = client.ssid || client.ssids;
        if (parsedSSID && typeof parsedSSID === 'string') {
          try {
            parsedSSID = JSON.parse(parsedSSID);
          } catch (e) {
            parsedSSID = [];
          }
        }
        let clientOptions = client.options || {};
        if (clientOptions && typeof clientOptions === 'string') {
          try {
            clientOptions = JSON.parse(clientOptions);
          } catch (e) {
            clientOptions = {};
          }
        }
        let clientModulesMonitoring = isCommunity() ? {} : client.modules || {};
        if (!isCommunity() && clientModulesMonitoring && typeof clientModulesMonitoring === 'string') {
          try {
            clientModulesMonitoring = JSON.parse(clientModulesMonitoring);
          } catch (e) {
            clientModulesMonitoring = {};
          }
        }
        let contratData = client.contrat;
        if (contratData && typeof contratData === 'string') {
          try {
            contratData = JSON.parse(contratData);
          } catch (e) {
            contratData = {};
          }
        }
        const commercial = client.username || client.user_email || null;
        return {
          ...client,
          commercial,
          options: clientOptions,
          modules: clientOptions,
          modules_monitoring: clientModulesMonitoring || {},
          equipements,
          sites: parsedSites || [],
          ssid: parsedSSID || [],
          ssids: parsedSSID || [],
          contrat: contratData
        };
      } catch (error) {
        return client;
      }
    }));
    res.json(clientsWithModules);
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message,
      code: err.code
    });
  }
});
router.get('/:id/modules', async (req, res) => {
  const {
    id
  } = req.params;
  try {
    const payload = {};
    for (const [family, table] of Object.entries(MODULE_TABLES)) {
      try {
        let result;
        const baseSelect = `SELECT id, item_key, name, data, is_active, created_at, updated_at, checkmk_host_name, checkmk_site, checkmk_service_name`;
        const saveExtraSelect = table === 'v_b_clients_m_save' ? ', last_backup_date, last_backup_duration, last_backup_start' : '';
        try {
          result = await pool.query(`${baseSelect}${saveExtraSelect}
             FROM ${table}
             WHERE client_id = $1
             ORDER BY name NULLS LAST, item_key NULLS LAST`, [id]);
        } catch (colErr) {
          if (colErr.code === '42703') {
            result = await pool.query(`SELECT id, item_key, name, data, is_active, created_at, updated_at
               FROM ${table}
               WHERE client_id = $1
               ORDER BY name NULLS LAST, item_key NULLS LAST`, [id]);
            result.rows.forEach(r => {
              r.checkmk_host_name = null;
              r.checkmk_site = null;
              r.checkmk_service_name = null;
              if (table === 'v_b_clients_m_save') {
                r.last_backup_date = null;
                r.last_backup_duration = null;
                r.last_backup_start = null;
              }
            });
          } else throw colErr;
        }
        const parsedRows = result.rows.map(row => {
          let parsedData = row.data;
          if (row.data && typeof row.data === 'string') {
            try {
              parsedData = JSON.parse(row.data);
            } catch (e) {
              parsedData = {};
            }
          } else if (!row.data) {
            parsedData = {};
          }
          const baseRow = {
            id: row.id,
            item_key: row.item_key,
            name: row.name,
            is_active: row.is_active,
            data: parsedData,
            created_at: row.created_at,
            updated_at: row.updated_at,
            checkmk_host_name: row.checkmk_host_name ?? null,
            checkmk_site: row.checkmk_site ?? null,
            checkmk_service_name: row.checkmk_service_name ?? null
          };
          if (table === 'v_b_clients_m_save') {
            const rawDate = row.last_backup_date;
            baseRow.last_backup_date = rawDate != null ? rawDate instanceof Date ? rawDate.toISOString() : String(rawDate) : null;
            baseRow.last_backup_duration = row.last_backup_duration != null ? String(row.last_backup_duration) : null;
            const rawStart = row.last_backup_start;
            baseRow.last_backup_start = rawStart != null ? rawStart instanceof Date ? rawStart.toISOString() : String(rawStart) : null;
          }
          return baseRow;
        });
        payload[family] = parsedRows;
      } catch (err) {
        if (err.code === '42P01') {
          payload[family] = [];
        } else {
          console.error(`Error pour ${family}:`, err);
          payload[family] = [];
        }
      }
    }
    let azureHasCredentials = false;
    try {
      const azureResult = await pool.query("SELECT 1 FROM v_b_clients_azure WHERE client_id = $1 LIMIT 1", [id]);
      azureHasCredentials = azureResult.rows.length > 0;
    } catch (azureErr) {
      azureHasCredentials = false;
    }
    const transformed = transformClientModulesToFrontend(payload, {
      azureHasCredentials
    });
    res.json({
      modules: transformed.modules || {},
      modules_monitoring: transformed.modules_monitoring || {},
      equipements: transformed.equipements || {},
      azureHasCredentials
    });
  } catch (err) {
    console.error('Error /:id/modules:', err);
    res.status(500).json({
      error: "Error loading modules",
      details: err.message
    });
  }
});
router.get('/general/:id', async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const result = await pool.query(`
      SELECT c.*, u.username, u.email as user_email
      FROM v_b_clients c
      LEFT JOIN v_b_users u ON c.commercial_id::text = u.id::text
      WHERE c.id = $1
    `, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const client = result.rows[0];
    if (client.sites) {
      if (typeof client.sites === 'string') {
        try {
          client.sites = JSON.parse(client.sites);
        } catch (e) {
          client.sites = [];
        }
      }
    } else {
      client.sites = [];
    }
    if (client.ssids) {
      if (typeof client.ssids === 'string') {
        try {
          client.ssids = JSON.parse(client.ssids);
        } catch (e) {
          client.ssids = [];
        }
      }
    } else if (client.ssid) {
      if (typeof client.ssid === 'string') {
        try {
          client.ssids = JSON.parse(client.ssid);
        } catch (e) {
          client.ssids = [];
        }
      } else if (Array.isArray(client.ssid)) {
        client.ssids = client.ssid;
      } else {
        client.ssids = [];
      }
    } else {
      client.ssids = [];
    }
    client.commercial = client.username || client.user_email || null;
    res.json(client);
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message,
      code: err.code
    });
  }
});
router.post('/:id/logs', verifyJWT, async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const {
      action,
      details
    } = req.body;
    if (!action) {
      return res.status(400).json({
        error: 'action field is required'
      });
    }
    let clientId = id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(id)) {
      const clientResult = await pool.query('SELECT id FROM v_b_clients WHERE id::text = $1', [id]);
      if (clientResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Client not found'
        });
      }
      clientId = clientResult.rows[0].id;
      console.log(`🔄 POST logs: UUID conversion ${id} → numeric ID ${clientId}`);
    }
    if (isNaN(parseInt(clientId))) {
      console.error(`❌ POST logs: clientId n'est pas un nombre: ${clientId} (type: ${typeof clientId})`);
      return res.status(400).json({
        error: 'Invalid ID client'
      });
    }
    const rawUserId = req.user?.id || req.user?.user_id || null;
    const uuidRegexUser = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const userId = rawUserId && uuidRegexUser.test(String(rawUserId)) ? String(rawUserId) : null;
    await pool.query(`INSERT INTO v_b_clients_logs
       (client_id, user_id, action, details)
       VALUES ($1, $2, $3, $4)`, [clientId, userId, action, JSON.stringify(details || {})]);
    res.json({
      success: true
    });
  } catch (error) {
    console.error('Error creating log:', error);
    res.status(500).json({
      error: 'Error creating log'
    });
  }
});
router.get('/:id/logs', async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    let clientId = id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(id)) {
      const clientResult = await pool.query('SELECT id FROM v_b_clients WHERE id::text = $1', [id]);
      if (clientResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Client not found'
        });
      }
      clientId = clientResult.rows[0].id;
      console.log(`🔄 GET logs: UUID conversion ${id} → numeric ID ${clientId}`);
    }
    if (isNaN(parseInt(clientId))) {
      console.error(`❌ GET logs: clientId n'est pas un nombre: ${clientId} (type: ${typeof clientId})`);
      return res.status(400).json({
        error: 'Invalid ID client'
      });
    }
    const result = await pool.query(`SELECT
        l.id,
        l.client_id,
        l.user_id,
        COALESCE(u.username, u.email) AS user_name,
        l.action,
        l.details,
        l.created_at
       FROM v_b_clients_logs l
       LEFT JOIN v_b_users u ON l.user_id::text = u.id::text
       WHERE l.client_id = $1
       ORDER BY l.created_at DESC
       LIMIT $2 OFFSET $3`, [clientId, limit, offset]);
    const countResult = await pool.query(`SELECT COUNT(*) as total
       FROM v_b_clients_logs
       WHERE client_id = $1`, [clientId]);
    const total = parseInt(countResult.rows[0].total) || 0;
    res.json({
      logs: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Error fetching client logs:', err);
    res.status(500).json({
      error: "Error retrieving logs",
      details: err.message
    });
  }
});
router.get('/:id/antivirus', async (req, res) => {
  try {
    const {
      id
    } = req.params;
    let clientId = id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(id)) {
      const clientResult = await pool.query('SELECT id FROM v_b_clients WHERE id::text = $1', [id]);
      if (clientResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Client not found'
        });
      }
      clientId = clientResult.rows[0].id;
      console.log(`🔄 GET antivirus: UUID conversion ${id} → numeric ID ${clientId}`);
    }
    if (isNaN(parseInt(clientId))) {
      console.error(`❌ GET antivirus: clientId n'est pas un nombre: ${clientId} (type: ${typeof clientId})`);
      return res.status(400).json({
        error: 'Invalid ID client'
      });
    }
    const result = await pool.query(`SELECT id, client_id, item_key, data, created_at, updated_at
       FROM v_b_clients_m_antivirus
       WHERE client_id = $1
       ORDER BY created_at DESC`, [clientId]);
    const antivirusData = result.rows.map(row => {
      const data = row.data || {};
      return {
        id: row.id,
        client_id: row.client_id,
        item_key: row.item_key,
        nom: data.solution || data.nom || data.name || 'N/A',
        solution: data.solution || data.nom || data.name || 'N/A',
        utilisateurs: data.licencesUtilisees || data.syncData?.license?.usedLicenses || 'N/A',
        nombre_utilisateurs: data.licencesUtilisees || data.syncData?.license?.usedLicenses || 'N/A',
        licences: data.licencesTotales || data.syncData?.license?.totalLicenses || 'N/A',
        nombre_licences: data.licencesTotales || data.syncData?.license?.totalLicenses || 'N/A',
        expiration: data.expiration || data.syncData?.license?.expirationDate || null,
        expirityDate: data.expiration || data.syncData?.license?.expirationDate || null,
        endpointsTotal: data.endpoints?.total || data.syncData?.endpoints?.total || 'N/A',
        endpointsManaged: data.endpoints?.managed || data.syncData?.endpoints?.managed || 'N/A',
        companyName: data.companyName || data.syncData?.company?.name || 'N/A',
        companyId: data.companyId || data.syncData?.company?.id || null,
        mappingMode: data.mappingMode || 'reseller',
        bitdefenderTenantId: data.bitdefenderTenantId || null,
        created_at: row.created_at,
        updated_at: row.updated_at
      };
    });
    res.json(antivirusData);
  } catch (err) {
    console.error('Error fetching client antivirus data:', err);
    res.status(500).json({
      error: "Error retrieving antivirus data",
      details: err.message,
      code: err.code
    });
  }
});
router.get('/:id/o365', async (req, res) => {
  try {
    const {
      id
    } = req.params;
    let clientId = id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(id)) {
      const clientResult = await pool.query('SELECT id FROM v_b_clients WHERE id::text = $1', [id]);
      if (clientResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Client not found'
        });
      }
      clientId = clientResult.rows[0].id;
      console.log(`🔄 GET o365: UUID conversion ${id} → numeric ID ${clientId}`);
    }
    if (isNaN(parseInt(clientId))) {
      console.error(`❌ GET o365: clientId n'est pas un nombre: ${clientId} (type: ${typeof clientId})`);
      return res.status(400).json({
        success: false,
        error: 'Invalid ID client'
      });
    }
    const result = await pool.query(`SELECT id, client_id, item_key, name, data, is_active, created_at, updated_at
       FROM v_b_clients_m_o365
       WHERE client_id = $1
       ORDER BY updated_at DESC, created_at DESC`, [clientId]);
    const rows = result.rows.map(row => {
      let parsedData = row.data;
      if (parsedData && typeof parsedData === 'string') {
        try {
          parsedData = JSON.parse(parsedData);
        } catch (e) {
          parsedData = {};
        }
      } else if (!parsedData) {
        parsedData = {};
      }
      return {
        ...row,
        data: parsedData
      };
    });
    return res.json({
      success: true,
      data: rows
    });
  } catch (err) {
    console.error('Error fetching client Office 365 data:', err);
    return res.status(500).json({
      success: false,
      error: "Error retrieving Office 365 data",
      details: err.message,
      code: err.code
    });
  }
});
router.get('/:id/antispam', async (req, res) => {
  try {
    const {
      id
    } = req.params;
    let clientId = id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(id)) {
      const clientResult = await pool.query('SELECT id FROM v_b_clients WHERE id::text = $1', [id]);
      if (clientResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Client not found'
        });
      }
      clientId = clientResult.rows[0].id;
      console.log(`🔄 GET antispam: UUID conversion ${id} → numeric ID ${clientId}`);
    }
    if (isNaN(parseInt(clientId))) {
      console.error(`❌ GET antispam: clientId n'est pas un nombre: ${clientId} (type: ${typeof clientId})`);
      return res.status(400).json({
        error: 'Invalid ID client'
      });
    }
    const result = await pool.query(`SELECT id, client_id, item_key, data, created_at, updated_at
       FROM v_b_clients_m_antispam
       WHERE client_id = $1
       ORDER BY created_at DESC`, [clientId]);
    const antispamData = result.rows.map(row => {
      const data = row.data || {};
      return {
        id: row.id,
        client_id: row.client_id,
        item_key: row.item_key,
        nom: data.logiciel || data.nom || data.name || data.solution || 'N/A',
        solution: data.logiciel || data.nom || data.name || data.solution || 'N/A',
        utilisateurs: data.utilisateursProteges || data.utilisateurs || data.nombre_utilisateurs || 'N/A',
        nombre_utilisateurs: data.utilisateursProteges || data.utilisateurs || data.nombre_utilisateurs || 'N/A',
        licences: data.domainesSurveilles || data.licences || data.nombre_licences || 'N/A',
        nombre_licences: data.domainesSurveilles || data.licences || data.nombre_licences || 'N/A',
        expiration: data.expiration || data.expirityDate || null,
        expirityDate: data.expiration || data.expirityDate || null,
        created_at: row.created_at,
        updated_at: row.updated_at
      };
    });
    res.json(antispamData);
  } catch (err) {
    console.error('Error fetching client antispam data:', err);
    res.status(500).json({
      error: "Error retrieving antispam data",
      details: err.message,
      code: err.code
    });
  }
});
router.get('/:id/antispam/:recordId', async (req, res) => {
  try {
    const {
      id: clientIdParam,
      recordId
    } = req.params;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    let clientId = clientIdParam;
    if (uuidRegex.test(clientIdParam)) {
      const clientResult = await pool.query('SELECT id FROM v_b_clients WHERE id::text = $1', [clientIdParam]);
      if (clientResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Client not found'
        });
      }
      clientId = clientResult.rows[0].id;
    }
    if (isNaN(parseInt(clientId))) {
      return res.status(400).json({
        error: 'Invalid ID client'
      });
    }
    const result = await pool.query(`SELECT id, client_id, item_key, name, data, created_at, updated_at, is_active
       FROM v_b_clients_m_antispam
       WHERE client_id = $1 AND id::text = $2`, [clientId, recordId]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Enregistrement antispam not found'
      });
    }
    const row = result.rows[0];
    res.json({
      id: row.id,
      client_id: row.client_id,
      item_key: row.item_key,
      name: row.name,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      created_at: row.created_at,
      updated_at: row.updated_at,
      is_active: row.is_active
    });
  } catch (err) {
    console.error('Error fetching de l\'enregistrement antispam:', err);
    res.status(500).json({
      error: "Error retrieving antispam record",
      details: err.message,
      code: err.code
    });
  }
});
router.get('/domains/all', async (req, res) => {
  try {
    const result = await pool.query(`SELECT 
        ndd.id,
        ndd.client_id,
        ndd.item_key,
        ndd.data,
        ndd.is_active,
        ndd.created_at,
        ndd.updated_at,
        COALESCE(
          (SELECT name FROM v_b_clients 
           WHERE (id::text ~ '^[0-9]+$' AND id::integer = ndd.client_id)
              OR id::text = ndd.client_id::text
           LIMIT 1),
          'N/A'
        ) as client_name
       FROM v_b_clients_m_ndd ndd
       ORDER BY client_name, ndd.created_at DESC`);
    const domainsData = result.rows.map(row => {
      const data = row.data || {};
      return {
        id: row.id,
        client_id: row.client_id,
        client_name: row.client_name || 'N/A',
        item_key: row.item_key,
        is_active: row.is_active !== false,
        nom: data.nom || data.name || row.item_key || 'N/A',
        registrar: data.registrar || 'N/A',
        expiration: data.expiration || null,
        lastSync: row.updated_at || row.created_at || null,
        created_at: row.created_at,
        updated_at: row.updated_at
      };
    });
    res.json(domainsData);
  } catch (err) {
    console.error('Error fetching all domain names:', err);
    res.status(500).json({
      error: "Error retrieving all domain names",
      details: err.message,
      code: err.code
    });
  }
});
router.get('/:id/domains', async (req, res) => {
  try {
    const {
      id
    } = req.params;
    let clientId = id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(id)) {
      const clientResult = await pool.query('SELECT id FROM v_b_clients WHERE id::text = $1', [id]);
      if (clientResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Client not found'
        });
      }
      clientId = clientResult.rows[0].id;
      console.log(`🔄 GET domains: UUID conversion ${id} → numeric ID ${clientId}`);
    }
    clientId = parseInt(clientId);
    if (isNaN(clientId)) {
      console.error(`❌ GET domains: clientId n'est pas un nombre: ${clientId} (type: ${typeof clientId})`);
      return res.status(400).json({
        error: 'Invalid ID client'
      });
    }
    const result = await pool.query(`SELECT id, client_id, item_key, data, is_active, created_at, updated_at
       FROM v_b_clients_m_ndd
       WHERE client_id = $1
       ORDER BY created_at DESC`, [clientId]);
    const domainsData = result.rows.map(row => {
      const data = row.data || {};
      return {
        id: row.id,
        client_id: row.client_id,
        item_key: row.item_key,
        is_active: row.is_active,
        nom: data.nom || data.name || 'N/A',
        registrar: data.registrar || 'N/A',
        expiration: data.expiration || null,
        domain_id: data.id || null,
        created_at: row.created_at,
        updated_at: row.updated_at
      };
    });
    res.json(domainsData);
  } catch (err) {
    console.error('Error fetching client domain names:', err);
    res.status(500).json({
      error: "Error retrieving domain names",
      details: err.message,
      code: err.code
    });
  }
});
router.get('/ssl-certificates/all', async (req, res) => {
  try {
    const result = await pool.query(`SELECT
        ssl.id,
        ssl.client_id,
        ssl.item_key,
        ssl.name,
        ssl.data,
        ssl.is_active,
        ssl.created_at,
        ssl.updated_at,
        COALESCE(
          (SELECT name FROM v_b_clients
           WHERE (id::text ~ '^[0-9]+$' AND id::integer = ssl.client_id)
              OR id::text = ssl.client_id::text
           LIMIT 1),
          'N/A'
        ) as client_name
       FROM v_b_clients_m_ssl ssl
       WHERE ssl.is_active IS NOT FALSE
       ORDER BY client_name, ssl.created_at DESC`);
    res.json(result.rows.map(row => ({
      ...mapSslCertificateRow(row),
      client_name: row.client_name || "N/A"
    })));
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "SSL module unavailable (migration required)"
      });
    }
    console.error("Error GET ssl-certificates/all:", err);
    res.status(500).json({
      error: "Error retrieving SSL certificates",
      details: err.message,
      code: err.code
    });
  }
});
router.post('/ssl-certificates/check-all', verifyJWT, requirePermission('services.edit'), async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, client_id, item_key, name, data, is_active, created_at, updated_at
       FROM v_b_clients_m_ssl
       WHERE is_active IS NOT FALSE`);
    const checked = [];
    for (const row of result.rows) {
      const mapped = await checkAndPersistSslRow(row);
      if (mapped) checked.push(mapped);
    }
    res.json({
      checked: checked.length,
      items: checked
    });
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "SSL module unavailable (migration required)"
      });
    }
    console.error("Error POST ssl-certificates/check-all:", err);
    res.status(500).json({
      error: "Error during SSL verification",
      details: err.message
    });
  }
});
router.get('/:id/ssl-certificates', async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const {
      autoCheck = "false"
    } = req.query;
    if (autoCheck === "true") {
      const staleResult = await pool.query(`SELECT id, client_id, item_key, name, data, is_active, created_at, updated_at
         FROM v_b_clients_m_ssl
         WHERE client_id = $1 AND is_active IS NOT FALSE`, [clientId]);
      for (const row of staleResult.rows) {
        const data = row.data && typeof row.data === "object" ? row.data : {};
        if (isSslCheckStale(data)) {
          await checkAndPersistSslRow(row);
        }
      }
    }
    const result = await pool.query(`SELECT id, client_id, item_key, name, data, is_active, created_at, updated_at
       FROM v_b_clients_m_ssl
       WHERE client_id = $1
       ORDER BY name NULLS LAST, created_at DESC`, [clientId]);
    res.json(result.rows.map(mapSslCertificateRow));
  } catch (err) {
    if (err.code === "42P01") {
      return res.json([]);
    }
    console.error("Error GET ssl-certificates:", err);
    res.status(500).json({
      error: "Error retrieving SSL certificates",
      details: err.message
    });
  }
});
router.post('/:id/ssl-certificates', verifyJWT, requirePermission('services.create'), async (req, res) => {
  let clientId;
  let hostname;
  try {
    clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    hostname = String(req.body?.hostname || req.body?.host || req.body?.name || "").trim();
    const port = Number(req.body?.port) || 443;
    const checkIntervalHours = resolveSslCheckIntervalHours({
      checkIntervalHours: req.body?.checkIntervalHours
    });
    if (!hostname) {
      return res.status(400).json({
        error: "Hostname required"
      });
    }
    const result = await pool.query(`INSERT INTO v_b_clients_m_ssl (client_id, item_key, name, data, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, client_id, item_key, name, data, is_active, created_at, updated_at`, [clientId, hostname, hostname, JSON.stringify({
      hostname,
      port,
      checkIntervalHours
    })]);
    res.status(201).json(mapSslCertificateRow(result.rows[0]));
  } catch (err) {
    if (err.code === "23505") {
      try {
        const existing = await pool.query(`SELECT id, client_id, item_key, name, data, is_active, created_at, updated_at
           FROM v_b_clients_m_ssl
           WHERE client_id = $1 AND (name = $2 OR item_key = $2)
           LIMIT 1`, [clientId, hostname]);
        if (existing.rows[0]) {
          return res.json(mapSslCertificateRow(existing.rows[0]));
        }
      } catch (_) {}
    }
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "SSL module unavailable (migration required)"
      });
    }
    console.error("Error POST ssl-certificates:", err);
    res.status(500).json({
      error: "Error adding SSL certificate",
      details: err.message
    });
  }
});
router.post('/:id/ssl-certificates/check', verifyJWT, requirePermission('services.edit'), async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const result = await pool.query(`SELECT id, client_id, item_key, name, data, is_active
       FROM v_b_clients_m_ssl
       WHERE client_id = $1 AND is_active IS NOT FALSE`, [clientId]);
    const checked = [];
    for (const row of result.rows) {
      const mapped = await checkAndPersistSslRow(row);
      if (mapped) checked.push(mapped);
    }
    res.json({
      checked: checked.length,
      items: checked
    });
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "SSL module unavailable (migration required)"
      });
    }
    console.error("Error POST ssl-certificates/check:", err);
    res.status(500).json({
      error: "Error during SSL verification",
      details: err.message
    });
  }
});
router.post('/:id/ssl-certificates/:certId/check', verifyJWT, requirePermission('services.edit'), async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const certId = String(req.params.certId || "").trim();
    const existing = await pool.query(`SELECT id, client_id, item_key, name, data, is_active, created_at, updated_at
       FROM v_b_clients_m_ssl
       WHERE id = $1 AND client_id = $2`, [certId, clientId]);
    if (!existing.rows[0]) {
      return res.status(404).json({
        error: "Certificate not found"
      });
    }
    const mapped = await checkAndPersistSslRow(existing.rows[0]);
    if (!mapped) {
      return res.status(400).json({
        error: "Invalid host for verification"
      });
    }
    res.json(mapped);
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "SSL module unavailable (migration required)"
      });
    }
    console.error("Error POST ssl-certificates/:certId/check:", err);
    res.status(500).json({
      error: "Error during SSL verification",
      details: err.message
    });
  }
});
router.put('/:id/ssl-certificates/:certId', verifyJWT, requirePermission('services.edit'), async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const certId = String(req.params.certId || "").trim();
    const existing = await pool.query(`SELECT id, client_id, item_key, name, data, is_active, created_at, updated_at
       FROM v_b_clients_m_ssl
       WHERE id = $1 AND client_id = $2`, [certId, clientId]);
    if (!existing.rows[0]) {
      return res.status(404).json({
        error: "Certificate not found"
      });
    }
    const current = mapSslCertificateRow(existing.rows[0]);
    const data = existing.rows[0].data && typeof existing.rows[0].data === "object" ? existing.rows[0].data : {};
    const hostname = String(req.body?.hostname ?? req.body?.host ?? current.hostname ?? "").trim();
    const port = req.body?.port !== undefined ? Number(req.body.port) || 443 : current.port;
    const checkIntervalHours = req.body?.checkIntervalHours !== undefined ? resolveSslCheckIntervalHours({
      checkIntervalHours: req.body.checkIntervalHours
    }) : resolveSslCheckIntervalHours(data);
    const isActive = req.body?.is_active !== undefined ? Boolean(req.body.is_active) : current.is_active;
    if (!hostname) {
      return res.status(400).json({
        error: "Hostname required"
      });
    }
    const nextData = {
      ...data,
      hostname,
      port,
      checkIntervalHours
    };
    const result = await pool.query(`UPDATE v_b_clients_m_ssl
       SET item_key = $3, name = $3, data = $4, is_active = $5, updated_at = NOW()
       WHERE id = $1 AND client_id = $2
       RETURNING id, client_id, item_key, name, data, is_active, created_at, updated_at`, [certId, clientId, hostname, JSON.stringify(nextData), isActive]);
    res.json(mapSslCertificateRow(result.rows[0]));
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "SSL module unavailable (migration required)"
      });
    }
    console.error("Error PUT ssl-certificates:", err);
    res.status(500).json({
      error: "Error updating SSL certificate",
      details: err.message
    });
  }
});
router.delete('/:id/ssl-certificates/:certId', verifyJWT, requirePermission('services.delete'), async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const certId = String(req.params.certId || "").trim();
    const result = await pool.query(`DELETE FROM v_b_clients_m_ssl
       WHERE id = $1 AND client_id = $2
       RETURNING id`, [certId, clientId]);
    if (!result.rows[0]) {
      return res.status(404).json({
        error: "Certificate not found"
      });
    }
    res.json({
      success: true,
      id: result.rows[0].id
    });
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "SSL module unavailable (migration required)"
      });
    }
    console.error("Error DELETE ssl-certificates:", err);
    res.status(500).json({
      error: "Error deleting SSL certificate",
      details: err.message
    });
  }
});
router.get('/:id/licences', async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const result = await pool.query(`SELECT id, client_id, item_key, name, data, is_active, created_at, updated_at
       FROM v_b_clients_m_licences
       WHERE client_id = $1 AND is_active IS NOT FALSE
       ORDER BY name NULLS LAST, created_at DESC`, [clientId]);
    res.json(result.rows.map(mapLicenceRow));
  } catch (err) {
    if (err.code === "42P01") {
      return res.json([]);
    }
    console.error("Error GET licences:", err);
    res.status(500).json({
      error: "Error retrieving licenses",
      details: err.message
    });
  }
});
router.post('/:id/licences', verifyJWT, requirePermission('services.create'), async (req, res) => {
  let clientId;
  let nom;
  try {
    clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    nom = String(req.body?.nom || req.body?.name || "").trim();
    const expiration = String(req.body?.expiration || "").trim() || null;
    const fournisseur = String(req.body?.fournisseur || req.body?.vendor || "").trim() || null;
    const notes = String(req.body?.notes || req.body?.note || "").trim() || null;
    if (!nom) {
      return res.status(400).json({
        error: "Name is required"
      });
    }
    const data = {
      nom,
      expiration,
      fournisseur,
      notes
    };
    const result = await pool.query(`INSERT INTO v_b_clients_m_licences (client_id, item_key, name, data, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, client_id, item_key, name, data, is_active, created_at, updated_at`, [clientId, nom, nom, JSON.stringify(data)]);
    res.status(201).json(mapLicenceRow(result.rows[0]));
  } catch (err) {
    if (err.code === "23505" && clientId && nom) {
      try {
        const existing = await pool.query(`SELECT id, client_id, item_key, name, data, is_active, created_at, updated_at
           FROM v_b_clients_m_licences
           WHERE client_id = $1 AND (name = $2 OR item_key = $2)
           LIMIT 1`, [clientId, nom]);
        if (existing.rows[0]) {
          return res.json(mapLicenceRow(existing.rows[0]));
        }
      } catch (_) {}
    }
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "Licenses module unavailable (migration required)"
      });
    }
    console.error("Error POST licences:", err);
    res.status(500).json({
      error: "Error adding license",
      details: err.message
    });
  }
});
router.put('/:id/licences/:licenceId', verifyJWT, requirePermission('services.edit'), async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const licenceId = String(req.params.licenceId || "").trim();
    if (!licenceId) {
      return res.status(400).json({
        error: "Identifiant licence required"
      });
    }
    const existing = await pool.query(`SELECT id, client_id, item_key, name, data, is_active, created_at, updated_at
       FROM v_b_clients_m_licences
       WHERE id = $1 AND client_id = $2`, [licenceId, clientId]);
    if (!existing.rows[0]) {
      return res.status(404).json({
        error: "License not found"
      });
    }
    const current = mapLicenceRow(existing.rows[0]);
    const nom = String(req.body?.nom ?? req.body?.name ?? current.nom).trim();
    const expiration = req.body?.expiration !== undefined ? String(req.body.expiration || "").trim() || null : current.expiration;
    const fournisseur = req.body?.fournisseur !== undefined ? String(req.body.fournisseur || "").trim() || null : current.fournisseur;
    const notes = req.body?.notes !== undefined ? String(req.body.notes || "").trim() || null : current.notes;
    if (!nom) {
      return res.status(400).json({
        error: "Name is required"
      });
    }
    const data = {
      nom,
      expiration,
      fournisseur,
      notes
    };
    const result = await pool.query(`UPDATE v_b_clients_m_licences
       SET item_key = $3, name = $3, data = $4, updated_at = NOW()
       WHERE id = $1 AND client_id = $2
       RETURNING id, client_id, item_key, name, data, is_active, created_at, updated_at`, [licenceId, clientId, nom, JSON.stringify(data)]);
    res.json(mapLicenceRow(result.rows[0]));
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "Licenses module unavailable (migration required)"
      });
    }
    console.error("Error PUT licences:", err);
    res.status(500).json({
      error: "Error updating license",
      details: err.message
    });
  }
});
router.delete('/:id/licences/:licenceId', verifyJWT, requirePermission('services.delete'), async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const licenceId = String(req.params.licenceId || "").trim();
    const result = await pool.query(`DELETE FROM v_b_clients_m_licences
       WHERE id = $1 AND client_id = $2
       RETURNING id`, [licenceId, clientId]);
    if (!result.rows[0]) {
      return res.status(404).json({
        error: "License not found"
      });
    }
    res.status(204).send();
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "Licenses module unavailable (migration required)"
      });
    }
    console.error("Error DELETE licences:", err);
    res.status(500).json({
      error: "Error deleting license",
      details: err.message
    });
  }
});
router.get('/:id/custom-equipment', async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const familyKey = req.query.familyKey ? String(req.query.familyKey).trim() : null;
    const items = await listClientCustomEquipment(clientId, familyKey || null);
    res.json(items);
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "Equipment families module unavailable (migration required)"
      });
    }
    console.error("Error GET custom-equipment:", err);
    res.status(500).json({
      error: "Error retrieving custom equipment"
    });
  }
});
router.get('/:id/custom-equipment-map', async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const [families, items] = await Promise.all([listEquipmentFamilies({
      includeDisabled: false
    }), listClientCustomEquipment(clientId)]);
    const grouped = families.map(family => ({
      ...family,
      items: items.filter(item => item.familyKey === family.familyKey),
      count: items.filter(item => item.familyKey === family.familyKey).length
    }));
    res.json({
      families: grouped
    });
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "Equipment families module unavailable (migration required)"
      });
    }
    console.error("Error GET custom-equipment-map:", err);
    res.status(500).json({
      error: "Error retrieving equipment mapping"
    });
  }
});
router.post('/:id/custom-equipment/:familyKey', verifyJWT, requirePermission('infrastructure.edit'), async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const familyKey = String(req.params.familyKey || "").trim();
    const item = await createClientCustomEquipment(clientId, familyKey, req.body || {});
    res.status(201).json(item);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message
      });
    }
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "Equipment families module unavailable (migration required)"
      });
    }
    console.error("Error POST custom-equipment:", err);
    res.status(500).json({
      error: "Error creating equipment"
    });
  }
});
router.put('/:id/custom-equipment/:familyKey/:itemId', verifyJWT, requirePermission('infrastructure.edit'), async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const familyKey = String(req.params.familyKey || "").trim();
    const itemId = String(req.params.itemId || "").trim();
    const item = await updateClientCustomEquipment(clientId, familyKey, itemId, req.body || {});
    res.json(item);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message
      });
    }
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "Equipment families module unavailable (migration required)"
      });
    }
    console.error("Error PUT custom-equipment:", err);
    res.status(500).json({
      error: "Error updating equipment"
    });
  }
});
router.delete('/:id/custom-equipment/:familyKey/:itemId', verifyJWT, requirePermission('infrastructure.edit'), async (req, res) => {
  try {
    const clientId = await resolveNumericClientId(req.params.id);
    if (!clientId) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const familyKey = String(req.params.familyKey || "").trim();
    const itemId = String(req.params.itemId || "").trim();
    await deleteClientCustomEquipment(clientId, familyKey, itemId);
    res.status(204).send();
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message
      });
    }
    if (err.code === "42P01") {
      return res.status(503).json({
        error: "Equipment families module unavailable (migration required)"
      });
    }
    console.error("Error DELETE custom-equipment:", err);
    res.status(500).json({
      error: "Error deleting equipment"
    });
  }
});
router.delete('/:id/logs', verifyJWT, async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const originalClientId = id;
    let numericClientId = id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(id)) {
      const clientResult = await pool.query('SELECT id FROM v_b_clients WHERE id::text = $1', [id]);
      if (clientResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Client not found'
        });
      }
      numericClientId = clientResult.rows[0].id;
      console.log(`🔄 DELETE logs: UUID conversion ${id} → numeric ID ${numericClientId}`);
    }
    const logClientId = originalClientId;
    const countResult = await pool.query('SELECT COUNT(*) as total FROM v_b_clients_logs WHERE client_id::text = $1', [logClientId]);
    const logsCount = parseInt(countResult.rows[0].total) || 0;
    const deleteResult = await pool.query('DELETE FROM v_b_clients_logs WHERE client_id::text = $1', [logClientId]);
    const rawUserId = req.user?.id || req.user?.user_id || null;
    const uuidRegexUser = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const userId = rawUserId && uuidRegexUser.test(String(rawUserId)) ? String(rawUserId) : null;
    await pool.query(`INSERT INTO v_b_clients_logs
       (client_id, user_id, action, details, created_at)
       VALUES ($1, $2, $3, $4, NOW())`, [logClientId, userId, 'PURGE_LOGS', JSON.stringify({
      action: 'Full log purge',
      logs_deleted: logsCount,
      timestamp: new Date().toISOString()
    })]);
    res.json({
      success: true,
      message: `Logs purged successfully`,
      logs_deleted: logsCount,
      client_id: logClientId
    });
  } catch (err) {
    console.error('Error purging client logs:', err);
    res.status(500).json({
      error: "Error purging logs",
      details: err.message,
      code: err.code
    });
  }
});
registerClientMetaRoutes(router);
router.get('/:id/deletion-check', async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const exists = await pool.query('SELECT id, name FROM v_b_clients WHERE id = $1', [id]);
    if (exists.rows.length === 0) {
      return res.status(404).json({
        error: 'Company not found'
      });
    }
    const status = await getClientDeletionStatus(id);
    res.json({
      clientId: id,
      name: exists.rows[0].name,
      ...status
    });
  } catch (err) {
    res.status(500).json({
      error: 'Error during verification',
      details: err.message
    });
  }
});
router.get('/:id', async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const result = await pool.query(`
      SELECT c.*, u.username, u.email as user_email
      FROM v_b_clients c
      LEFT JOIN v_b_users u ON c.commercial_id::text = u.id::text
      WHERE c.id = $1
    `, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Client not found"
      });
    }
    const client = result.rows[0];
    if (!isCommunity()) {
      try {
        const rawModulesData = {};
        for (const [family, table] of Object.entries(MODULE_TABLES)) {
          try {
            let moduleResult;
            const baseSelect = `SELECT id, item_key, name, data, is_active, created_at, updated_at, checkmk_host_name, checkmk_site, checkmk_service_name`;
            const saveExtraSelect = table === 'v_b_clients_m_save' ? ', last_backup_date, last_backup_duration, last_backup_start' : '';
            try {
              moduleResult = await pool.query(`${baseSelect}${saveExtraSelect}
               FROM ${table}
               WHERE client_id = $1
               ORDER BY name NULLS LAST, item_key NULLS LAST`, [id]);
            } catch (colErr) {
              if (colErr.code === '42703') {
                moduleResult = await pool.query(`SELECT id, item_key, name, data, is_active, created_at, updated_at
                 FROM ${table}
                 WHERE client_id = $1
                 ORDER BY name NULLS LAST, item_key NULLS LAST`, [id]);
                moduleResult.rows.forEach(r => {
                  r.checkmk_host_name = null;
                  r.checkmk_site = null;
                  r.checkmk_service_name = null;
                  if (table === 'v_b_clients_m_save') {
                    r.last_backup_date = null;
                    r.last_backup_duration = null;
                  }
                });
              } else throw colErr;
            }
            const parsedRows = moduleResult.rows.map(row => {
              if (row.data && typeof row.data === 'string') {
                try {
                  row.data = JSON.parse(row.data);
                } catch (e) {
                  row.data = {};
                }
              } else if (!row.data) {
                row.data = {};
              }
              return row;
            });
            rawModulesData[family] = parsedRows;
          } catch (err) {
            if (err.code === '42P01') {
              rawModulesData[family] = [];
            } else {
              throw err;
            }
          }
        }
        let azureHasCredentials = false;
        try {
          const azureResult = await pool.query("SELECT 1 FROM v_b_clients_azure WHERE client_id = $1 LIMIT 1", [id]);
          azureHasCredentials = azureResult.rows.length > 0;
        } catch (azureErr) {}
        const transformed = transformClientModulesToFrontend(rawModulesData, {
          azureHasCredentials
        });
        client.modules = transformed.modules || {};
        client.modules_monitoring = transformed.modules_monitoring || {};
        client.equipements = transformed.equipements || {};
      } catch (moduleErr) {
        client.modules = {};
        client.modules_monitoring = {};
        client.equipements = {};
      }
    } else {
      client.modules = {};
      client.modules_monitoring = {};
      client.equipements = {};
    }
    if (client.contrat && typeof client.contrat === 'string') {
      try {
        client.contrat = JSON.parse(client.contrat);
      } catch (e) {
        client.contrat = {};
      }
    }
    let clientOptions = client.options || client.modules || {};
    if (clientOptions && typeof clientOptions === 'string') {
      try {
        clientOptions = JSON.parse(clientOptions);
      } catch (e) {
        clientOptions = {};
      }
    }
    client.options = clientOptions;
    client.modules = clientOptions;
    if (client.sites) {
      if (typeof client.sites === 'string') {
        try {
          client.sites = JSON.parse(client.sites);
        } catch (e) {
          client.sites = [];
        }
      }
    } else {
      client.sites = [];
    }
    let clientSSID = client.ssid || client.ssids || [];
    if (clientSSID && typeof clientSSID === 'string') {
      try {
        clientSSID = JSON.parse(clientSSID);
      } catch (e) {
        clientSSID = [];
      }
    }
    client.ssid = clientSSID;
    client.ssids = clientSSID;
    client.commercial = client.username || client.user_email || null;
    res.json(client);
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message,
      code: err.code
    });
  }
});
router.post('/', requirePermission('clients.create'), async (req, res) => {
  try {
    await assertCommunityClientsLimit(1);
    const {
      name,
      modules,
      options,
      modules_monitoring,
      contrat,
      commercialId
    } = req.body;
    const defaultOptions = options || modules || {};
    const modulesWithMonitoring = {
      ...defaultOptions,
      Monitoring: true
    };
    const defaultContrat = contrat || {};
    const insertFields = ['name', 'options', 'contrat'];
    const insertValues = [name, JSON.stringify(modulesWithMonitoring), JSON.stringify(defaultContrat)];
    let paramIndex = 4;
    if (commercialId && commercialId !== "") {
      insertFields.push('commercial_id');
      insertValues.push(commercialId);
      paramIndex++;
    }
    const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(`INSERT INTO v_b_clients (${insertFields.join(', ')})
       VALUES (${placeholders})
       RETURNING id`, insertValues);
    const newClientId = result.rows[0].id;
    invalidateClientsListCache();
    res.status(201).json({
      success: true,
      id: newClientId
    });
  } catch (err) {
    if (err?.code?.startsWith("COMMUNITY_")) {
      return sendCommunityLimitError(res, err);
    }
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message,
      code: err.code
    });
  }
});
router.post('/general', requirePermission('clients.create'), async (req, res) => {
  try {
    await assertCommunityClientsLimit(1);
    const {
      name,
      clientNumber,
      client_number,
      contrat,
      options,
      modules,
      modules_monitoring,
      sites,
      ssid,
      ssids,
      commercialId,
      address,
      siret,
      secteur
    } = req.body;
    const resolvedClientNumber = normalizeClientNumber(clientNumber !== undefined ? clientNumber : client_number);
    const defaultOptions = options || modules || {
      Support: false,
      Curatif: false,
      Preventif: false,
      Monitoring: false,
      Hebergement: false
    };
    const defaultModulesMonitoring = modules_monitoring || {};
    const finalContrat = contrat || {};
    const cleanSites = sites && Array.isArray(sites) ? sites : [];
    assertCommunitySitesLimit(cleanSites);
    const insertFields = ['name', 'contrat', 'options', 'sites', 'modules'];
    const insertValues = [name, JSON.stringify(finalContrat), JSON.stringify(defaultOptions), JSON.stringify(cleanSites), JSON.stringify(defaultModulesMonitoring || {})];
    if (address !== undefined) {
      insertFields.push('address');
      insertValues.push(address);
    }
    if (siret !== undefined) {
      insertFields.push('siret');
      insertValues.push(siret);
    }
    if (secteur !== undefined) {
      insertFields.push('secteur');
      insertValues.push(secteur);
    }
    if (resolvedClientNumber !== null) {
      insertFields.push('client_number');
      insertValues.push(resolvedClientNumber);
    } else if (clientNumber !== undefined || client_number !== undefined) {
      insertFields.push('client_number');
      insertValues.push(null);
    }
    if (commercialId && commercialId !== "") {
      insertFields.push('commercial_id');
      insertValues.push(commercialId);
    }
    const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(`INSERT INTO v_b_clients (${insertFields.join(', ')})
       VALUES (${placeholders})
       RETURNING id, name, client_number, contrat, options, sites, commercial_id, created_at, updated_at`, insertValues);
    invalidateClientsListCache();
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err?.code?.startsWith("COMMUNITY_")) {
      return sendCommunityLimitError(res, err);
    }
    console.error('[POST /general] SQL error:', err.message);
    console.error('[POST /general] Error code:', err.code);
    console.error('[POST /general] SQL used: INSERT with "options" column');
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message,
      code: err.code
    });
  }
});
router.put('/:id', verifyJWT, requirePermission('clients.edit'), async (req, res) => {
  try {
    const availableColumns = await getClientsAvailableColumns();
    const hasClientColumn = columnName => availableColumns.has(String(columnName || "").trim());
    const {
      name,
      clientNumber,
      client_number,
      email,
      phone,
      address,
      contrat,
      options,
      modules,
      modules_monitoring,
      sites,
      ssid,
      ssids,
      office365_data,
      commercialId,
      siret,
      secteur
    } = req.body;
    const resolvedClientNumber = clientNumber !== undefined || client_number !== undefined ? normalizeClientNumber(clientNumber !== undefined ? clientNumber : client_number) : undefined;
    if (name !== undefined || clientNumber !== undefined || client_number !== undefined || email !== undefined || phone !== undefined || address !== undefined || office365_data !== undefined || sites !== undefined || ssid !== undefined || ssids !== undefined || options !== undefined || modules !== undefined || contrat !== undefined || commercialId !== undefined || siret !== undefined || secteur !== undefined || modules_monitoring !== undefined) {
      const previousClientSnapshot = await getClientSnapshotForNotification(req.params.id);
      let updateFields = [];
      let updateValues = [];
      let paramIndex = 1;
      if (name !== undefined && hasClientColumn("name")) {
        updateFields.push(`name = $${paramIndex++}`);
        updateValues.push(name);
      }
      if (resolvedClientNumber !== undefined && hasClientColumn("client_number")) {
        updateFields.push(`client_number = $${paramIndex++}`);
        updateValues.push(resolvedClientNumber);
      }
      if (email !== undefined && hasClientColumn("email")) {
        updateFields.push(`email = $${paramIndex++}`);
        updateValues.push(email);
      }
      if (phone !== undefined && hasClientColumn("phone")) {
        updateFields.push(`phone = $${paramIndex++}`);
        updateValues.push(phone);
      }
      if (address !== undefined && hasClientColumn("address")) {
        updateFields.push(`address = $${paramIndex++}`);
        updateValues.push(address);
      }
      if (siret !== undefined && hasClientColumn("siret")) {
        updateFields.push(`siret = $${paramIndex++}`);
        updateValues.push(siret);
      }
      if (secteur !== undefined && hasClientColumn("secteur")) {
        updateFields.push(`secteur = $${paramIndex++}`);
        updateValues.push(secteur);
      }
      if (commercialId !== undefined && commercialId !== "" && hasClientColumn("commercial_id")) {
        updateFields.push(`commercial_id = $${paramIndex++}`);
        updateValues.push(commercialId);
      }
      let finalContrat = undefined;
      let finalOptions = undefined;
      let finalModulesMonitoring = undefined;
      if (contrat !== undefined && hasClientColumn("contrat")) {
        finalContrat = contrat || {};
        updateFields.push(`contrat = $${paramIndex++}`);
        updateValues.push(JSON.stringify(finalContrat));
      }
      if ((options !== undefined || modules !== undefined) && hasClientColumn("options")) {
        finalOptions = options || modules || {};
        updateFields.push(`options = $${paramIndex++}`);
        updateValues.push(JSON.stringify(finalOptions));
      }
      if (modules_monitoring !== undefined && hasClientColumn("modules")) {
        finalModulesMonitoring = modules_monitoring || {};
        updateFields.push(`modules = $${paramIndex++}`);
        updateValues.push(JSON.stringify(finalModulesMonitoring));
      }
      if (sites !== undefined && hasClientColumn("sites")) {
        assertCommunitySitesLimit(sites || []);
        updateFields.push(`sites = $${paramIndex++}`);
        updateValues.push(JSON.stringify(sites || []));
      }
      if (office365_data !== undefined && office365_data !== null && hasClientColumn("office365_data")) {
        updateFields.push(`office365_data = $${paramIndex++}`);
        updateValues.push(typeof office365_data === 'object' ? JSON.stringify(office365_data) : office365_data);
      }
      paramIndex = appendClientSsidUpdate({
        ssid,
        ssids,
        hasClientColumn,
        updateFields,
        updateValues,
        paramIndex
      });
      if (updateFields.length === 0) {
        return res.status(400).json({
          error: "No data to update"
        });
      }
      updateValues.push(req.params.id);
      const idParamIndex = paramIndex;
      const updateQuery = `
        UPDATE v_b_clients 
        SET ${updateFields.join(', ')}
        WHERE id = $${idParamIndex}
      `;
      await pool.query(updateQuery, updateValues);
      await logClientUpdate({
        req,
        updateFields,
        valueMap: {
          name,
          client_number: resolvedClientNumber,
          email,
          phone,
          address,
          siret,
          secteur,
          commercial_id: commercialId,
          contrat: finalContrat,
          options: finalOptions,
          modules_monitoring: finalModulesMonitoring,
          sites,
          office365_data,
          ssid: ssids !== undefined ? ssids : ssid
        }
      });
      const changedFieldNames = updateFields.map(field => String(field).split("=")[0]?.trim()).filter(Boolean);
      const changedFieldNamesWithFallback = changedFieldNames.length > 0 ? changedFieldNames : Object.keys(req.body || {}).map(key => String(key || "").trim()).filter(Boolean);
      const nextValueMapForNotification = {
        name: name !== undefined ? name : previousClientSnapshot?.name ?? null,
        email: email !== undefined ? email : previousClientSnapshot?.email ?? null,
        phone: phone !== undefined ? phone : previousClientSnapshot?.phone ?? null,
        address: address !== undefined ? address : previousClientSnapshot?.address ?? null,
        siret: siret !== undefined ? siret : previousClientSnapshot?.siret ?? null,
        secteur: secteur !== undefined ? secteur : previousClientSnapshot?.secteur ?? null,
        commercial_id: commercialId !== undefined && commercialId !== "" ? commercialId : previousClientSnapshot?.commercial_id ?? null,
        contrat: finalContrat !== undefined ? finalContrat : previousClientSnapshot?.contrat ?? null,
        options: finalOptions !== undefined ? finalOptions : previousClientSnapshot?.options ?? null,
        modules: finalModulesMonitoring !== undefined ? finalModulesMonitoring : previousClientSnapshot?.modules ?? null,
        sites: sites !== undefined ? sites || [] : previousClientSnapshot?.sites ?? null,
        office365_data: office365_data !== undefined && office365_data !== null ? office365_data : previousClientSnapshot?.office365_data ?? null
      };
      const notificationChanges = buildNotificationChanges(previousClientSnapshot || {}, changedFieldNamesWithFallback, nextValueMapForNotification);
      dispatchNotificationEvent({
        source: "entreprise",
        element: "updated",
        enterpriseId: String(req.params.id || ""),
        user: req.user,
        context: {
          entreprise: {
            id: String(req.params.id || ""),
            nom: name || previousClientSnapshot?.name || ""
          },
          changedFields: changedFieldNamesWithFallback,
          changes: notificationChanges
        }
      }).catch(() => {});
      if (changedFieldNamesWithFallback.includes("contrat")) {
        dispatchNotificationEvent({
          source: "entreprise",
          element: "contract_info_updated",
          enterpriseId: String(req.params.id || ""),
          user: req.user,
          context: {
            entreprise: {
              id: String(req.params.id || ""),
              nom: name || previousClientSnapshot?.name || ""
            },
            changedFields: changedFieldNamesWithFallback,
            changes: notificationChanges
          }
        }).catch(() => {});
      }
      if (changedFieldNamesWithFallback.includes("office365_data")) {
        dispatchNotificationEvent({
          source: "services",
          element: "tenant_updated",
          enterpriseId: String(req.params.id || ""),
          user: req.user,
          context: {
            entreprise: {
              id: String(req.params.id || ""),
              nom: name || previousClientSnapshot?.name || ""
            },
            changedFields: changedFieldNamesWithFallback,
            changes: notificationChanges
          }
        }).catch(() => {});
      }
      invalidateClientsListCache();
      res.json({
        success: true
      });
    } else {
      const defaultOptions = options || modules || {};
      const modulesWithMonitoring = {
        ...defaultOptions,
        Monitoring: true
      };
      const defaultContrat = contrat || {};
      await pool.query(`UPDATE v_b_clients 
         SET name = $1, options = $2, contrat = $3
         WHERE id = $4`, [name, JSON.stringify(modulesWithMonitoring), JSON.stringify(defaultContrat), req.params.id]);
      dispatchNotificationEvent({
        source: "entreprise",
        element: "updated",
        enterpriseId: String(req.params.id || ""),
        user: req.user,
        context: {
          entreprise: {
            id: String(req.params.id || ""),
            nom: name || ""
          }
        }
      }).catch(() => {});
      invalidateClientsListCache();
      res.json({
        success: true
      });
    }
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message,
      code: err.code
    });
  }
});
router.put('/general/:id', verifyJWT, requirePermission('clients.edit'), async (req, res) => {
  try {
    const availableColumns = await getClientsAvailableColumns();
    const hasClientColumn = columnName => availableColumns.has(String(columnName || "").trim());
    const {
      name,
      clientNumber,
      client_number,
      email,
      phone,
      address,
      contrat,
      options,
      modules,
      modules_monitoring,
      sites,
      ssid,
      ssids,
      office365_data,
      commercialId,
      siret,
      secteur
    } = req.body;
    const resolvedClientNumber = clientNumber !== undefined || client_number !== undefined ? normalizeClientNumber(clientNumber !== undefined ? clientNumber : client_number) : undefined;
    const previousClientSnapshot = await getClientSnapshotForNotification(req.params.id);
    let updateFields = [];
    let updateValues = [];
    let paramIndex = 1;
    if (name !== undefined && hasClientColumn("name")) {
      updateFields.push(`name = $${paramIndex++}`);
      updateValues.push(name);
    }
    if (resolvedClientNumber !== undefined && hasClientColumn("client_number")) {
      updateFields.push(`client_number = $${paramIndex++}`);
      updateValues.push(resolvedClientNumber);
    }
    if (email !== undefined && hasClientColumn("email")) {
      updateFields.push(`email = $${paramIndex++}`);
      updateValues.push(email);
    }
    if (phone !== undefined && hasClientColumn("phone")) {
      updateFields.push(`phone = $${paramIndex++}`);
      updateValues.push(phone);
    }
    if (address !== undefined && hasClientColumn("address")) {
      updateFields.push(`address = $${paramIndex++}`);
      updateValues.push(address);
    }
    if (siret !== undefined && hasClientColumn("siret")) {
      updateFields.push(`siret = $${paramIndex++}`);
      updateValues.push(siret);
    }
    if (secteur !== undefined && hasClientColumn("secteur")) {
      updateFields.push(`secteur = $${paramIndex++}`);
      updateValues.push(secteur);
    }
    if (commercialId !== undefined && commercialId !== "" && hasClientColumn("commercial_id")) {
      updateFields.push(`commercial_id = $${paramIndex++}`);
      updateValues.push(commercialId);
    }
    let finalContrat = undefined;
    let finalOptions = undefined;
    let finalModulesMonitoring = undefined;
    if (contrat !== undefined && hasClientColumn("contrat")) {
      finalContrat = contrat || {};
      updateFields.push(`contrat = $${paramIndex++}`);
      updateValues.push(JSON.stringify(finalContrat));
    }
    if ((options !== undefined || modules !== undefined) && hasClientColumn("options")) {
      finalOptions = options || modules || {};
      updateFields.push(`options = $${paramIndex++}`);
      updateValues.push(JSON.stringify(finalOptions));
    }
    if (modules_monitoring !== undefined && hasClientColumn("modules")) {
      finalModulesMonitoring = modules_monitoring || {};
      updateFields.push(`modules = $${paramIndex++}`);
      updateValues.push(JSON.stringify(finalModulesMonitoring));
    }
    if (sites !== undefined && hasClientColumn("sites")) {
      assertCommunitySitesLimit(sites || []);
      updateFields.push(`sites = $${paramIndex++}`);
      updateValues.push(JSON.stringify(sites || []));
    }
    if (office365_data !== undefined && hasClientColumn("office365_data")) {
      updateFields.push(`office365_data = $${paramIndex++}`);
      updateValues.push(typeof office365_data === 'object' ? JSON.stringify(office365_data) : office365_data);
    }
    paramIndex = appendClientSsidUpdate({
      ssid,
      ssids,
      hasClientColumn,
      updateFields,
      updateValues,
      paramIndex
    });
    updateValues.push(req.params.id);
    if (updateFields.length === 0) {
      return res.status(400).json({
        error: "No data to update"
      });
    }
    const updateQuery = `
      UPDATE v_b_clients 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramIndex}
    `;
    await pool.query(updateQuery, updateValues);
    await logClientUpdate({
      req,
      updateFields,
      valueMap: {
        name,
        client_number: resolvedClientNumber,
        email,
        phone,
        address,
        siret,
        secteur,
        commercial_id: commercialId,
        contrat: finalContrat,
        options: finalOptions,
        modules_monitoring: finalModulesMonitoring,
        sites,
        office365_data,
        ssid: ssids !== undefined ? ssids : ssid
      }
    });
    try {
      const userId = req.user?.id || req.user?.user_id || null;
      let userName = 'Unknown user';
      if (userId) {
        try {
          const userIdStr = String(userId);
          const userResult = await pool.query(`SELECT email, username
             FROM v_b_users
             WHERE id::text = $1`, [userIdStr]);
          if (userResult.rows.length > 0) {
            const user = userResult.rows[0];
            userName = user.email || user.username || 'Unknown user';
          }
        } catch (userError) {
          userName = req.user?.name || req.user?.username || req.user?.email || 'Unknown user';
        }
      }
      const action = `Client update`;
      const details = JSON.stringify({
        modifiedFields: updateFields.map(field => field.replace(' = $' + paramIndex + '::text', '').replace(' = $' + paramIndex, '')).filter(field => !field.includes('updated_at'))
      });
      await pool.query(`INSERT INTO v_b_clients_m_logs
         (client_id, equipment_family, equipment_name, equipment_id, user_id, user_name, action, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [req.params.id, 'client', 'General client', null, userId, userName, action, details]);
    } catch (logError) {
      console.warn('Error writing log:', logError);
    }
    invalidateClientsListCache();
    const changedFieldNames = updateFields.map(field => String(field).split("=")[0]?.trim()).filter(Boolean);
    const changedFieldNamesWithFallback = changedFieldNames.length > 0 ? changedFieldNames : Object.keys(req.body || {}).map(key => String(key || "").trim()).filter(Boolean);
    const nextValueMapForNotification = {
      name: name !== undefined ? name : previousClientSnapshot?.name ?? null,
      email: email !== undefined ? email : previousClientSnapshot?.email ?? null,
      phone: phone !== undefined ? phone : previousClientSnapshot?.phone ?? null,
      address: address !== undefined ? address : previousClientSnapshot?.address ?? null,
      siret: siret !== undefined ? siret : previousClientSnapshot?.siret ?? null,
      secteur: secteur !== undefined ? secteur : previousClientSnapshot?.secteur ?? null,
      commercial_id: commercialId !== undefined && commercialId !== "" ? commercialId : previousClientSnapshot?.commercial_id ?? null,
      contrat: finalContrat !== undefined ? finalContrat : previousClientSnapshot?.contrat ?? null,
      options: finalOptions !== undefined ? finalOptions : previousClientSnapshot?.options ?? null,
      modules: finalModulesMonitoring !== undefined ? finalModulesMonitoring : previousClientSnapshot?.modules ?? null,
      sites: sites !== undefined ? sites || [] : previousClientSnapshot?.sites ?? null,
      office365_data: office365_data !== undefined ? office365_data : previousClientSnapshot?.office365_data ?? null
    };
    const notificationChanges = buildNotificationChanges(previousClientSnapshot || {}, changedFieldNamesWithFallback, nextValueMapForNotification);
    dispatchNotificationEvent({
      source: "entreprise",
      element: "updated",
      enterpriseId: String(req.params.id || ""),
      user: req.user,
      context: {
        entreprise: {
          id: String(req.params.id || ""),
          nom: name || previousClientSnapshot?.name || ""
        },
        changedFields: changedFieldNamesWithFallback,
        changes: notificationChanges
      }
    }).catch(() => {});
    if (changedFieldNamesWithFallback.includes("contrat")) {
      dispatchNotificationEvent({
        source: "entreprise",
        element: "contract_info_updated",
        enterpriseId: String(req.params.id || ""),
        user: req.user,
        context: {
          entreprise: {
            id: String(req.params.id || ""),
            nom: name || previousClientSnapshot?.name || ""
          },
          changedFields: changedFieldNamesWithFallback,
          changes: notificationChanges
        }
      }).catch(() => {});
    }
    if (changedFieldNamesWithFallback.includes("office365_data")) {
      dispatchNotificationEvent({
        source: "services",
        element: "tenant_updated",
        enterpriseId: String(req.params.id || ""),
        user: req.user,
        context: {
          entreprise: {
            id: String(req.params.id || ""),
            nom: name || previousClientSnapshot?.name || ""
          },
          changedFields: changedFieldNamesWithFallback,
          changes: notificationChanges
        }
      }).catch(() => {});
    }
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message,
      code: err.code
    });
  }
});
router.delete('/:id', requirePermission('clients.delete'), async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const deletionStatus = await getClientDeletionStatus(id);
    if (!deletionStatus.deletable) {
      return res.status(409).json({
        error: "Deletion not possible: items are still linked to this company.",
        code: "CLIENT_HAS_DEPENDENCIES",
        blockers: deletionStatus.blockers,
        totalBlockers: deletionStatus.totalBlockers
      });
    }
    await pool.query('DELETE FROM v_b_clients WHERE id = $1', [id]);
    invalidateClientsListCache();
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message,
      code: err.code
    });
  }
});
const modulesRouter = express.Router();
modulesRouter.use(verifyJWT);
const TABLES = {
  internet: "v_b_clients_m_internet",
  server: "v_b_clients_m_servers",
  servers: "v_b_clients_m_servers",
  stockage: "v_b_clients_m_stockage",
  nas: "v_b_clients_m_stockage",
  firewall: "v_b_clients_m_firewall",
  switch: "v_b_clients_m_switch",
  wifi: "v_b_clients_m_wifi",
  "bornes-wifi": "v_b_clients_m_wifi",
  alimentation: "v_b_clients_m_alimentation",
  routeur: "v_b_clients_m_routeur",
  toip: "v_b_clients_m_toip",
  save: "v_b_clients_m_save",
  antivirus: "v_b_clients_m_antivirus",
  antispam: "v_b_clients_m_antispam",
  ndd: "v_b_clients_m_ndd",
  ssl: "v_b_clients_m_ssl",
  licences: "v_b_clients_m_licences",
  o365: "v_b_clients_m_o365",
  ordinateurs: "v_b_clients_m_ordinateurs",
  ordinateur: "v_b_clients_m_ordinateurs"
};
function resolveTable(family) {
  const key = family?.toLowerCase();
  return TABLES[key] || null;
}
const SERVICE_MODULE_FAMILIES = new Set(["save", "antivirus", "antispam", "ndd", "ssl", "licences", "o365"]);
function requireModulePermission(action) {
  const serviceKey = `services.${action}`;
  return (req, res, next) => {
    const family = String(req.params.family || "").toLowerCase();
    if (SERVICE_MODULE_FAMILIES.has(family)) {
      return requirePermission(serviceKey)(req, res, next);
    }
    return requirePermission("infrastructure.edit")(req, res, next);
  };
}
modulesRouter.get('/:clientId/:family', requireAnyPermission("services.view", "infrastructure.view"), async (req, res) => {
  try {
    const {
      clientId,
      family
    } = req.params;
    const table = resolveTable(family);
    if (!table) return res.status(400).json({
      error: "Famille inconnue"
    });
    const result = await pool.query(`SELECT id, client_id, item_key, name, data, is_active, created_at, updated_at
       FROM ${table}
       WHERE client_id = $1
       ORDER BY id ASC`, [clientId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({
      error: "Server error"
    });
  }
});
modulesRouter.post('/:clientId/:family', requireModulePermission("create"), async (req, res) => {
  try {
    const {
      clientId,
      family
    } = req.params;
    const {
      item_key,
      name,
      data,
      is_active
    } = req.body || {};
    const table = resolveTable(family);
    if (!table) return res.status(400).json({
      error: "Famille inconnue"
    });
    if (!clientId) return res.status(400).json({
      error: "clientId required"
    });
    const finalName = name || item_key || null;
    const finalItemKey = item_key || name || null;
    let result;
    try {
      if (finalName) {
        result = await pool.query(`INSERT INTO ${table} (client_id, item_key, name, data, is_active)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (client_id, name) DO UPDATE SET
             item_key = EXCLUDED.item_key,
             data = EXCLUDED.data,
             is_active = EXCLUDED.is_active,
             updated_at = NOW()
           RETURNING *`, [clientId, finalItemKey, finalName, data || null, is_active !== false]);
      } else if (finalItemKey) {
        result = await pool.query(`INSERT INTO ${table} (client_id, item_key, name, data, is_active)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (client_id, item_key) DO UPDATE SET
             name = EXCLUDED.name,
             data = EXCLUDED.data,
             is_active = EXCLUDED.is_active,
             updated_at = NOW()
           RETURNING *`, [clientId, finalItemKey, finalName, data || null, is_active !== false]);
      } else {
        result = await pool.query(`INSERT INTO ${table} (client_id, item_key, name, data, is_active)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`, [clientId, finalItemKey, finalName, data || null, is_active !== false]);
      }
    } catch (conflictErr) {
      if (conflictErr.code === '42P10' || conflictErr.code === '42704' || conflictErr.message.includes('constraint')) {
        result = await pool.query(`INSERT INTO ${table} (client_id, item_key, name, data, is_active)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`, [clientId, finalItemKey, finalName, data || null, is_active !== false]);
      } else {
        throw conflictErr;
      }
    }
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({
      error: "Server error"
    });
  }
});
modulesRouter.get('/:clientId/:family/:equipmentName/logs', requireAnyPermission("services.view", "infrastructure.view"), async (req, res) => {
  try {
    const {
      clientId,
      family,
      equipmentName
    } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const logQuery = buildEquipmentLogQuery({
      clientId,
      family,
      equipmentName,
      equipmentDbId: req.query.equipment_id ? String(req.query.equipment_id).trim() : null,
      search: req.query.search,
      category: req.query.category
    });
    const result = await pool.query(`SELECT 
        id,
        client_id,
        equipment_family,
        equipment_name,
        equipment_id,
        user_id,
        user_name,
        action,
        details,
        created_at
       FROM v_b_clients_m_logs
       WHERE ${logQuery.where}
       ORDER BY created_at DESC
       LIMIT $${logQuery.params.length + 1} OFFSET $${logQuery.params.length + 2}`, [...logQuery.params, limit, offset]);
    const countResult = await pool.query(`SELECT COUNT(*) as total
       FROM v_b_clients_m_logs
       WHERE ${logQuery.where}`, logQuery.params);
    const total = parseInt(countResult.rows[0].total) || 0;
    res.json({
      logs: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      filters: {
        search: logQuery.search,
        category: logQuery.category
      }
    });
  } catch (err) {
    res.status(500).json({
      error: "Server error"
    });
  }
});
modulesRouter.delete('/:clientId/:family/:equipmentName/logs', requireModulePermission("edit"), async (req, res) => {
  try {
    const {
      clientId,
      family,
      equipmentName
    } = req.params;
    const logQuery = buildEquipmentLogQuery({
      clientId,
      family,
      equipmentName,
      equipmentDbId: req.query.equipment_id ? String(req.query.equipment_id).trim() : null,
      search: req.query.search,
      category: req.query.category
    });
    const countResult = await pool.query(`SELECT COUNT(*) as total
       FROM v_b_clients_m_logs
       WHERE ${logQuery.where}`, logQuery.params);
    const logsDeleted = parseInt(countResult.rows[0].total) || 0;
    if (logsDeleted > 0) {
      await pool.query(`DELETE FROM v_b_clients_m_logs
         WHERE ${logQuery.where}`, logQuery.params);
    }
    res.json({
      success: true,
      logs_deleted: logsDeleted,
      filters: {
        search: logQuery.search,
        category: logQuery.category
      }
    });
  } catch (err) {
    console.error("[DELETE equipment logs]", err.message);
    res.status(500).json({
      error: "Server error"
    });
  }
});
async function resolveRequestUserName(req) {
  const userId = req.user?.id || req.user?.user_id || null;
  if (!userId) {
    return {
      userId: null,
      userName: req.user?.name || req.user?.username || req.user?.email || "Unknown user"
    };
  }
  try {
    const userResult = await pool.query(`SELECT email, username FROM v_b_users WHERE id::text = $1`, [String(userId)]);
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      return {
        userId,
        userName: user.email || user.username || "Unknown user"
      };
    }
  } catch {}
  return {
    userId,
    userName: req.user?.name || req.user?.username || req.user?.email || "Unknown user"
  };
}
modulesRouter.post('/:clientId/:family/:equipmentName/logs', requireModulePermission("edit"), async (req, res) => {
  try {
    const {
      clientId,
      family,
      equipmentName
    } = req.params;
    const {
      action,
      details,
      equipment_id
    } = req.body || {};
    if (!action || !String(action).trim()) {
      return res.status(400).json({
        error: "action required"
      });
    }
    const decodedEquipmentName = decodeURIComponent(equipmentName);
    const {
      userId,
      userName
    } = await resolveRequestUserName(req);
    await pool.query(`INSERT INTO v_b_clients_m_logs
         (client_id, equipment_family, equipment_name, equipment_id, user_id, user_name, action, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [clientId, family, decodedEquipmentName, equipment_id || null, userId, userName, String(action).trim(), details != null ? JSON.stringify(details) : null]);
    res.status(201).json({
      success: true
    });
  } catch (err) {
    console.error("[POST equipment logs]", err.message);
    res.status(500).json({
      error: "Server error"
    });
  }
});
modulesRouter.put('/:clientId/:family/:id', requireModulePermission("edit"), async (req, res) => {
  try {
    const {
      clientId,
      family,
      id
    } = req.params;
    const {
      item_key,
      name,
      data,
      is_active
    } = req.body || {};
    const table = resolveTable(family);
    if (!table) return res.status(400).json({
      error: "Famille inconnue"
    });
    const oldResult = await pool.query(`SELECT name, item_key, data FROM ${table}
       WHERE id = $1 AND client_id = $2`, [id, clientId]);
    if (oldResult.rows.length === 0) return res.status(404).json({
      error: "Not found"
    });
    const oldItem = oldResult.rows[0];
    let oldData = oldItem.data;
    if (oldData && typeof oldData === 'string') {
      try {
        oldData = JSON.parse(oldData);
      } catch (e) {
        oldData = {};
      }
    }
    oldData = oldData || {};
    const newData = data || {};
    const dataToSave = family === 'servers' && typeof newData === 'object' ? {
      ...oldData,
      ...newData,
      role: Array.isArray(newData.role) ? newData.role : Array.isArray(oldData.role) ? oldData.role : []
    } : family === 'nas' && typeof newData === 'object' ? {
      ...oldData,
      ...newData
    } : (family === 'ordinateurs' || family === 'ordinateur') && typeof newData === 'object' ? {
      ...oldData,
      ...newData
    } : data || null;
    const result = await pool.query(`UPDATE ${table}
       SET item_key = $1,
           name = $2,
           data = $3,
           is_active = $4,
           updated_at = NOW()
       WHERE id = $5 AND client_id = $6
       RETURNING *`, [item_key || name || null, name || item_key || null, dataToSave, is_active !== false, id, clientId]);
    if (result.rows.length === 0) return res.status(404).json({
      error: "Not found"
    });
    const updatedItem = result.rows[0];
    const equipmentName = name || item_key || oldItem.name || oldItem.item_key || updatedItem.name || updatedItem.item_key || '';
    try {
      const userId = req.user?.id || req.user?.user_id || null;
      let userName = 'Unknown user';
      if (userId) {
        try {
          const userIdStr = String(userId);
          const userResult = await pool.query(`SELECT email, username 
             FROM v_b_users 
             WHERE id::text = $1`, [userIdStr]);
          if (userResult.rows.length > 0) {
            const user = userResult.rows[0];
            userName = user.email || user.username || 'Unknown user';
          }
        } catch (userError) {
          userName = req.user?.name || req.user?.username || req.user?.email || 'Unknown user';
        }
      } else {
        userName = req.user?.name || req.user?.username || req.user?.email || 'Unknown user';
      }
      const fieldNames = {
        'nom': 'Nom',
        'name': 'Nom',
        'marque': 'Marque',
        'fabricant': 'Fabricant',
        'modele': 'Model',
        'model': 'Model',
        'numeroSerie': 'Serial number',
        'numero_serie': 'Serial number',
        'ip': 'Adresse IP',
        'adresseMac': 'Adresse MAC',
        'mac': 'Adresse MAC',
        'site': 'Site',
        'location': 'Site',
        'emplacement': 'Site',
        'processeur': 'Processeur',
        'cpu': 'Processeur',
        'vcpu': 'VCPU',
        'memoire': 'Memory',
        'ram': 'Memory',
        'stockage': 'Stockage',
        'systeme': 'Operating system',
        'os': 'Operating system',
        'vlan': 'VLAN',
        'role': 'Role',
        'expirationGarantie': 'Expiration garantie',
        'garantie': 'Expiration garantie',
        'nbDisquesActuels': 'Nombre de disques actuels',
        'nbDisquesMax': 'Nombre de disques max',
        'capacite': 'Capacity',
        'raid': 'Configuration RAID',
        'luns': 'LUNs',
        'cassettesRDX': 'Cassettes RDX',
        'numeroDisque': 'Disk number',
        'version': 'Version',
        'firmware': 'Version',
        'type': 'Type',
        'typeServer': 'Server type'
      };
      const getFieldLabel = field => {
        return fieldNames[field] || field.charAt(0).toUpperCase() + field.slice(1);
      };
      const modifications = [];
      if (oldItem.name !== (name || item_key)) {
        modifications.push({
          field: 'nom',
          fieldLabel: 'Nom',
          oldValue: oldItem.name || '',
          newValue: name || item_key || ''
        });
      }
      if (oldItem.item_key !== (item_key || name) && oldItem.item_key !== oldItem.name) {
        modifications.push({
          field: 'item_key',
          fieldLabel: 'Key',
          oldValue: oldItem.item_key || '',
          newValue: item_key || name || ''
        });
      }
      for (const key of Object.keys(newData)) {
        let oldValue = oldData[key];
        if (oldValue === undefined || oldValue === null || oldValue === '') {
          if (key === 'marque') {
            oldValue = oldData.fabricant || oldData.manufacturer;
          } else if (key === 'modele') {
            oldValue = oldData.model;
          } else if (key === 'numeroSerie') {
            oldValue = oldData.serial || oldData.serialNumber;
          } else if (key === 'adresseMac') {
            oldValue = oldData.mac || oldData.macAddress;
          } else if (key === 'site') {
            oldValue = oldData.location || oldData.emplacement;
          } else if (key === 'processeur') {
            oldValue = oldData.cpu || oldData.vcpu;
          } else if (key === 'memoire') {
            oldValue = oldData.ram || oldData.memory;
          } else if (key === 'stockage') {
            oldValue = oldData.storage;
          } else if (key === 'systeme') {
            oldValue = oldData.os;
          } else if (key === 'expirationGarantie') {
            oldValue = oldData.garantie;
          } else if (key === 'version') {
            oldValue = oldData.firmware;
          }
        }
        const newValue = newData[key];
        const normalizeValue = val => {
          if (val === null || val === undefined) return null;
          if (val === '') return null;
          if (typeof val === 'string') {
            const trimmed = val.trim();
            return trimmed === '' ? null : trimmed;
          }
          if (Array.isArray(val)) {
            if (val.length === 0) return null;
            return val;
          }
          if (typeof val === 'object' && val !== null) {
            const keys = Object.keys(val);
            if (keys.length === 0) return null;
            return val;
          }
          return val;
        };
        const normalizedOld = normalizeValue(oldValue);
        const normalizedNew = normalizeValue(newValue);
        let hasChanged = false;
        if (normalizedOld === null && normalizedNew === null) {
          hasChanged = false;
        } else if (normalizedOld === null || normalizedNew === null) {
          hasChanged = true;
        } else {
          if (Array.isArray(normalizedOld) && Array.isArray(normalizedNew)) {
            hasChanged = JSON.stringify(normalizedOld) !== JSON.stringify(normalizedNew);
          } else if (typeof normalizedOld === 'object' && typeof normalizedNew === 'object') {
            hasChanged = JSON.stringify(normalizedOld) !== JSON.stringify(normalizedNew);
          } else {
            hasChanged = normalizedOld !== normalizedNew;
          }
        }
        if (hasChanged) {
          modifications.push({
            field: key,
            fieldLabel: getFieldLabel(key),
            oldValue: oldValue,
            newValue: newValue
          });
        }
      }
      for (const mod of modifications) {
        const action = `Field update: ${mod.fieldLabel}`;
        const oldVal = typeof mod.oldValue === 'object' ? JSON.stringify(mod.oldValue) : mod.oldValue || '';
        const newVal = typeof mod.newValue === 'object' ? JSON.stringify(mod.newValue) : mod.newValue || '';
        await pool.query(`INSERT INTO v_b_clients_m_logs 
           (client_id, equipment_family, equipment_name, equipment_id, user_id, user_name, action, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [clientId, family, equipmentName, id, userId, userName, action, JSON.stringify({
          field: mod.field,
          fieldLabel: mod.fieldLabel,
          oldValue: mod.oldValue,
          newValue: mod.newValue
        })]);
      }
    } catch (logError) {}
    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({
      error: "Server error"
    });
  }
});
modulesRouter.patch('/:clientId/:family/checkmk-mapping', requireModulePermission("edit"), async (req, res) => {
  try {
    const {
      clientId,
      family
    } = req.params;
    const {
      equipmentName,
      equipment_id,
      checkmk_host_name,
      checkmk_site,
      checkmk_service_name
    } = req.body || {};
    const table = resolveTable(family);
    if (!table) return res.status(400).json({
      error: "Famille inconnue"
    });
    if ((!equipmentName || !String(equipmentName).trim()) && !equipment_id) {
      return res.status(400).json({
        error: "equipmentName ou equipment_id required"
      });
    }
    const hostName = checkmk_host_name && String(checkmk_host_name).trim() ? String(checkmk_host_name).trim() : null;
    const siteVal = checkmk_site && String(checkmk_site).trim() ? String(checkmk_site).trim() : null;
    const serviceVal = checkmk_service_name && String(checkmk_service_name).trim() ? String(checkmk_service_name).trim() : null;
    const nameVal = equipmentName ? String(equipmentName).trim() : null;
    const equipmentIdVal = equipment_id ? String(equipment_id).trim() : null;
    const columnsResult = await pool.query(`SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`, [table]);
    const availableColumns = new Set(columnsResult.rows.map(r => r.column_name));
    const hasCheckmkColumns = availableColumns.has('checkmk_host_name') && availableColumns.has('checkmk_site') && availableColumns.has('checkmk_service_name');
    const whereClause = equipmentIdVal ? `client_id::text = $4::text AND id::text = $5::text` : `client_id::text = $4::text AND (name = $5 OR item_key = $5 OR (data IS NOT NULL AND data::jsonb->>'nom' = $5))`;
    const whereParams = equipmentIdVal ? [clientId, equipmentIdVal] : [clientId, nameVal];
    let result;
    if (hasCheckmkColumns) {
      result = await pool.query(`UPDATE ${table}
         SET checkmk_host_name = $1::varchar,
             checkmk_site = $2::varchar,
             checkmk_service_name = $3::varchar,
             data = COALESCE(data::jsonb, '{}'::jsonb) || jsonb_build_object(
               'checkmk_host_name', to_jsonb($1::varchar),
               'checkmk_site', to_jsonb($2::varchar),
               'checkmk_service_name', to_jsonb($3::varchar)
             ),
             updated_at = NOW()
         WHERE ${whereClause}
         RETURNING id, checkmk_host_name, checkmk_site, checkmk_service_name`, [hostName, siteVal, serviceVal, ...whereParams]);
    } else {
      result = await pool.query(`UPDATE ${table}
         SET data = COALESCE(data::jsonb, '{}'::jsonb) || jsonb_build_object(
               'checkmk_host_name', to_jsonb($1::varchar),
               'checkmk_site', to_jsonb($2::varchar),
               'checkmk_service_name', to_jsonb($3::varchar)
             ),
             updated_at = NOW()
         WHERE ${whereClause}
         RETURNING id,
                   data::jsonb->>'checkmk_host_name' AS checkmk_host_name,
                   data::jsonb->>'checkmk_site' AS checkmk_site,
                   data::jsonb->>'checkmk_service_name' AS checkmk_service_name`, [hostName, siteVal, serviceVal, ...whereParams]);
    }
    if (result.rows.length === 0) {
      if (equipmentIdVal) {
        return res.status(404).json({
          error: "Equipment not found",
          details: `No row with client_id=${clientId} and id=${equipmentIdVal} in ${table}`
        });
      }
      return res.status(404).json({
        error: "Equipment not found",
        details: `No row with client_id=${clientId} and name="${nameVal}" in ${table}`
      });
    }
    const mapping = result.rows[0];
    res.json({
      checkmk_host_name: mapping.checkmk_host_name,
      checkmk_site: mapping.checkmk_site,
      checkmk_service_name: mapping.checkmk_service_name,
      is_active: true
    });
  } catch (err) {
    console.error("Error PATCH checkmk-mapping:", err);
    res.status(500).json({
      error: "Error updating CheckMK mapping"
    });
  }
});
modulesRouter.delete('/:clientId/:family/:id', requireModulePermission("delete"), async (req, res) => {
  try {
    const {
      clientId,
      family,
      id
    } = req.params;
    const table = resolveTable(family);
    if (!table) return res.status(400).json({
      error: "Famille inconnue"
    });
    const itemResult = await pool.query(`SELECT name, item_key, data FROM ${table}
       WHERE id = $1 AND client_id = $2`, [id, clientId]);
    if (itemResult.rows.length === 0) return res.status(404).json({
      error: "Not found"
    });
    const item = itemResult.rows[0];
    const possibleNames = [];
    if (item.name) possibleNames.push(item.name);
    if (item.item_key) possibleNames.push(item.item_key);
    if (item.data?.nom) possibleNames.push(item.data.nom);
    const result = await pool.query(`DELETE FROM ${table}
       WHERE id = $1 AND client_id = $2
       RETURNING *`, [id, clientId]);
    const familyToEquipmentType = {
      'internet': 'Internet',
      'servers': 'Serveurs',
      'stockage': 'Stockage',
      'firewall': 'Firewalls',
      'switch': 'Switch',
      'wifi': 'BorneWifi',
      'alimentation': 'Alimentation',
      'routeur': 'Routeur',
      'toip': 'TOIP',
      'save': 'Sauvegarde'
    };
    const equipmentType = familyToEquipmentType[family?.toLowerCase()];
    if (equipmentType) {
      try {
        await pool.query(`DELETE FROM v_b_clients_host_mapping 
           WHERE client_id = $1 
           AND equipment_type = $2 
           AND equipment_id = $3`, [clientId, equipmentType, id]);
      } catch (mappingErr) {}
    }
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: "Server error"
    });
  }
});
modulesRouter.post('/:clientId/:family/sync', requireModulePermission("edit"), async (req, res) => {
  try {
    const {
      clientId,
      family
    } = req.params;
    const {
      items
    } = req.body || {};
    const table = resolveTable(family);
    if (!table) return res.status(400).json({
      error: "Famille inconnue"
    });
    if (!clientId) return res.status(400).json({
      error: "clientId required"
    });
    if (!Array.isArray(items)) return res.status(400).json({
      error: "items must be an array"
    });
    const familyToEquipmentType = {
      'internet': 'Internet',
      'servers': 'Serveurs',
      'stockage': 'Stockage',
      'firewall': 'Firewalls',
      'switch': 'Switch',
      'wifi': 'BorneWifi',
      'save': 'Sauvegarde'
    };
    const equipmentType = familyToEquipmentType[family?.toLowerCase()];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existingItemsResult = await client.query(`SELECT name, item_key, data FROM ${table} WHERE client_id = $1`, [clientId]);
      const existingNames = new Set();
      existingItemsResult.rows.forEach(row => {
        if (row.name) existingNames.add(row.name);
        if (row.item_key) existingNames.add(row.item_key);
        if (row.data?.nom) existingNames.add(row.data.nom);
        if (row.data && typeof row.data === 'object') {
          const dataName = row.data.name || row.data.nom || row.data.item_key;
          if (dataName) existingNames.add(dataName);
        }
      });
      let inserted = [];
      let newNames = new Set();
      if (family?.toLowerCase() === 'save' || family?.toLowerCase() === 'antispam') {
        const existingIdsResult = await client.query(`SELECT id FROM ${table} WHERE client_id = $1`, [clientId]);
        const existingIds = new Set(existingIdsResult.rows.map(row => row.id.toString()));
        const processedIds = new Set();
        for (const item of items) {
          const {
            id,
            item_key,
            name,
            data,
            is_active
          } = item;
          const itemId = id ? id.toString() : null;
          const itemName = name || item_key || data?.nom || null;
          if (itemName) newNames.add(itemName);
          if (data && typeof data === 'object') {
            const dataName = data.name || data.nom || data.item_key;
            if (dataName) newNames.add(dataName);
          }
          if (itemId && existingIds.has(itemId)) {
            const result = await client.query(`UPDATE ${table}
               SET item_key = $1, name = $2, data = $3, is_active = $4, updated_at = NOW()
               WHERE id = $5 AND client_id = $6
               RETURNING *`, [item_key || name || null, name || item_key || null, data || null, is_active !== false, itemId, clientId]);
            if (result.rows.length > 0) {
              inserted.push(result.rows[0]);
              processedIds.add(itemId);
            }
          } else {
            const result = await client.query(`INSERT INTO ${table} (client_id, item_key, name, data, is_active)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING *`, [clientId, item_key || name || null, name || item_key || null, data || null, is_active !== false]);
            inserted.push(result.rows[0]);
            if (result.rows[0].id) {
              processedIds.add(result.rows[0].id.toString());
            }
          }
        }
        const idsToDelete = Array.from(existingIds).filter(id => !processedIds.has(id));
        if (idsToDelete.length > 0) {
          await client.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[]) AND client_id = $2`, [idsToDelete, clientId]);
        }
      } else {
        const existingIdsResult = await client.query(`SELECT id FROM ${table} WHERE client_id = $1`, [clientId]);
        const existingIds = new Set(existingIdsResult.rows.map(row => row.id.toString()));
        const processedIds = new Set();
        for (const item of items) {
          const {
            id,
            item_key,
            name,
            data,
            is_active
          } = item;
          const itemId = id ? id.toString() : null;
          const itemName = name || item_key || data?.nom || null;
          if (itemName) newNames.add(itemName);
          if (data && typeof data === 'object') {
            const dataName = data.name || data.nom || data.item_key;
            if (dataName) newNames.add(dataName);
          }
          if (itemId && existingIds.has(itemId)) {
            const result = await client.query(`UPDATE ${table}
               SET item_key = $1, name = $2, data = $3, is_active = $4, updated_at = NOW()
               WHERE id = $5 AND client_id = $6
               RETURNING *`, [item_key || name || null, name || item_key || null, data || null, is_active !== false, itemId, clientId]);
            if (result.rows.length > 0) {
              inserted.push(result.rows[0]);
              processedIds.add(itemId);
            }
          } else {
            const result = await client.query(`INSERT INTO ${table} (client_id, item_key, name, data, is_active)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING *`, [clientId, item_key || name || null, name || item_key || null, data || null, is_active !== false]);
            inserted.push(result.rows[0]);
            if (result.rows[0].id) {
              processedIds.add(result.rows[0].id.toString());
            }
          }
        }
        const idsToDelete = Array.from(existingIds).filter(id => !processedIds.has(id));
        if (idsToDelete.length > 0) {
          await client.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[]) AND client_id = $2`, [idsToDelete, clientId]);
        }
      }
      await client.query('COMMIT');
      res.json({
        success: true,
        items: inserted,
        count: inserted.length
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({
      error: "Server error"
    });
  }
});
router.get('/contacts', async (req, res) => {
  try {
    const clientId = req.query.client_id;
    let query = `
      SELECT 
        c.id,
        c.nom,
        c.prenom,
        c.email,
        c.telephone,
        c.poste,
        c.statut,
        c.client_id,
        cl.name as client_name,
        c.created_at,
        c.updated_at
      FROM v_b_contacts c
      LEFT JOIN v_b_clients cl ON c.client_id = cl.id
    `;
    let params = [];
    if (clientId) {
      query += ` WHERE c.client_id = $1`;
      params.push(parseInt(clientId));
    }
    query += ` ORDER BY c.nom ASC, c.prenom ASC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message
    });
  }
});
router.post('/contacts', verifyJWT, requirePermission('contacts.create'), async (req, res) => {
  try {
    await assertCommunityContactsLimit(1);
    const {
      nom,
      prenom,
      email,
      telephone,
      poste,
      statut,
      client_id
    } = req.body;
    if (!nom) {
      return res.status(400).json({
        error: "Name is required"
      });
    }
    const result = await pool.query(`
      INSERT INTO v_b_contacts (nom, prenom, email, telephone, poste, statut, client_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING id, nom, prenom, email, telephone, poste, statut, client_id, created_at, updated_at
    `, [nom, prenom || null, email || null, telephone || null, poste || null, statut || 'actif', client_id || null]);
    const newContact = result.rows[0];
    res.status(201).json(newContact);
  } catch (err) {
    if (err?.code?.startsWith("COMMUNITY_")) {
      return sendCommunityLimitError(res, err);
    }
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message
    });
  }
});
router.put('/contacts/:id', verifyJWT, requirePermission('contacts.edit'), async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const {
      nom,
      prenom,
      email,
      telephone,
      poste,
      statut,
      client_id
    } = req.body;
    if (!nom) {
      return res.status(400).json({
        error: "Name is required"
      });
    }
    const result = await pool.query(`
      UPDATE v_b_contacts
      SET nom = $1, prenom = $2, email = $3, telephone = $4, poste = $5, statut = $6, client_id = $7, updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING id, nom, prenom, email, telephone, poste, statut, client_id, created_at, updated_at
    `, [nom, prenom || null, email || null, telephone || null, poste || null, statut || 'actif', client_id || null, parseInt(id)]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Contact not found"
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message
    });
  }
});
router.delete('/contacts/:id', verifyJWT, requirePermission('contacts.delete'), async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const result = await pool.query(`
      DELETE FROM v_b_contacts
      WHERE id = $1
      RETURNING id
    `, [parseInt(id)]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Contact not found"
      });
    }
    res.json({
      success: true,
      message: "Contact deleted"
    });
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message
    });
  }
});
export const modulesRouterExport = modulesRouter;
export default router;
