import fetch from "node-fetch";
import { pool } from "../database/db.js";
import { sendMail } from "../utils/sendMail.js";
import { loadNotificationSettingsRaw, saveNotificationLogsRaw } from "./ticketAutomationConfigStore.js";

const WEBHOOK_CHANNELS = new Set(["webhook", "teams", "slack"]);
const MAX_LOGS = 500;
let clientsColumnsCache = null;

function normalizeTeamsThemeColor(value) {
  const raw = String(value || "").trim();
  if (!raw) return "13BA8E";
  const noHash = raw.startsWith("#") ? raw.slice(1) : raw;
  return /^[0-9a-fA-F]{6}$/.test(noHash) ? noHash.toUpperCase() : "13BA8E";
}

function normalizeEventRules(settings = {}) {
  return (Array.isArray(settings.notificationEvents) ? settings.notificationEvents : [])
    .map((rule) => ({
      id: String(rule?.id || ""),
      source: String(rule?.source || "").trim().toLowerCase(),
      element: String(rule?.element || "").trim().toLowerCase(),
      scopeType: String(rule?.scopeType || "all").trim().toLowerCase() === "enterprise" ? "enterprise" : "all",
      enterpriseId: String(rule?.enterpriseId || "").trim(),
      channel: String(rule?.channel || "webhook").trim().toLowerCase(),
      webhookId: String(rule?.webhookId || "").trim(),
      emailTo: String(rule?.emailTo || "").trim(),
      emailCc: String(rule?.emailCc || "").trim(),
      useTemplate: rule?.useTemplate === true,
      templateId: String(rule?.templateId || "").trim(),
      customMessage: String(rule?.customMessage || ""),
      teamsThemeColor: String(rule?.teamsThemeColor || "#13BA8E"),
      enabled: rule?.enabled !== false,
      daysBefore: Number.isFinite(Number(rule?.daysBefore)) ? Number(rule.daysBefore) : 30,
    }))
    .filter((rule) => rule.source && rule.element && rule.enabled);
}

function getByPath(source, pathSegments = []) {
  return pathSegments.reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[key];
  }, source);
}

function formatTemplateValue(value) {
  if (value === true) return "Oui";
  if (value === false) return "Non";
  return value;
}

function getBooleanTokenLabel(token = "") {
  const cleanToken = String(token || "").trim();
  if (cleanToken === "entreprise.contrat.suspendu") return "Contrat suspendu";
  if (cleanToken.startsWith("entreprise.optionsContrat.")) {
    return cleanToken.split(".").pop() || "Option";
  }
  if (cleanToken.startsWith("entreprise.modulesMonitoring.")) {
    return cleanToken.split(".").pop() || "Module";
  }
  return "";
}

function formatTokenValue(token = "", value) {
  if (typeof value === "boolean") {
    const label = getBooleanTokenLabel(token);
    const boolText = formatTemplateValue(value);
    return label ? `${label} : ${boolText}` : boolText;
  }
  return formatTemplateValue(value);
}

function resolveTemplateToken(token = "", context = {}) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) return "";

  const directValue = getByPath(context, cleanToken.split("."));
  const formattedDirectValue = formatTokenValue(cleanToken, directValue);
  if (formattedDirectValue !== undefined && formattedDirectValue !== null && String(formattedDirectValue) !== "") {
    return formattedDirectValue;
  }

  const now = context?.now && typeof context.now === "object" ? context.now : {};
  const eventDate = context?.eventDate && typeof context.eventDate === "object" ? context.eventDate : {};
  const entreprise = context?.entreprise && typeof context.entreprise === "object" ? context.entreprise : {};
  const user = context?.user && typeof context.user === "object" ? context.user : {};
  const agent = context?.agent && typeof context.agent === "object" ? context.agent : {};
  const changes = Array.isArray(context?.changes) ? context.changes : [];
  const changedFields = Array.isArray(context?.changedFields)
    ? context.changedFields
    : changes.map((item) => item?.field).filter(Boolean);

  const nowDate = new Date();
  const fallbackMap = {
    "now.iso": now.iso || nowDate.toISOString(),
    "now.fr": now.fr || nowDate.toLocaleString("fr-FR"),
    "now.date": now.date || nowDate.toLocaleDateString("fr-FR"),
    "now.time": now.time || nowDate.toLocaleTimeString("fr-FR"),
    "now.year": now.year || String(nowDate.getFullYear()),
    "now.month": now.month || String(nowDate.getMonth() + 1).padStart(2, "0"),
    "now.day": now.day || String(nowDate.getDate()).padStart(2, "0"),
    "eventDate.iso": eventDate.iso || context?.timestamp || "",
    "eventDate.fr": eventDate.fr || "",
    "eventDate.date": eventDate.date || "",
    "eventDate.time": eventDate.time || "",
    "eventDate.year": eventDate.year || "",
    "eventDate.month": eventDate.month || "",
    "eventDate.day": eventDate.day || "",
    timestamp: context?.timestamp || "",
    "entreprise.id": entreprise.id || context?.enterpriseId || "",
    "entreprise.nom": entreprise.nom || context?.enterpriseName || "",
    "agent.id": agent.id || user.id || "",
    "agent.username": agent.username || user.username || user.email || "Utilisateur",
    "agent.email": agent.email || user.email || "",
    "agent.role": agent.role || user.role || "",
    "user.id": user.id || agent.id || "",
    "user.username": user.username || agent.username || user.email || "Utilisateur",
    "user.email": user.email || agent.email || "",
    "user.role": user.role || agent.role || "",
  };

  if (Object.prototype.hasOwnProperty.call(fallbackMap, cleanToken)) {
    return formatTokenValue(cleanToken, fallbackMap[cleanToken]);
  }

  const changedFieldMatch = cleanToken.match(/^changedFields\.(\d+)$/);
  if (changedFieldMatch) {
    const idx = Number(changedFieldMatch[1]);
    return changedFields[idx] ?? "";
  }

  const changesMatch = cleanToken.match(/^changes\.(\d+)\.(field|oldValue|newValue)$/);
  if (changesMatch) {
    const idx = Number(changesMatch[1]);
    const key = changesMatch[2];
    return formatTokenValue(cleanToken, changes[idx]?.[key] ?? "");
  }

  if (cleanToken === "changedFields") {
    return changedFields.join(", ");
  }
  if (cleanToken === "changes") {
    try {
      return JSON.stringify(changes);
    } catch (_error) {
      return "";
    }
  }

  return "";
}

