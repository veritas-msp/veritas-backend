// ─────────────────────────────────────────────
// 📊 ROUTE /api/stats — Statistiques globales
// ─────────────────────────────────────────────

import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import {
  buildDefaultOptionsObject,
  DEFAULT_CONTRACT_MODULES,
  listContractModuleOptions,
} from '../../utils/contractModuleOptions.js';
import { enrichTicketWithSla } from '../../utils/ticketSla.js';
import { loadSlaSettings } from '../../utils/slaSettingsStore.js';
import { fetchMonitorableEquipmentStats } from '../../utils/monitorableEquipmentStats.js';
import { getEditionPayload, isCommunity } from '../../utils/edition.js';
import { fetchAnalyticsDashboard } from '../../services/dashboardAnalyticsService.js';

const router = express.Router(); // Initialisation du routeur Express

router.use(verifyJWT);

const HOME_LIST_LIMIT = 5;
const HOME_TICKETS_LIST_LIMIT = 20;
const HOME_TICKETS_POOL_LIMIT = 100;
const HOME_EVENTS_POOL_LIMIT = 80;
const EVENT_META_MARKER = "<!--VERITAS_EVENT_META:";
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

const FIRST_TAKEOVER_AT_SQL = `(SELECT h.created_at
           FROM v_b_ticket_status_history h
           WHERE h.ticket_id = t.id
             AND LOWER(COALESCE(h.old_status, '')) IN ('new', 'open', '')
             AND LOWER(COALESCE(h.new_status, '')) NOT IN ('new', 'open', '')
           ORDER BY h.created_at ASC
           LIMIT 1) AS first_takeover_at`;

/** Comptes portail contact (role client) — exclus du décompte agents MSP */
const ACTIVE_AGENTS_COUNT_SQL = `
  SELECT COUNT(*)::int AS count
  FROM v_b_users
  WHERE is_active = true
    AND COALESCE(role, '') <> 'client'
`;

const RMM_AGENTS_COUNT_SQL = `
  SELECT COUNT(*)::int AS count
  FROM v_b_rmm_agents
  WHERE COALESCE(status, 'active') = 'active'
`;

const CONTRACT_EXPIRING_WINDOW_DAYS = 30;

// Jobs sauvegarde : lignes item_key "job-…", ou data.type === "job", ou JSON instances[].jobs / jobs racine.
// Aligné sur transformClientModules (Sauvegarde).
function countAllBackupJobsFromSaveRows(rows) {
  let n = 0;
  for (const row of rows) {
    const itemKey = row.item_key != null ? String(row.item_key) : "";
    if (itemKey.startsWith("job-")) {
      n += 1;
      continue;
    }

    let d = row.data;
    if (d == null) continue;
    if (typeof d === "string") {
      try {
        d = JSON.parse(d);
      } catch {
        continue;
      }
    }
    if (typeof d !== "object" || d === null) continue;

    if (d.type === "job") {
      n += 1;
      continue;
    }

    if (Array.isArray(d.jobs)) n += d.jobs.length;
    if (Array.isArray(d.instances)) {
      for (const inst of d.instances) {
        if (inst && Array.isArray(inst.jobs)) n += inst.jobs.length;
      }
    }
  }
  return n;
}