function renderTemplate(content = "", context = {}) {
  const src = String(content || "");
  return src.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_m, tokenRaw) => {
    const token = String(tokenRaw || "").trim();
    const value = resolveTemplateToken(token, context);
    if (value === null || value === undefined || String(value) === "") {
      return `{{${token}}}`;
    }
    return String(value);
  });
}

function buildDefaultMessage(event = {}, context = {}) {
  const source = String(event.source || "").toUpperCase();
  const element = String(event.element || "").toUpperCase();
  const entreprise = String(context?.entreprise?.nom || context?.enterpriseName || "").trim();
  const target = entreprise ? ` | Entreprise: ${entreprise}` : "";
  return `Veritas - Notification ${source}.${element}${target}`;
}

function buildNotificationDetailLines(context = {}) {
  const details = [];
  const enterpriseName = String(context?.entreprise?.nom || context?.enterpriseName || "").trim();
  if (enterpriseName) details.push(`Entreprise: ${enterpriseName}`);

  const changedFields = Array.isArray(context?.changedFields)
    ? context.changedFields.filter(Boolean).map((item) => String(item))
    : [];
  if (changedFields.length > 0) {
    details.push(`Champs modifiés: ${changedFields.join(", ")}`);
  }

  const changes = Array.isArray(context?.changes) ? context.changes : [];
  if (changes.length > 0) {
    const preview = changes
      .slice(0, 6)
      .map((change) => {
        const label = String(change?.field || "champ");
        const oldValue = change?.oldValue ?? "-";
        const newValue = change?.newValue ?? "-";
        return `${label}: "${oldValue}" -> "${newValue}"`;
      })
      .join(" | ");
    if (preview) details.push(`Détails: ${preview}`);
  }

  const materialName = String(context?.material?.name || context?.materialName || "").trim();
  if (materialName) details.push(`Matériel: ${materialName}`);

  const ticket = context?.ticket && typeof context.ticket === "object" ? context.ticket : null;
  if (ticket) {
    if (ticket.ticket_number || ticket.id) details.push(`Ticket: #${ticket.ticket_number || ticket.id}`);
    if (ticket.title) details.push(`Titre ticket: ${ticket.title}`);
    if (ticket.status) details.push(`Statut ticket: ${ticket.status}`);
  }

  const contact = context?.contact && typeof context.contact === "object" ? context.contact : null;
  if (contact) {
    const contactName = [contact.prenom, contact.nom].filter(Boolean).join(" ").trim();
    if (contactName) details.push(`Contact: ${contactName}`);
    if (contact.email) details.push(`Email contact: ${contact.email}`);
  }

  const campaign = context?.campaign && typeof context.campaign === "object" ? context.campaign : null;
  if (campaign) {
    if (campaign.name) details.push(`Campagne: ${campaign.name}`);
    if (campaign.status) details.push(`Statut campagne: ${campaign.status}`);
    if (campaign.start_date) details.push(`Début campagne: ${campaign.start_date}`);
    if (campaign.end_date) details.push(`Fin campagne: ${campaign.end_date}`);
  }

  const report = context?.report && typeof context.report === "object" ? context.report : null;
  if (report) {
    if (report.name) details.push(`Rapport: ${report.name}`);
    if (report.report_period) details.push(`Période rapport: ${report.report_period}`);
  }

  return details;
}

function extractTeamsImageUrls(message = "") {
  const src = String(message || "");
  const urls = [];
  const pushUrl = (candidate) => {
    const value = String(candidate || "").trim();
    if (!/^https?:\/\//i.test(value)) return;
    if (urls.includes(value)) return;
    urls.push(value);
  };
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let imgMatch = imgRegex.exec(src);
  while (imgMatch) {
    pushUrl(imgMatch[1]);
    imgMatch = imgRegex.exec(src);
  }
  const mdRegex = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi;
  let mdMatch = mdRegex.exec(src);
  while (mdMatch) {
    pushUrl(mdMatch[1]);
    mdMatch = mdRegex.exec(src);
  }
  return urls.slice(0, 4);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function getObjectValueCaseInsensitive(source = {}, keys = []) {
  if (!source || typeof source !== "object") return undefined;
  const entries = Object.entries(source);
  for (const key of keys) {
    const direct = source[key];
    if (direct !== undefined) return direct;
    const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const found = entries.find(
      ([entryKey]) => String(entryKey || "").toLowerCase().replace(/[^a-z0-9]/g, "") === normalized
    );
    if (found) return found[1];
  }
  return undefined;
}

async function getClientsAvailableColumns() {
  if (clientsColumnsCache instanceof Set && clientsColumnsCache.size > 0) {
    return clientsColumnsCache;
  }
  const result = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'v_b_clients'`
  );
  clientsColumnsCache = new Set(result.rows.map((row) => String(row.column_name || "").trim()));
  return clientsColumnsCache;
}

function getNormalizedFlagValue(source = {}, candidates = []) {
  const map = new Map();
  Object.entries(source || {}).forEach(([key, value]) => {
    const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    map.set(normalized, value);
  });
  for (const candidate of candidates) {
    const normalizedCandidate = String(candidate || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (map.has(normalizedCandidate)) {
      return map.get(normalizedCandidate);
    }
  }
  return false;
}

function mergePreferHydrated(baseValue, incomingValue) {
  if (incomingValue === undefined || incomingValue === null) return baseValue;
  if (Array.isArray(baseValue) || Array.isArray(incomingValue)) {
    const incomingArray = Array.isArray(incomingValue) ? incomingValue : [];
    if (incomingArray.length > 0) return incomingArray;
    return Array.isArray(baseValue) ? baseValue : incomingArray;
  }
  if (
    baseValue &&
    typeof baseValue === "object" &&
    !Array.isArray(baseValue) &&
    incomingValue &&
    typeof incomingValue === "object" &&
    !Array.isArray(incomingValue)
  ) {
    const merged = { ...baseValue };
    Object.keys(incomingValue).forEach((key) => {
      merged[key] = mergePreferHydrated(baseValue?.[key], incomingValue?.[key]);
    });
    return merged;
  }
  if (typeof incomingValue === "string") {
    const trimmed = incomingValue.trim();
    return trimmed === "" ? baseValue : incomingValue;
  }
  return incomingValue;
}

function truthyValue(value) {
  if (value === true) return true;
  const raw = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "oui"].includes(raw);
}

function buildEnabledListString(obj = {}) {
  if (!obj || typeof obj !== "object") return "";
  const entries = Object.entries(obj)
    .filter(([, value]) => truthyValue(value))
    .map(([key]) => String(key || "").trim())
    .filter(Boolean);
  return entries.join(" / ");
}

async function safeCountByClient(tableName, enterpriseId) {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM ${tableName}
       WHERE client_id::text = $1`,
      [String(enterpriseId || "")]
    );
    return Number(result.rows?.[0]?.total || 0);
  } catch (_error) {
    return 0;
  }
}

async function loadCommercialContext(commercialId) {
  const defaultCommercial = {
    id: String(commercialId || ""),
    username: "",
    email: "",
    role: "",
    isActive: "",
    profile: "",
  };
  if (!commercialId) return defaultCommercial;

  const sql = `SELECT id, username, email, role, is_active, profile
               FROM __TABLE__
               WHERE id::text = $1
               LIMIT 1`;
  const candidates = ["v_b_user", "v_b_users"];
  for (const tableName of candidates) {
    try {
      const result = await pool.query(sql.replace("__TABLE__", tableName), [String(commercialId)]);
      const row = result.rows?.[0];
      if (!row) continue;
      return {
        id: String(row.id || commercialId || ""),
        username: String(row.username || ""),
        email: String(row.email || ""),
        role: String(row.role || ""),
        isActive:
          row.is_active === true || row.is_active === false
            ? row.is_active
            : String(row.is_active || ""),
        profile:
          row.profile && typeof row.profile === "object"
            ? row.profile
            : String(row.profile || ""),
      };
    } catch (error) {
      if (error?.code === "42P01") {
        continue;
      }
      return defaultCommercial;
    }
  }
  return defaultCommercial;
}