// ─────────────────────────────────────────────
// 📈 GET /api/stats/users — Statistiques utilisateurs
// ─────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total_users,
        COUNT(*) FILTER (WHERE is_active) AS active_users,
        COUNT(*) FILTER (WHERE role = 'admin') AS admin_users,
        COUNT(*) FILTER (WHERE role = 'superviseur') AS superviseur_users,
        COUNT(*) FILTER (WHERE role = 'user') AS user_users,
        MIN(created_at)::date AS first_user_date,
        MAX(created_at)::date AS last_user_date
      FROM v_b_users
    `);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ─────────────────────────────────────────────
// 📈 GET /api/stats/clients — Statistiques clients monitorés
// ─────────────────────────────────────────────
router.get("/clients", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, modules, report_frequency FROM v_b_clients");

    const clients = result.rows;
    const totalClients = clients.length;

    let totalServers = 0;
    let physicalServers = 0;
    let virtualServers = 0;
    let totalDomains = 0;
    let totalAntispamUsers = 0;
    let totalAntivirusDevices = 0;
    let totalBackupJobs = 0;
    let totalLicencesO365 = 0;
    let filledNAS = 0;
    let maxNAS = 0;
    const reportFreqCount = {};
    const windowsVersionCount = {};

    for (const client of clients) {
      const { id, report_frequency } = client;
      
      // Charger les équipements depuis les nouvelles tables
      let equipements = {};
      try {
        // Serveurs
        const serversResult = await pool.query(
          `SELECT data FROM v_b_clients_m_servers WHERE client_id = $1 AND data IS NOT NULL`,
          [id]
        );
        equipements.Serveurs = serversResult.rows.map(row => row.data);
        
        // NAS
        const nasResult = await pool.query(
          `SELECT data FROM v_b_clients_m_stockage WHERE client_id = $1 AND data IS NOT NULL`,
          [id]
        );
        equipements.NAS = nasResult.rows.map(row => row.data);
        
        // NDD
        const nddResult = await pool.query(
          `SELECT data FROM v_b_clients_m_ndd WHERE client_id = $1 AND data IS NOT NULL`,
          [id]
        );
        equipements.NDD = nddResult.rows.map(row => row.data);
        
        // Antispam
        const antispamResult = await pool.query(
          `SELECT data FROM v_b_clients_m_antispam WHERE client_id = $1 AND data IS NOT NULL LIMIT 1`,
          [id]
        );
        if (antispamResult.rows.length > 0) {
          equipements.Antispam = antispamResult.rows[0].data;
        }
        
        // Antivirus
        const antivirusResult = await pool.query(
          `SELECT data FROM v_b_clients_m_antivirus WHERE client_id = $1 AND data IS NOT NULL LIMIT 1`,
          [id]
        );
        if (antivirusResult.rows.length > 0) {
          equipements.Antivirus = antivirusResult.rows[0].data;
        }
        
        // Sauvegarde (plusieurs lignes : instances + jobs item_key job-*)
        const saveResult = await pool.query(
          `SELECT item_key, data FROM v_b_clients_m_save WHERE client_id = $1 AND data IS NOT NULL`,
          [id]
        );
        if (saveResult.rows.length > 0) {
          equipements.Sauvegarde = saveResult.rows[0].data;
        }
        totalBackupJobs += countAllBackupJobsFromSaveRows(saveResult.rows);

        // Office365
        const o365Result = await pool.query(
          `SELECT data FROM v_b_clients_m_o365 WHERE client_id = $1 AND data IS NOT NULL LIMIT 1`,
          [id]
        );
        if (o365Result.rows.length > 0) {
          equipements.Office365 = o365Result.rows[0].data;
        }
      } catch (err) {
      }

      // 🔁 Fréquence des rapports
      reportFreqCount[report_frequency] = (reportFreqCount[report_frequency] || 0) + 1;

      // 🖥️ Serveurs
      const serveurs = equipements?.Serveurs || [];
      for (const srv of serveurs) {
        if (srv?.type === "physique") physicalServers++;
        if (srv?.type === "virtuel") virtualServers++;
        if (srv?.versionWindows) {
          windowsVersionCount[srv.versionWindows] = (windowsVersionCount[srv.versionWindows] || 0) + 1;
        }
      }
      totalServers += serveurs.length;

      // 💾 NAS
      const nas = equipements?.NAS || [];
      for (const n of nas) {
        filledNAS += Number(n.nbDisquesActuels || 0);
        maxNAS += Number(n.nbDisquesMax || 0);
      }

      // 🌐 NDD
      totalDomains += (equipements?.NDD || []).length;

      // ✉️ Antispam
      totalAntispamUsers += Number(equipements?.Antispam?.utilisateursProteges || 0);

      // 🛡️ Antivirus
      const antivirus = equipements?.Antivirus || {};
      const avTypes = ["ServeursWindows", "stationsWindows", "macos", "machinesPhysiques", "machinesVirtuelles"];
      for (const t of avTypes) {
        totalAntivirusDevices += Number(antivirus[t] || 0);
      }

      // 🪙 Office 365
      totalLicencesO365 += (equipements?.Office365?.licences || []).reduce((sum, l) => sum + Number(l.total || 0), 0);
    }

    // 📊 Pourcentages et moyennes
    const percentPhysical = totalServers ? Math.round((physicalServers / totalServers) * 100) : 0;
    const percentVirtual = totalServers ? Math.round((virtualServers / totalServers) * 100) : 0;
    const averageServersPerClient = totalClients ? (totalServers / totalClients).toFixed(2) : "0.00";
    const averageNASUsage = maxNAS ? Math.round((filledNAS / maxNAS) * 100) : 0;

    const mostUsedWindowsVersion = Object.entries(windowsVersionCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";

    res.json({
      totalClients,
      reportFreqCount,
      totalServers,
      physicalServers,
      virtualServers,
      percentPhysical,
      percentVirtual,
      averageServersPerClient,
      mostUsedWindowsVersion,
      averageNASUsage,
      totalDomains,
      totalAntispamUsers,
      totalAntivirusDevices,
      totalBackupJobs,
      totalLicencesO365
    });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors du calcul des statistiques clients" });
  }
});

// ─────────────────────────────────────────────
// 📈 GET /api/stats/reports — Statistiques des rapports générés
// ─────────────────────────────────────────────
router.get('/reports', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total_reports,
        COUNT(*) FILTER (WHERE type = 'monitoring')::int AS monitoring_reports,
        COUNT(*) FILTER (WHERE type = 'synthese')::int AS synthese_reports,
        COUNT(*) FILTER (WHERE type = 'crav')::int AS crav_reports,
        MIN(created_at)::date AS first_report_date,
        MAX(created_at)::date AS last_report_date
      FROM document_history
    `);

    const stats = result.rows[0];
    
    // Calcul du temps économisé
    // Temps normal sans app: 4 heures = 240 minutes
    // Temps avec app: 12.5 minutes (moyenne entre 10-15 min)
    // Temps économisé par rapport: 240 - 12.5 = 227.5 minutes = 3h47min30s
    const timeSavedPerReport = 227.5; // en minutes
    const totalTimeSaved = stats.total_reports * timeSavedPerReport;
    const totalTimeSavedHours = Math.round(totalTimeSaved / 60 * 100) / 100; // arrondi à 2 décimales
    
    // Valeur monétaire (242.80€ pour 8h de travail)
    const hourlyRate = 242.80 / 8; // 30.35€/h
    const monetaryValue = Math.round(totalTimeSavedHours * hourlyRate * 100) / 100;

    res.json({
      ...stats,
      time_saved_per_report_minutes: timeSavedPerReport,
      total_time_saved_minutes: Math.round(totalTimeSaved),
      total_time_saved_hours: totalTimeSavedHours,
      monetary_value_euros: monetaryValue
    });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ─────────────────────────────────────────────