async function loadEnterpriseContext(enterpriseId) {
  if (!enterpriseId) return {};
  let clientRow = null;
  try {
    const availableColumns = await getClientsAvailableColumns();
    const preferredColumns = [
      "id",
      "name",
      "siret",
      "address",
      "adresse",
      "secteur",
      "sector",
      "commercial_id",
      "commercial",
      "username",
      "email",
      "user_email",
      "contrat",
      "options",
      "modules",
      "sites",
      "created_at",
      "updated_at",
    ];
    const selectedColumns = preferredColumns.filter((column) => availableColumns.has(column));
    if (!selectedColumns.includes("id")) selectedColumns.unshift("id");
    if (!selectedColumns.includes("name")) selectedColumns.push("name");
    const clientResult = await pool.query(
      `SELECT ${selectedColumns.map((column) => `c.${column}`).join(", ")}
       FROM v_b_clients c
       WHERE c.id::text = $1
       LIMIT 1`,
      [String(enterpriseId)]
    );
    clientRow = clientResult.rows?.[0] || null;
  } catch (_error) {
    clientRow = null;
  }

  const contrat = parseJsonObject(clientRow?.contrat);
  const options = parseJsonObject(clientRow?.options);
  const modulesMonitoring = parseJsonObject(clientRow?.modules);
  const sitesRaw = clientRow?.sites;
  const sites = Array.isArray(sitesRaw) ? sitesRaw : parseJsonObject(sitesRaw);
  const sitesList = Array.isArray(sites) ? sites : [];

  let commercial = {
    id: String(clientRow?.commercial_id || ""),
    username: String(clientRow?.username || clientRow?.commercial || ""),
    email: String(clientRow?.user_email || clientRow?.email || ""),
    role: "",
    isActive: "",
    profile: "",
  };
  if (commercial.id) {
    const dbCommercial = await loadCommercialContext(commercial.id);
    commercial = {
      ...commercial,
      ...dbCommercial,
      id: String(dbCommercial.id || commercial.id || ""),
      username: String(dbCommercial.username || commercial.username || ""),
      email: String(dbCommercial.email || commercial.email || ""),
    };
  }

  const [
    infraInternetCount,
    infraFirewallCount,
    infraServerCount,
    infraStorageCount,
    infraSwitchCount,
    infraWifiCount,
    antivirusCount,
    antispamCount,
    domainCount,
    tenantCount,
    backupCount,
  ] = await Promise.all([
    safeCountByClient("v_b_clients_m_internet", enterpriseId),
    safeCountByClient("v_b_clients_m_firewall", enterpriseId),
    safeCountByClient("v_b_clients_m_servers", enterpriseId),
    safeCountByClient("v_b_clients_m_stockage", enterpriseId),
    safeCountByClient("v_b_clients_m_switch", enterpriseId),
    safeCountByClient("v_b_clients_m_wifi", enterpriseId),
    safeCountByClient("v_b_clients_m_antivirus", enterpriseId),
    safeCountByClient("v_b_clients_m_antispam", enterpriseId),
    safeCountByClient("v_b_clients_m_ndd", enterpriseId),
    safeCountByClient("v_b_clients_m_o365", enterpriseId),
    safeCountByClient("v_b_clients_m_save", enterpriseId),
  ]);

  let domainNames = [];
  try {
    const domainsResult = await pool.query(
      `SELECT name
       FROM v_b_clients_m_ndd
       WHERE client_id::text = $1
       ORDER BY name ASC`,
      [String(enterpriseId)]
    );
    domainNames = domainsResult.rows.map((row) => String(row?.name || "").trim()).filter(Boolean);
  } catch (_error) {
    domainNames = [];
  }

  let tenantNames = [];
  try {
    const tenantResult = await pool.query(
      `SELECT name, item_key
       FROM v_b_clients_m_o365
       WHERE client_id::text = $1
       ORDER BY name ASC`,
      [String(enterpriseId)]
    );
    tenantNames = tenantResult.rows
      .map((row) => String(row?.name || row?.item_key || "").trim())
      .filter(Boolean);
  } catch (_error) {
    tenantNames = [];
  }

  const contractStart =
    contrat?.debut || contrat?.start || contrat?.date_debut || contrat?.start_date || "";
  const contractEnd =
    contrat?.expiration || contrat?.fin || contrat?.date_fin || contrat?.end || contrat?.end_date || "";
  const contractSuspended = Boolean(contrat?.suspendu === true || contrat?.suspended === true);
  const contractStatus = contractSuspended ? "Suspendu" : "Actif";
  const contractType = String(
    getObjectValueCaseInsensitive(contrat, ["type", "entreprise_type", "type_entreprise"]) ||
      getObjectValueCaseInsensitive(options, ["type"]) ||
      ""
  ).trim();
  const optionsNormalized = {
    Curatif: getNormalizedFlagValue(options, ["Curatif"]),
    Support: getNormalizedFlagValue(options, ["Support"]),
    Preventif: getNormalizedFlagValue(options, ["Preventif", "Préventif"]),
    Hebergement: getNormalizedFlagValue(options, ["Hebergement", "Hébergement"]),
    Monitoring: getNormalizedFlagValue(options, ["Monitoring"]),
  };
  const modulesNormalized = {
    Internet: getNormalizedFlagValue(modulesMonitoring, ["Internet"]),
    Firewall: getNormalizedFlagValue(modulesMonitoring, ["Firewall"]),
    Serveurs: getNormalizedFlagValue(modulesMonitoring, ["Serveurs", "Servers"]),
    Stockage: getNormalizedFlagValue(modulesMonitoring, ["Stockage", "Storage"]),
    Switch: getNormalizedFlagValue(modulesMonitoring, ["Switch"]),
    BorneWifi: getNormalizedFlagValue(modulesMonitoring, ["BorneWifi", "Wifi", "Borne WiFi"]),
    Antivirus: getNormalizedFlagValue(modulesMonitoring, ["Antivirus"]),
    Antispam: getNormalizedFlagValue(modulesMonitoring, ["Antispam"]),
    NDD: getNormalizedFlagValue(modulesMonitoring, ["NDD", "NomDeDomaine"]),
    Office365: getNormalizedFlagValue(modulesMonitoring, ["Office365", "O365", "Microsoft365"]),
    Sauvegarde: getNormalizedFlagValue(modulesMonitoring, ["Sauvegarde", "Backup", "Save"]),
  };
  const optionsEnabledRaw = buildEnabledListString(optionsNormalized);
  const modulesEnabledRaw = buildEnabledListString(modulesNormalized);
  const optionsEnabledList = optionsEnabledRaw ? `Options : ${optionsEnabledRaw}` : "Options : Aucun";
  const modulesEnabledList = modulesEnabledRaw ? `Modules : ${modulesEnabledRaw}` : "Modules : Aucun";

  return {
    id: String(clientRow?.id || enterpriseId || ""),
    nom: String(clientRow?.name || ""),
    name: String(clientRow?.name || ""),
    siret: String(clientRow?.siret || ""),
    adresse: String(clientRow?.address || clientRow?.adresse || clientRow?.location || ""),
    address: String(clientRow?.address || clientRow?.adresse || clientRow?.location || ""),
    secteur: String(clientRow?.secteur || clientRow?.sector || clientRow?.activity || ""),
    secteurActivite: String(clientRow?.secteur || clientRow?.sector || clientRow?.activity || ""),
    lieux: sitesList,
    lieuxCount: sitesList.length,
    commercial,
    contrat,
    contratStatut: contractStatus,
    contratSuspendu: contractSuspended,
    contratTypeEntreprise: contractType,
    contratDateDebut: String(contractStart || ""),
    contratDateFin: String(contractEnd || ""),
    optionsContrat: optionsNormalized,
    options: optionsEnabledList,
    modulesMonitoring: modulesNormalized,
    modules: modulesEnabledList,
    infra: {
      internetCount: infraInternetCount,
      firewallCount: infraFirewallCount,
      serverCount: infraServerCount,
      storageCount: infraStorageCount,
      switchCount: infraSwitchCount,
      wifiCount: infraWifiCount,
    },
    cyber: {
      antivirusCount,
      antispamCount,
      backupCount,
    },
    services: {
      domainCount,
      domainNames,
      tenantCount,
      tenantNames,
    },
    monitoring: {
      backupCount,
      antivirusCount,
      antispamCount,
      domainCount,
      tenantCount,
    },
  };
}