// 📈 GET /api/stats/home-kpis — KPI simples pour la page d'accueil
// ─────────────────────────────────────────────

async function countOrZero(sql, params = []) {
  try {
    const r = await pool.query(sql, params);
    return Number(r.rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

function defaultMonitorableEquipmentStats() {
  return {
    families: [],
    equipMonitoredTotal: 0,
    equipUnderSurveillanceCount: 0,
    equipSurveillancePercent: null,
  };
}

async function safeMonitorableEquipmentStats() {
  try {
    return await fetchMonitorableEquipmentStats();
  } catch (err) {
    console.error("home-dashboard monitorableEquipment", err);
    return defaultMonitorableEquipmentStats();
  }
}

function defaultContractModuleOptions() {
  return DEFAULT_CONTRACT_MODULES.map((mod) => ({
    id: null,
    moduleKey: mod.module_key,
    label: mod.label,
    icon: mod.icon,
    enabled: true,
    sortOrder: mod.sort_order,
    createdAt: null,
    updatedAt: null,
  }));
}

async function safeContractModuleOptions() {
  try {
    return await listContractModuleOptions({ includeDisabled: false });
  } catch (err) {
    console.error("home-dashboard contractModules", err);
    return defaultContractModuleOptions();
  }
}

async function safeLicenseAlerts() {
  try {
    return await fetchLicenseAlerts();
  } catch (err) {
    console.error("home-dashboard licenseAlerts", err);
    return [];
  }
}

async function countFirstExistingTable(tableNames = []) {
  for (const tableName of tableNames) {
    try {
      const reg = await pool.query("SELECT to_regclass($1) AS reg", [`public.${tableName}`]);
      if (!reg.rows[0]?.reg) continue;
      return await countOrZero(`SELECT COUNT(*)::int AS count FROM ${tableName} WHERE data IS NOT NULL`);
    } catch {
      // ignore and try next candidate
    }
  }
  return 0;
}

function parseJsonField(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function contractAlertStatus(expirationDate, isSuspended = false) {
  if (isSuspended) return "suspended";
  if (!expirationDate) return null;
  const expiration = new Date(expirationDate);
  if (Number.isNaN(expiration.getTime())) return null;
  expiration.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((expiration - today) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "expired";
  if (diffDays <= 60) return "expiring";
  return null;
}

function isContractExpiringWindow(expirationDate, isSuspended = false, windowDays = CONTRACT_EXPIRING_WINDOW_DAYS) {
  if (isSuspended) return false;
  if (!expirationDate) return false;
  const expiration = new Date(expirationDate);
  if (Number.isNaN(expiration.getTime())) return false;
  expiration.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((expiration - today) / (1000 * 60 * 60 * 24));
  return diffDays <= windowDays;
}

const LICENSE_MODULE_TABLES = [
  "v_b_clients_m_antivirus",
  "v_b_clients_m_antispam",
  "v_b_clients_m_save",
  "v_b_clients_m_o365",
  "v_b_clients_m_licences",
  "v_b_clients_m_ndd",
  "v_b_clients_m_ssl",
  "v_b_clients_m_firewall",
  "v_b_clients_m_toip",
];

const LICENSE_MODULE_META = {
  "v_b_clients_m_antivirus": { module: "antivirus", label: "Antivirus" },
  "v_b_clients_m_antispam": { module: "antispam", label: "Antispam" },
  "v_b_clients_m_save": { module: "backup", label: "Sauvegarde" },
  "v_b_clients_m_o365": { module: "o365", label: "Microsoft 365" },
  "v_b_clients_m_licences": { module: "licences", label: "Licences" },
  "v_b_clients_m_ndd": { module: "domain", label: "Nom de domaine" },
  "v_b_clients_m_ssl": { module: "ssl", label: "Certificat SSL" },
  "v_b_clients_m_firewall": { module: "firewall", label: "Firewall" },
  "v_b_clients_m_toip": { module: "toip", label: "TOIP / VoIP" },
};

function licenseAlertStatus(expirationDate) {
  return contractAlertStatus(expirationDate, false);
}

function resolveLicenseItemLabel(...candidates) {
  for (const value of candidates) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return null;
}

function resolveLicenseExpiration(entry = {}) {
  return (
    entry.expiration ||
    entry.expirityDate ||
    entry.expirationDate ||
    entry.expiryDate ||
    entry.endDate ||
    entry.validTo ||
    entry.notAfter ||
    entry.syncData?.license?.expirationDate ||
    null
  );
}

function pushLicenseAlert(alerts, seen, ctx, label, expiration) {
  const status = licenseAlertStatus(expiration);
  if (!status) return;
  const resolvedLabel =
    resolveLicenseItemLabel(label, ctx.itemKey) || ctx.moduleLabel || "Licence";
  const dedupeKey = `${ctx.clientId}|${ctx.module}|${resolvedLabel}|${expiration}|${status}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  alerts.push({
    id: dedupeKey,
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    module: ctx.module,
    moduleLabel: ctx.moduleLabel,
    label: resolvedLabel,
    expiration,
    status,
  });
}

function collectCyberLicenseAlertItems(parsed, ctx, alerts, seen) {
  const rootLabel = resolveLicenseItemLabel(
    parsed.logiciel,
    parsed.solution,
    parsed.solutionName,
    parsed.nom,
    parsed.name,
    parsed.provider,
    parsed.product,
    ctx.itemName
  );
  pushLicenseAlert(
    alerts,
    seen,
    ctx,
    rootLabel,
    resolveLicenseExpiration(parsed) || parsed.syncData?.license?.expirationDate
  );

  for (const collection of [parsed.solutions, parsed.licences, parsed.instances, parsed.items]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      pushLicenseAlert(
        alerts,
        seen,
        ctx,
        resolveLicenseItemLabel(
          entry.logiciel,
          entry.solution,
          entry.nom,
          entry.name,
          entry.product,
          entry.label,
          entry.type,
          entry.jobName,
          entry.instance
        ),
        resolveLicenseExpiration(entry)
      );
    }
  }
}

function collectDomainLicenseAlertItems(parsed, ctx, alerts, seen) {
  pushLicenseAlert(
    alerts,
    seen,
    ctx,
    resolveLicenseItemLabel(
      parsed.nom,
      parsed.name,
      parsed.domaine,
      parsed.domain,
      parsed.hostname,
      parsed.host,
      ctx.itemName
    ),
    resolveLicenseExpiration(parsed)
  );

  for (const collection of [parsed.NDD, parsed.domains, parsed.domaines]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      pushLicenseAlert(
        alerts,
        seen,
        ctx,
        resolveLicenseItemLabel(entry.nom, entry.name, entry.domaine, entry.domain),
        resolveLicenseExpiration(entry)
      );
    }
  }
}

function collectFirewallLicenseAlertItems(parsed, ctx, alerts, seen) {
  if (!Array.isArray(parsed.licences)) return;
  for (const licence of parsed.licences) {
    pushLicenseAlert(
      alerts,
      seen,
      ctx,
      resolveLicenseItemLabel(licence.nom, licence.name, licence.type, licence.label),
      resolveLicenseExpiration(licence)
    );
  }
}

function collectModuleLicenseAlertItems(data, table, ctx, alerts, seen) {
  const parsed = parseJsonField(data, null);
  if (!parsed || typeof parsed !== "object") return;

  if (table === "v_b_clients_m_ndd" || table === "v_b_clients_m_ssl" || table === "v_b_clients_m_licences") {
    collectDomainLicenseAlertItems(parsed, ctx, alerts, seen);
    return;
  }

  if (table === "v_b_clients_m_firewall") {
    collectFirewallLicenseAlertItems(parsed, ctx, alerts, seen);
    return;
  }

  collectCyberLicenseAlertItems(parsed, ctx, alerts, seen);
}

function isExpiredLicenseDate(value) {
  if (!value) return false;
  const expiration = new Date(value);
  if (Number.isNaN(expiration.getTime())) return false;
  expiration.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return expiration < today;
}

function pushLicenseExpirationDate(dates, value) {
  if (value) dates.push(value);
}

function collectCyberLicenseExpirations(parsed, dates) {
  if (parsed.logiciel || parsed.solution || parsed.type === "solution") {
    pushLicenseExpirationDate(dates, parsed.expiration);
    pushLicenseExpirationDate(dates, parsed.expirityDate);
    pushLicenseExpirationDate(dates, parsed.syncData?.license?.expirationDate);
  }

  if (Array.isArray(parsed.solutions)) {
    for (const solution of parsed.solutions) {
      pushLicenseExpirationDate(dates, solution?.expiration);
      pushLicenseExpirationDate(dates, solution?.expirityDate);
      pushLicenseExpirationDate(dates, solution?.syncData?.license?.expirationDate);
    }
  }

  if (Array.isArray(parsed.licences)) {
    for (const licence of parsed.licences) {
      pushLicenseExpirationDate(dates, licence?.expirationDate);
      pushLicenseExpirationDate(dates, licence?.expiryDate);
      pushLicenseExpirationDate(dates, licence?.endDate);
      pushLicenseExpirationDate(dates, licence?.expiration);
    }
  }

  if (Array.isArray(parsed.instances)) {
    for (const instance of parsed.instances) {
      pushLicenseExpirationDate(dates, instance?.expiration);
      pushLicenseExpirationDate(dates, instance?.expirityDate);
    }
  }

  if (Array.isArray(parsed.items)) {
    for (const item of parsed.items) {
      pushLicenseExpirationDate(dates, item?.expiration);
      pushLicenseExpirationDate(dates, item?.expirationDate);
      pushLicenseExpirationDate(dates, item?.expiryDate);
    }
  }
}

function collectDomainLicenseExpirations(parsed, dates) {
  pushLicenseExpirationDate(dates, parsed.expiration);
  pushLicenseExpirationDate(dates, parsed.expirationDate);
  pushLicenseExpirationDate(dates, parsed.expirityDate);

  for (const collection of [parsed.NDD, parsed.domains, parsed.domaines]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      pushLicenseExpirationDate(dates, entry?.expiration);
      pushLicenseExpirationDate(dates, entry?.expirationDate);
      pushLicenseExpirationDate(dates, entry?.expirityDate);
    }
  }
}

function collectFirewallLicenseExpirations(parsed, dates) {
  if (!Array.isArray(parsed.licences)) return;
  for (const licence of parsed.licences) {
    pushLicenseExpirationDate(dates, licence?.expiration);
    pushLicenseExpirationDate(dates, licence?.expirationDate);
    pushLicenseExpirationDate(dates, licence?.expiryDate);
    pushLicenseExpirationDate(dates, licence?.endDate);
  }
}

function collectModuleLicenseExpirations(data, table = "") {
  const parsed = parseJsonField(data, null);
  if (!parsed || typeof parsed !== "object") return [];

  const dates = [];

  if (table === "v_b_clients_m_ndd" || table === "v_b_clients_m_ssl" || table === "v_b_clients_m_licences") {
    collectDomainLicenseExpirations(parsed, dates);
    return dates;
  }

  if (table === "v_b_clients_m_firewall") {
    collectFirewallLicenseExpirations(parsed, dates);
    return dates;
  }

  collectCyberLicenseExpirations(parsed, dates);
  return dates;
}

async function fetchLicenseAlerts() {
  const alerts = [];
  const seen = new Set();

  for (const table of LICENSE_MODULE_TABLES) {
    const meta = LICENSE_MODULE_META[table];
    if (!meta) continue;
    try {
      const result = await pool.query(
        `SELECT m.client_id, m.data, m.item_key, c.id AS client_ref_id, c.name AS client_name
         FROM ${table} m
         LEFT JOIN v_b_clients c ON c.id = m.client_id
         WHERE m.data IS NOT NULL`
      );
      for (const row of result.rows) {
        const ctx = {
          clientId: row.client_ref_id ?? row.client_id,
          clientName: row.client_name || "Client inconnu",
          module: meta.module,
          moduleLabel: meta.label,
          itemKey: row.item_key,
          itemName: row.name,
        };
        collectModuleLicenseAlertItems(row.data, table, ctx, alerts, seen);
      }
    } catch (err) {
      if (err.code !== "42P01") {
        console.warn(`[stats] fetchLicenseAlerts: ${table}`, err.message);
      }
    }
  }

  const rank = { expired: 0, expiring: 1 };
  alerts.sort((a, b) => {
    const statusDiff = (rank[a.status] ?? 2) - (rank[b.status] ?? 2);
    if (statusDiff !== 0) return statusDiff;
    const dateA = new Date(a.expiration).getTime();
    const dateB = new Date(b.expiration).getTime();
    if (Number.isFinite(dateA) && Number.isFinite(dateB)) return dateA - dateB;
    return String(a.clientName || "").localeCompare(String(b.clientName || ""), "fr");
  });

  return alerts;
}

async function countExpiredLicenses() {
  const alerts = await fetchLicenseAlerts();
  return alerts.filter((alert) => alert.status === "expired").length;
}

const EVENT_TYPE_LABELS = {
  intervention: "Intervention",
  presentation: "Présentation",
  maintenance: "Maintenance",
  maintenance_preventive: "Maintenance préventive",
  mise_a_jour: "Mise à jour",
  integration_monitoring: "Intégration monitoring",
  other: "Autre",
};

const TICKET_STATUS_LABELS = {
  open: "Ouvert",
  new: "Nouveau",
  pending: "En attente",
  in_progress: "En cours",
  resolved: "Résolu",
  closed: "Fermé",
};

async function hasTicketColumn(columnName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.oid = to_regclass('v_b_tickets')
         AND a.attname = $1
         AND a.attnum > 0
         AND NOT a.attisdropped
     ) AS has_column`,
    [columnName]
  );
  return Boolean(result.rows?.[0]?.has_column);
}

async function hasTicketAssigneesTable() {
  const result = await pool.query(
    `SELECT to_regclass('v_b_ticket_assignees') IS NOT NULL AS has_table`
  );
  return Boolean(result.rows?.[0]?.has_table);
}

async function fetchHomeTicketsForUser({ hasMajorIncident, hasSlaInfo, userId, hasTicketAssignees }) {
  const values = [];
  let where = `t.status NOT IN ('resolved', 'closed')`;

  if (userId) {
    values.push(userId);
    const userParam = `$${values.length}`;
    if (hasTicketAssignees) {
      where += ` AND (
        t.assigned_user_id = ${userParam}::uuid
        OR EXISTS (
          SELECT 1 FROM v_b_ticket_assignees a
          WHERE a.ticket_id = t.id AND a.user_id = ${userParam}::uuid
        )
      )`;
    } else {
      where += ` AND t.assigned_user_id = ${userParam}::uuid`;
    }
  }

  const sql = `SELECT t.id, t.ticket_number, t.title, t.description, t.status, t.priority, t.client_id, t.updated_at, t.created_at,
            ${hasMajorIncident ? "COALESCE(t.is_major_incident, false) AS is_major_incident," : "false AS is_major_incident,"}
            ${hasSlaInfo ? "t.sla_info," : ""}
            c.contrat AS client_contrat,
            ${FIRST_TAKEOVER_AT_SQL},
            c.name AS client_name
           FROM v_b_tickets t
           LEFT JOIN v_b_clients c ON c.id = t.client_id
           WHERE ${where}
           LIMIT ${HOME_TICKETS_POOL_LIMIT}`;

  return pool.query(sql, values);
}

function parseEventDescriptionMeta(rawDescription) {
  const raw = String(rawDescription || "");
  const markerIndex = raw.indexOf(EVENT_META_MARKER);
  if (markerIndex === -1) return null;
  const endIndex = raw.indexOf("-->", markerIndex);
  if (endIndex === -1) return null;
  const encoded = raw.slice(markerIndex + EVENT_META_MARKER.length, endIndex).trim();
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function getEventAssignedUserIds(row) {
  const ids = new Set();
  if (row?.assigned_user_id) ids.add(String(row.assigned_user_id));
  const meta = parseEventDescriptionMeta(row?.description);
  if (Array.isArray(meta?.assignedUserIds)) {
    for (const id of meta.assignedUserIds) {
      if (id) ids.add(String(id));
    }
  }
  return [...ids];
}

function isEventAssignedToUser(row, userId) {
  if (!userId) return true;
  return getEventAssignedUserIds(row).includes(String(userId));
}

function filterHomeEventsForUser(rows, userId, limit = HOME_LIST_LIMIT) {
  return rows
    .filter((row) => isEventAssignedToUser(row, userId))
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      title: e.title,
      type: e.type,
      typeLabel: EVENT_TYPE_LABELS[e.type] || e.type,
      start: e.start,
      end: e.end,
      clientId: e.client_id,
      clientName: e.client_name,
    }));
}

function rankAndSliceHomeTickets(rows, { hasSlaInfo, slaSettings, limit = HOME_LIST_LIMIT } = {}) {
  const ranked = rows.map((row) => {
    let slaRemainingMs = Number.POSITIVE_INFINITY;
    let slaLabel = null;
    let slaTone = null;
    let enriched = null;

    enriched = enrichTicketWithSla(row, {
      clientContrat: row.client_contrat,
      slaSettings,
    });
    if (enriched.sla_remaining_ms != null) {
      slaRemainingMs = Number(enriched.sla_remaining_ms);
    }
    if (enriched.sla_label && enriched.sla_label !== "—") {
      slaLabel = enriched.sla_label;
      slaTone = enriched.sla_tone || null;
    }

    const priorityKey = String(row.priority || "normal").toLowerCase();

    return {
      id: row.id,
      ticketNumber: row.ticket_number,
      title: row.title,
      description: row.description,
      status: row.status,
      statusLabel: TICKET_STATUS_LABELS[row.status] || row.status,
      priority: row.priority,
      clientId: row.client_id,
      clientName: row.client_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isMajorIncident: Boolean(row.is_major_incident),
      slaInfo: enriched?.sla_info ?? row.sla_info ?? null,
      firstTakeoverAt: row.first_takeover_at ?? null,
      slaLabel,
      slaTone,
      _sortMajor: row.is_major_incident ? 0 : 1,
      _sortSla: slaRemainingMs,
      _sortPriority: PRIORITY_RANK[priorityKey] ?? 2,
    };
  });

  ranked.sort((a, b) => {
    if (a._sortMajor !== b._sortMajor) return a._sortMajor - b._sortMajor;
    if (a._sortSla !== b._sortSla) return a._sortSla - b._sortSla;
    if (a._sortPriority !== b._sortPriority) return a._sortPriority - b._sortPriority;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return ranked.slice(0, limit).map(({ _sortMajor, _sortSla, _sortPriority, ...ticket }) => ticket);
}

function summarizeAssignedHomeTickets(rows) {
  let inProgress = 0;
  let pending = 0;

  for (const row of rows) {
    const status = String(row.status || "").trim().toLowerCase();
    const normalized = status === "open" ? "new" : status;
    if (normalized === "pending") {
      pending += 1;
    } else {
      inProgress += 1;
    }
  }

  return { inProgress, pending };
}

router.get("/home-dashboard", verifyJWT, async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const [hasMajorIncident, hasSlaInfo, hasTicketAssignees, slaSettings, monitorableEquipment] =
      await Promise.all([
        hasTicketColumn("is_major_incident"),
        hasTicketColumn("sla_info"),
        hasTicketAssigneesTable(),
        loadSlaSettings().catch((err) => {
          console.error("home-dashboard slaSettings", err);
          return null;
        }),
        safeMonitorableEquipmentStats(),
      ]);

    const [
      clientsUnderContract,
      campaigns,
      antispamConfigs,
      antivirusConfigs,
      reportsGenerated,
      tenants,
      domains,
      activeAgents,
      rmmAgents,
      clientsRows,
      ticketStatusRows,
      recentTicketRows,
      eventRows,
      orgSettingsRows,
    ] = await Promise.all([
      countOrZero(`SELECT COUNT(*)::int AS count FROM v_b_clients`),
      countOrZero(`SELECT COUNT(*)::int AS count FROM v_b_clients_c_campaign`),
      countOrZero(`SELECT COUNT(*)::int AS count FROM v_b_clients_m_antispam WHERE data IS NOT NULL`),
      countOrZero(`SELECT COUNT(*)::int AS count FROM v_b_clients_m_antivirus WHERE data IS NOT NULL`),
      countOrZero(`SELECT COUNT(*)::int AS count FROM document_history`),
      countOrZero(
        `SELECT COUNT(*)::int AS count FROM v_b_clients_azure WHERE tenant_id IS NOT NULL AND btrim(tenant_id::text) <> ''`
      ),
      countOrZero(`SELECT COUNT(*)::int AS count FROM v_b_clients_m_ndd WHERE data IS NOT NULL`),
      countOrZero(ACTIVE_AGENTS_COUNT_SQL),
      countOrZero(RMM_AGENTS_COUNT_SQL),
      pool.query(`SELECT id, name, contrat, options FROM v_b_clients ORDER BY name ASC`).catch(() => ({ rows: [] })),
      pool
        .query(
          `SELECT status, COUNT(*)::int AS count
           FROM v_b_tickets
           GROUP BY status`
        )
        .catch(() => ({ rows: [] })),
      fetchHomeTicketsForUser({ hasMajorIncident, hasSlaInfo, userId, hasTicketAssignees }).catch(() => ({ rows: [] })),
      pool
        .query(
          `SELECT e.id, e.title, e.type, e.start, e."end", e.client_id, e.description, e.assigned_user_id, c.name AS client_name
           FROM v_b_events e
           LEFT JOIN v_b_clients c ON c.id = e.client_id
           WHERE e."end" >= NOW() - INTERVAL '12 hours'
           ORDER BY e.start ASC
           LIMIT ${HOME_EVENTS_POOL_LIMIT}`
        )
        .catch(() => ({ rows: [] })),
      pool
        .query(
          `SELECT value FROM v_b_settings WHERE section = 'general' AND key = 'app_organization_name' LIMIT 1`
        )
        .catch(() => ({ rows: [] })),
    ]);

    let backupJobs = 0;
    try {
      const saveR = await pool.query(
        `SELECT item_key, data FROM v_b_clients_m_save WHERE data IS NOT NULL`
      );
      backupJobs = countAllBackupJobsFromSaveRows(saveR.rows);
    } catch {
      backupJobs = 0;
    }

    const { families: equipmentFamilies, equipMonitoredTotal, equipUnderSurveillanceCount, equipSurveillancePercent } =
      monitorableEquipment;

    const ticketsByStatus = {};
    let openTickets = 0;
    let urgentTickets = 0;
    for (const row of ticketStatusRows.rows) {
      const status = String(row.status || "").toLowerCase();
      const count = Number(row.count) || 0;
      ticketsByStatus[status] = count;
      if (!["resolved", "closed"].includes(status)) {
        openTickets += count;
      }
    }

    try {
      const urgentR = await pool.query(
        `SELECT COUNT(*)::int AS count FROM v_b_tickets
         WHERE priority IN ('high', 'urgent', 'critical')
           AND status NOT IN ('resolved', 'closed')`
      );
      urgentTickets = Number(urgentR.rows[0]?.count) || 0;
    } catch {
      urgentTickets = 0;
    }

    const enabledModules = await safeContractModuleOptions();
    const moduleKeys = enabledModules.map((m) => m.moduleKey);
    const modules = buildDefaultOptionsObject(enabledModules);
    for (const key of Object.keys(modules)) {
      modules[key] = 0;
    }
    const contractAlerts = [];
    let contractsExpiringSoon = 0;
    let contractsExpiringWindow = 0;

    for (const client of clientsRows.rows) {
      const options = parseJsonField(client.options, {});
      for (const key of moduleKeys) {
        if (options[key]) modules[key] = (modules[key] || 0) + 1;
      }
      for (const key of Object.keys(options)) {
        if (options[key] && modules[key] === undefined) {
          modules[key] = (modules[key] || 0) + 1;
        }
      }

      const contrat = parseJsonField(client.contrat, {});
      if (isContractExpiringWindow(contrat.expiration, Boolean(contrat.suspendu))) {
        contractsExpiringWindow += 1;
      }
      const alertStatus = contractAlertStatus(contrat.expiration, Boolean(contrat.suspendu));
      if (alertStatus) {
        if (alertStatus === "expiring") contractsExpiringSoon += 1;
        contractAlerts.push({
          id: client.id,
          name: client.name,
          expiration: contrat.expiration || null,
          status: alertStatus,
        });
      }
    }

    contractAlerts.sort((a, b) => {
      const rank = { expired: 0, suspended: 1, expiring: 2 };
      return (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    });

    const organizationName =
      String(orgSettingsRows.rows[0]?.value || "").trim() || "Veritas";

    const licenseAlerts = await safeLicenseAlerts();
    const licensesExpired = licenseAlerts.filter((alert) => alert.status === "expired").length;
    const licensesExpiringSoon = licenseAlerts.filter((alert) => alert.status === "expiring").length;

    const editionInfo = getEditionPayload();
    const fullDashboard = {
      edition: editionInfo.edition,
      limits: editionInfo.limits,
      organizationName,
      generatedAt: new Date().toISOString(),
      kpis: {
        clientsUnderContract,
        openTickets,
        urgentTickets,
        equipMonitoredTotal,
        equipUnderSurveillanceCount,
        equipSurveillancePercent,
        activeAgents,
        rmmAgents,
        contractsExpiringSoon: contractAlerts.filter((c) => c.status === "expiring").length,
        contractsExpiringWindow,
        contractsExpired: contractAlerts.filter((c) => c.status === "expired").length,
        licensesExpired,
        licensesExpiringSoon,
        reportsGenerated,
        backupJobs,
      },
      ticketsByStatus,
      assignedTicketStats: summarizeAssignedHomeTickets(recentTicketRows.rows),
      recentTickets: rankAndSliceHomeTickets(recentTicketRows.rows, {
        hasSlaInfo: isCommunity() ? false : hasSlaInfo,
        slaSettings,
        limit: HOME_TICKETS_LIST_LIMIT,
      }),
      contractAlerts,
      licenseAlerts,
      upcomingEvents: filterHomeEventsForUser(eventRows.rows, userId),
      infrastructure: {
        families: equipmentFamilies,
        equipMonitoredTotal,
        equipUnderSurveillanceCount,
        equipSurveillancePercent,
      },
      modules,
      cyber: {
        antivirusConfigs,
        antispamConfigs,
        backupJobs,
        tenants,
        domains,
        campaigns,
      },
    };

    if (isCommunity()) {
      return res.json({
        edition: editionInfo.edition,
        limits: editionInfo.limits,
        organizationName: fullDashboard.organizationName,
        generatedAt: fullDashboard.generatedAt,
        kpis: {
          clientsUnderContract: fullDashboard.kpis.clientsUnderContract,
          openTickets: fullDashboard.kpis.openTickets,
          urgentTickets: fullDashboard.kpis.urgentTickets,
          equipMonitoredTotal: fullDashboard.kpis.equipMonitoredTotal,
          equipUnderSurveillanceCount: fullDashboard.kpis.equipUnderSurveillanceCount,
          equipSurveillancePercent: fullDashboard.kpis.equipSurveillancePercent,
          rmmAgents: fullDashboard.kpis.rmmAgents,
          contractsExpiringSoon: fullDashboard.kpis.contractsExpiringSoon,
          contractsExpiringWindow: fullDashboard.kpis.contractsExpiringWindow,
          contractsExpired: fullDashboard.kpis.contractsExpired,
          licensesExpired: fullDashboard.kpis.licensesExpired,
          licensesExpiringSoon: fullDashboard.kpis.licensesExpiringSoon,
        },
        infrastructure: fullDashboard.infrastructure,
        ticketsByStatus: fullDashboard.ticketsByStatus,
        assignedTicketStats: fullDashboard.assignedTicketStats,
        recentTickets: fullDashboard.recentTickets,
        contractAlerts: fullDashboard.contractAlerts,
        licenseAlerts: fullDashboard.licenseAlerts,
      });
    }

    res.json(fullDashboard);
  } catch (err) {
    console.error("home-dashboard", err);
    res.status(500).json({
      error: "Erreur tableau de bord accueil",
      code: "HOME_DASHBOARD_FAILED",
      details: err.message || undefined,
    });
  }
});

router.get("/analytics-dashboard", verifyJWT, async (req, res) => {
  if (isCommunity()) {
    return res.status(403).json({
      error: "Tableau de bord KPI réservé à Veritas Pro",
      code: "PRO_FEATURE_REQUIRED",
    });
  }
  try {
    const period = String(req.query.period || "").trim() || null;
    const startAt = String(req.query.startAt || req.query.from || "").trim() || null;
    const endAt = String(req.query.endAt || req.query.to || "").trim() || null;
    const agentId = String(req.query.agentId || "").trim() || null;
    const clientId = String(req.query.clientId || "").trim() || null;
    const contactId = String(req.query.contactId || "").trim() || null;
    const payload = await fetchAnalyticsDashboard({
      period: startAt || endAt ? null : period || "365d",
      startAt,
      endAt,
      agentId,
      clientId,
      contactId,
    });
    res.json(payload);
  } catch (err) {
    if (err?.code === "INVALID_DATE_RANGE") {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error("analytics-dashboard", err);
    res.status(500).json({ error: "Erreur chargement tableau de bord KPI" });
  }
});

router.get("/home-kpis", async (req, res) => {
  if (isCommunity()) {
    return res.status(403).json({
      error: "Indicateurs avancés réservés à Veritas Pro",
      code: "PRO_FEATURE_REQUIRED",
    });
  }
  try {
    const {
      equipMonitoredTotal,
      equipUnderSurveillanceCount,
      equipSurveillancePercent,
    } = await fetchMonitorableEquipmentStats();

    const [
      clientsUnderContract,
      campaigns,
      antispamConfigs,
      antivirusConfigs,
      reportsGenerated,
      tenants,
      domains,
    ] = await Promise.all([
      countOrZero(`SELECT COUNT(*)::int AS count FROM v_b_clients`),
      countOrZero(`SELECT COUNT(*)::int AS count FROM v_b_clients_c_campaign`),
      countOrZero(
        `SELECT COUNT(*)::int AS count FROM v_b_clients_m_antispam WHERE data IS NOT NULL`
      ),
      countOrZero(
        `SELECT COUNT(*)::int AS count FROM v_b_clients_m_antivirus WHERE data IS NOT NULL`
      ),
      countOrZero(`SELECT COUNT(*)::int AS count FROM document_history`),
      countOrZero(
        `SELECT COUNT(*)::int AS count FROM v_b_clients_azure WHERE tenant_id IS NOT NULL AND btrim(tenant_id::text) <> ''`
      ),
      countOrZero(
        `SELECT COUNT(*)::int AS count FROM v_b_clients_m_ndd WHERE data IS NOT NULL`
      ),
    ]);

    let backupJobs = 0;
    try {
      const saveR = await pool.query(
        `SELECT item_key, data FROM v_b_clients_m_save WHERE data IS NOT NULL`
      );
      backupJobs = countAllBackupJobsFromSaveRows(saveR.rows);
    } catch {
      try {
        const saveR = await pool.query(
          `SELECT data FROM v_b_clients_m_save WHERE data IS NOT NULL`
        );
        backupJobs = countAllBackupJobsFromSaveRows(
          saveR.rows.map((r) => ({ item_key: null, data: r.data }))
        );
      } catch {
        backupJobs = 0;
      }
    }

    res.json({
      clientsUnderContract,
      equipMonitoredTotal,
      equipUnderSurveillanceCount,
      equipSurveillancePercent,
      campaigns,
      antispamConfigs,
      antivirusConfigs,
      backupJobs,
      tenants,
      domains,
      reportsGenerated,
    });
  } catch (err) {
    console.error("home-kpis", err);
    res.status(500).json({ error: "Erreur KPI accueil" });
  }
});

export default router;