async function sendWebhookMessage({ channel, url, message, context = {} }) {
  if (!url) throw new Error("URL webhook manquante");
  let payload;
  if (channel === "teams") {
    const teamsImages = extractTeamsImageUrls(message);
    const teamsThemeColor = normalizeTeamsThemeColor(context?.teamsThemeColor);
    payload = {
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      summary: "Veritas - Notification",
      themeColor: teamsThemeColor,
      title: "Veritas - Notification",
      text: String(message || ""),
      sections: [
        {
          images: teamsImages.map((imageUrl) => ({
            image: imageUrl,
            title: "Image",
          })),
        },
      ],
    };
  } else if (channel === "slack") {
    payload = { text: String(message || "") };
  } else {
    payload = {
      text: String(message || ""),
      source: context?.source || null,
      element: context?.element || null,
      enterpriseId: context?.enterpriseId || null,
      timestamp: new Date().toISOString(),
    };
  }
  const response = await fetch(String(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Webhook a répondu ${response.status}`);
  }
}

function parseEmailList(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

async function sendEmailMessage({ toRaw, ccRaw, message, context = {} }) {
  const toList = parseEmailList(toRaw);
  const ccList = parseEmailList(ccRaw);
  if (toList.length === 0) {
    throw new Error("Aucun destinataire email configuré");
  }
  const title = `Veritas - Notification ${String(context?.source || "").toUpperCase()}.${String(context?.element || "").toUpperCase()}`;
  const htmlContent = String(message || "").replace(/\n/g, "<br>");
  const to = toList.join(", ");
  const cc = ccList.length > 0 ? ccList.join(", ") : undefined;
  await sendMail({
    to,
    cc,
    subject: title,
    title,
    htmlContent,
  });
}

async function appendNotificationLogs(logEntries = []) {
  if (!Array.isArray(logEntries) || logEntries.length === 0) return;
  const settings = await loadNotificationSettingsRaw();
  const existingLogs = Array.isArray(settings?.logs) ? settings.logs : [];
  const nextLogs = [...logEntries, ...existingLogs].slice(0, MAX_LOGS);
  await saveNotificationLogsRaw(nextLogs);
}

export async function dispatchNotificationEvent(event = {}) {
  const source = String(event?.source || "").trim().toLowerCase();
  const element = String(event?.element || "").trim().toLowerCase();
  const enterpriseId = String(event?.enterpriseId || "").trim();
  if (!source || !element) return { matched: 0, sent: 0 };

  const settings = await loadNotificationSettingsRaw();
  const rules = normalizeEventRules(settings);
  const webhooks = Array.isArray(settings?.webhooks) ? settings.webhooks : [];
  const templates = Array.isArray(settings?.templates) ? settings.templates : [];

  const matchingRules = rules.filter((rule) => {
    if (rule.source !== source || rule.element !== element) return false;
    if (rule.scopeType === "enterprise") {
      return enterpriseId && rule.enterpriseId && String(rule.enterpriseId) === String(enterpriseId);
    }
    return true;
  });

  if (matchingRules.length === 0) return { matched: 0, sent: 0 };

  const logs = [];
  let sentCount = 0;
  const occurredAtRaw = event?.occurredAt ? new Date(event.occurredAt) : new Date();
  const occurredAtDate = Number.isNaN(occurredAtRaw.getTime()) ? new Date() : occurredAtRaw;
  const nowDate = new Date();
  let enterpriseNameById = "";
  let enterpriseContext = {};
  if (enterpriseId) {
    try {
      const enterpriseResult = await pool.query(
        `SELECT name
         FROM v_b_clients
         WHERE id = $1
         LIMIT 1`,
        [enterpriseId]
      );
      enterpriseNameById = String(enterpriseResult.rows?.[0]?.name || "").trim();
    } catch (_error) {
      enterpriseNameById = "";
    }
    enterpriseContext = await loadEnterpriseContext(enterpriseId).catch(() => ({}));
  }

  for (const rule of matchingRules) {
    const userRaw = event?.user && typeof event.user === "object" ? event.user : {};
    const userId = String(userRaw.id || userRaw.user_id || "").trim();
    const userEmail = String(userRaw.email || "").trim();
    const userName = String(userRaw.username || userRaw.name || userRaw.nom || userEmail || userId || "").trim();
    const currentUser = {
      id: userId,
      username: userName,
      email: userEmail || userName,
      role: String(userRaw.role || "").trim(),
    };

    const incomingEntreprise =
      event?.context?.entreprise && typeof event.context.entreprise === "object" ? event.context.entreprise : {};
    const mergedEntreprise = mergePreferHydrated(enterpriseContext, incomingEntreprise);
    const hydratedEntreprise = {
      ...mergedEntreprise,
      id: String(
        mergedEntreprise?.id || incomingEntreprise?.id || enterpriseContext?.id || enterpriseId || ""
      ).trim(),
      nom: String(
        mergedEntreprise?.nom ||
          mergedEntreprise?.name ||
          incomingEntreprise?.nom ||
          enterpriseContext?.nom ||
          enterpriseNameById ||
          ""
      ).trim(),
      address: String(
        mergedEntreprise?.address || mergedEntreprise?.adresse || enterpriseContext?.address || ""
      ).trim(),
      adresse: String(
        mergedEntreprise?.adresse || mergedEntreprise?.address || enterpriseContext?.adresse || ""
      ).trim(),
      secteur: String(
        mergedEntreprise?.secteur || mergedEntreprise?.secteurActivite || enterpriseContext?.secteur || ""
      ).trim(),
      secteurActivite: String(
        mergedEntreprise?.secteurActivite || mergedEntreprise?.secteur || enterpriseContext?.secteurActivite || ""
      ).trim(),
      contratTypeEntreprise: String(
        mergedEntreprise?.contratTypeEntreprise || mergedEntreprise?.contrat?.type || ""
      ).trim(),
      commercial:
        mergedEntreprise?.commercial && typeof mergedEntreprise.commercial === "object"
          ? {
              id: String(mergedEntreprise.commercial.id || enterpriseContext?.commercial?.id || "").trim(),
              username: String(
                mergedEntreprise.commercial.username || enterpriseContext?.commercial?.username || ""
              ).trim(),
              email: String(
                mergedEntreprise.commercial.email || enterpriseContext?.commercial?.email || ""
              ).trim(),
            }
          : enterpriseContext?.commercial || {},
    };

    const changedFieldsRaw = Array.isArray(event?.context?.changedFields) ? event.context.changedFields : [];
    const changedFields = changedFieldsRaw.map((field) => String(field || "").trim()).filter(Boolean);
    const changesRaw = Array.isArray(event?.context?.changes) ? event.context.changes : [];
    const changes = changesRaw.map((change) => ({
      ...change,
      field: String(change?.field || "").trim(),
      oldValue: change?.oldValue ?? "",
      newValue: change?.newValue ?? "",
    }));

    const context = {
      ...(event?.context || {}),
      source,
      element,
      enterpriseId: enterpriseId || null,
      enterpriseName: String(event?.context?.enterpriseName || enterpriseNameById || "").trim(),
      teamsThemeColor: rule.teamsThemeColor || "#13BA8E",
      entreprise: hydratedEntreprise,
      enterprise: hydratedEntreprise,
      changedFields,
      changes,
      user: currentUser,
      agent: currentUser,
      now: {
        iso: nowDate.toISOString(),
        fr: nowDate.toLocaleString("fr-FR"),
        date: nowDate.toLocaleDateString("fr-FR"),
        time: nowDate.toLocaleTimeString("fr-FR"),
        year: String(nowDate.getFullYear()),
        month: String(nowDate.getMonth() + 1).padStart(2, "0"),
        day: String(nowDate.getDate()).padStart(2, "0"),
      },
      eventDate: {
        iso: occurredAtDate.toISOString(),
        fr: occurredAtDate.toLocaleString("fr-FR"),
        date: occurredAtDate.toLocaleDateString("fr-FR"),
        time: occurredAtDate.toLocaleTimeString("fr-FR"),
        year: String(occurredAtDate.getFullYear()),
        month: String(occurredAtDate.getMonth() + 1).padStart(2, "0"),
        day: String(occurredAtDate.getDate()).padStart(2, "0"),
      },
      timestamp: occurredAtDate.toISOString(),
    };
    if (rule.channel !== "mail" && !WEBHOOK_CHANNELS.has(rule.channel)) {
      logs.push({
        id: `notif-log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        source,
        element,
        channel: rule.channel,
        status: "skipped",
        message: `Canal ${rule.channel} non pris en charge en runtime`,
        enterpriseId: enterpriseId || "",
      });
      continue;
    }
    const template = rule.useTemplate
      ? templates.find((tpl) => String(tpl?.id || "") === String(rule.templateId || ""))
      : null;
    const customMessage = !rule.useTemplate ? renderTemplate(rule.customMessage || "", context) : "";
    const resolvedMessage = template
      ? renderTemplate(template.content || template.body || "", context)
      : String(customMessage || "").trim() || buildDefaultMessage({ source, element }, context);

    if (rule.channel === "mail") {
      try {
        await sendEmailMessage({
          toRaw: rule.emailTo,
          ccRaw: rule.emailCc,
          message: resolvedMessage,
          context,
        });
        sentCount += 1;
        logs.push({
          id: `notif-log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          createdAt: new Date().toISOString(),
          source,
          element,
          channel: "mail",
          status: "success",
          message: `Email envoyé vers ${rule.emailTo || "-"}`,
          enterpriseId: enterpriseId || "",
        });
      } catch (error) {
        logs.push({
          id: `notif-log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          createdAt: new Date().toISOString(),
          source,
          element,
          channel: "mail",
          status: "error",
          message: error?.message || "Échec envoi email",
          enterpriseId: enterpriseId || "",
        });
      }
      continue;
    }
    const webhook = webhooks.find((w) => String(w?.id || "") === String(rule.webhookId || ""));
    if (!webhook || webhook.enabled === false || !String(webhook.url || "").trim()) {
      logs.push({
        id: `notif-log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        source,
        element,
        channel: rule.channel,
        status: "error",
        message: "Webhook introuvable ou désactivé",
        enterpriseId: enterpriseId || "",
      });
      continue;
    }
    const webhookChannel = String(webhook?.channel || "").trim().toLowerCase();
    const effectiveChannel = WEBHOOK_CHANNELS.has(webhookChannel) ? webhookChannel : rule.channel;
    const message = resolvedMessage;

    try {
      await sendWebhookMessage({
        channel: effectiveChannel,
        url: String(webhook.url || "").trim(),
        message: String(message || "").trim() || buildDefaultMessage({ source, element }, context),
        context,
      });
      sentCount += 1;
      logs.push({
        id: `notif-log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        source,
        element,
        channel: effectiveChannel,
        status: "success",
        message: `Notification envoyée vers ${webhook.name || "webhook"}`,
        enterpriseId: enterpriseId || "",
      });
    } catch (error) {
      logs.push({
        id: `notif-log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        source,
        element,
        channel: effectiveChannel,
        status: "error",
        message: error?.message || "Échec envoi webhook",
        enterpriseId: enterpriseId || "",
      });
    }
  }

  await appendNotificationLogs(logs).catch(() => {});
  return { matched: matchingRules.length, sent: sentCount };
}

function parseDate(value) {
  if (!value) return null;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function getDaysUntil(targetDate) {
  const now = new Date();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const startNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startTarget = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()).getTime();
  return Math.floor((startTarget - startNow) / oneDayMs);
}

function extractContractEndDate(contratRaw) {
  const contrat = contratRaw && typeof contratRaw === "object" ? contratRaw : {};
  const candidates = [
    contrat.endDate,
    contrat.end_date,
    contrat.expirationDate,
    contrat.expiration_date,
    contrat.date_fin,
    contrat.contract_end_date,
  ];
  for (const candidate of candidates) {
    const parsed = parseDate(candidate);
    if (parsed) return parsed;
  }
  return null;
}

export async function runNotificationSoonScheduler() {
  const settings = await loadNotificationSettingsRaw();
  const rules = normalizeEventRules(settings).filter((rule) => rule.element.includes("_soon") || rule.element.endsWith("_expired") || rule.element.endsWith("_reached"));
  if (rules.length === 0) return;

  const contractRules = rules.filter((rule) => rule.source === "entreprise" && (rule.element === "contract_expiration_soon" || rule.element === "contract_expired"));
  if (contractRules.length > 0) {
    const clientsResult = await pool.query(`SELECT id, name, contrat FROM v_b_clients`);
    for (const client of clientsResult.rows) {
      const endDate = extractContractEndDate(client?.contrat);
      if (!endDate) continue;
      const daysUntil = getDaysUntil(endDate);
      for (const rule of contractRules) {
        if (rule.element === "contract_expiration_soon" && daysUntil === Number(rule.daysBefore || 0)) {
          await dispatchNotificationEvent({
            source: "entreprise",
            element: "contract_expiration_soon",
            enterpriseId: String(client.id || ""),
            context: {
              entreprise: { id: String(client.id || ""), nom: client.name || "" },
              contractEndDate: endDate.toISOString(),
              daysUntil,
            },
          }).catch(() => {});
        }
        if (rule.element === "contract_expired" && daysUntil <= 0) {
          await dispatchNotificationEvent({
            source: "entreprise",
            element: "contract_expired",
            enterpriseId: String(client.id || ""),
            context: {
              entreprise: { id: String(client.id || ""), nom: client.name || "" },
              contractEndDate: endDate.toISOString(),
              daysUntil,
            },
          }).catch(() => {});
        }
      }
    }
  }

  const campaignRules = rules.filter((rule) => rule.source === "cyber");
  if (campaignRules.length > 0) {
    const campaignsResult = await pool.query(
      `SELECT id, client_id, name, start_date, end_date, status
       FROM v_b_clients_c_campaign`
    );
    for (const campaign of campaignsResult.rows) {
      const startDate = parseDate(campaign.start_date);
      const endDate = parseDate(campaign.end_date);
      const startDaysUntil = startDate ? getDaysUntil(startDate) : null;
      const endDaysUntil = endDate ? getDaysUntil(endDate) : null;
      for (const rule of campaignRules) {
        if (rule.element === "campaign_start_date_soon" && startDaysUntil !== null && startDaysUntil === Number(rule.daysBefore || 0)) {
          await dispatchNotificationEvent({
            source: "cyber",
            element: "campaign_start_date_soon",
            enterpriseId: String(campaign.client_id || ""),
            context: {
              campaign,
              entreprise: { id: String(campaign.client_id || "") },
              daysUntil: startDaysUntil,
            },
          }).catch(() => {});
        }
        if (rule.element === "campaign_end_date_soon" && endDaysUntil !== null && endDaysUntil === Number(rule.daysBefore || 0)) {
          await dispatchNotificationEvent({
            source: "cyber",
            element: "campaign_end_date_soon",
            enterpriseId: String(campaign.client_id || ""),
            context: {
              campaign,
              entreprise: { id: String(campaign.client_id || "") },
              daysUntil: endDaysUntil,
            },
          }).catch(() => {});
        }
        if (rule.element === "campaign_end_date_reached" && endDaysUntil !== null && endDaysUntil <= 0) {
          await dispatchNotificationEvent({
            source: "cyber",
            element: "campaign_end_date_reached",
            enterpriseId: String(campaign.client_id || ""),
            context: {
              campaign,
              entreprise: { id: String(campaign.client_id || "") },
              daysUntil: endDaysUntil,
            },
          }).catch(() => {});
        }
      }
    }
  }
}
