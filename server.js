// ───────────────────────────────────────────────
// 📦 Imports principaux
// ───────────────────────────────────────────────
import express from 'express';           // Framework HTTP
import cors from 'cors';                 // Middleware pour autoriser les requêtes cross-origin
import dotenv from 'dotenv';             // Chargement des variables d'environnement
import cookieParser from "cookie-parser";
import os from 'os';                    // Utilitaires système (pour récupérer l'IP)
import { resetRateLimitBuckets } from './middleware/rateLimit.js';
dotenv.config();                         // Active l'accès à process.env
if (process.env.NODE_ENV !== "production") {
  resetRateLimitBuckets();
}

// ───────────────────────────────────────────────
// 🗄️ Base de données
// ───────────────────────────────────────────────
import { pool, initDBConnection } from './database/db.js'; // Pool + init dynamique via la table `settings`
import { runPostSetupSchemaMigrations } from './services/runPostSetupSchemaMigrations.js';

// ───────────────────────────────────────────────
// 📁 Import des routes (API REST)
// ───────────────────────────────────────────────

// ── 🔐 Authentification & Utilisateurs
import authRoutes from './routes/auth/auth.js';
import userRoutes from './routes/auth/users.js';
import profilesRouter from "./routes/auth/profiles.js";
import teamsRoutes from "./routes/auth/teams.js";
import userSettingsRoutes from './routes/auth/userSettings.js';

// ── 👥 Clients & Modules
import clientsRoutes, { modulesRouterExport } from './routes/clients/clients.js';
import campaignRoutes from './routes/clients/campaign.js';
import materialTypesRoutes from './routes/clients/materialTypes.js';
import contactsRoutes from './routes/clients/contacts.js';

// ── 📄 Documents & Historique
import monitoringDocumentsRouter from "./routes/documents/monitoringDocuments.js";
import clientFilesRouter from "./routes/documents/clientFiles.js";
import vaultSecretsRouter from "./routes/documents/vaultSecrets.js";
import equipmentFilesRouter from "./routes/documents/equipmentFiles.js";
import clientPortalRouter from "./routes/clients/clientPortal.js";
import clientPortalUsersRouter from "./routes/clients/clientPortalUsers.js";

// ── ⚙️ Configuration & Maintenance
import settingsRoutes from './routes/config/settings.js';
import generalSettingsRoutes from './routes/config/generalSettings.js';
import loginBrandingRoutes from './routes/config/loginBranding.js';
import slaSettingsRoutes from './routes/config/slaSettings.js';
import contractModuleOptionsRoutes from './routes/config/contractModuleOptions.js';
import equipmentFamiliesRoutes from './routes/config/equipmentFamilies.js';
import maintenanceRoutes from './routes/config/maintenance.js';
import setupRoutes from './routes/config/setup.js';
import editionRoutes from './routes/config/edition.js';
import licenseRoutes from './routes/config/license.js';
import { requirePro, requireProAuth } from './middleware/edition.js';
import { getEditionPayload, isPro } from './utils/edition.js';
import { refreshProLicenseState, ensureFreshLicense } from './utils/proLicense.js';
import verifyJWT from './middleware/auth.js';

// ── 📊 Statistiques & Utilitaires
import statsRoutes from './routes/utils/stats.js';
import techNewsRoutes from './routes/utils/techNews.js';
import emailRoutes from "./routes/utils/email.js";
import testsRoutes from './routes/utils/tests.js';
import supportReportRoutes from './routes/utils/supportReport.js';
import eventsRoutes from './routes/utils/events.js';
import ticketsRoutes from './routes/utils/tickets.js';
import notificationsRoutes from './routes/utils/notifications.js';

// ── 🔌 Intégrations Externes
import bitdefenderRouter from "./routes/integrations/bitdefender.js";
import mailinblackRouter from "./routes/integrations/mailinblack.js";
import rmmRouter from "./routes/rmm/rmm.js";
import equipmentMonitoringAlertsRouter from "./routes/equipment/monitoringAlerts.js";
import equipmentMetaRouter from "./routes/equipment/equipmentMeta.js";
import supervisionAlertRulesRouter from "./routes/supervision/alertRules.js";
import checkmkRouter from "./routes/integrations/checkmk.js";
import ovhRouter from "./routes/integrations/ovh.js";
import partnerCenterRouter from "./routes/integrations/partnerCenter.js";
import office365Router from "./routes/integrations/office365.js";
import unifiEquipmentRouter from "./routes/integrations/unifi/equipment.js";
import whatsappRouter from "./routes/integrations/whatsapp/index.js";
import office365ClientRouter from "./routes/clients/office365-client.js";
import bitdefenderClientRouter from "./routes/clients/bitdefender-client.js";
import mailinblackClientRouter from "./routes/clients/mailinblack-client.js";

import { checkMaintenanceMode } from './middleware/maintenance.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { canRunAutoSchemaMigrations, isSetupMarkedComplete, isInstallationInProgress } from './utils/setupState.js';
import cron from 'node-cron';
import { runSaveJobsSync } from './routes/integrations/checkmk/saveJobsSync.js';
import { runNotificationSoonScheduler } from "./services/notificationDispatcher.js";
import { syncAllRmmAgentOfflineStatus } from "./services/rmmOfflineSync.js";
import { runEquipmentMonitoringAlertScan } from "./services/equipmentMonitoringAlertScan.js";
import { autoCloseExpiredResolutionValidations } from "./services/ticketResolutionValidationService.js";
import { loadMailCollectorsRaw } from "./services/ticketAutomationConfigStore.js";
import { normalizeMailCollector, processMailCollector } from "./services/mailCollectorIngest.js";

const app = express();

const collectorRunLocks = new Set();

async function processCollectorInbox(collectorInput) {
  const collector = normalizeMailCollector(collectorInput, 0);
  if (!collector.id || collectorRunLocks.has(collector.id)) return;
  collectorRunLocks.add(collector.id);
  try {
    await processMailCollector(collector);
  } catch (error) {
    console.error(`[cron] Collector ${collector.id}:`, error.message);
  } finally {
    collectorRunLocks.delete(collector.id);
  }
}

// ───────────────────────────────────────────────
// 🔧 Configuration pour reverse proxy (HTTPS)
// ───────────────────────────────────────────────
// Permet à Express de détecter correctement HTTPS via le reverse proxy
app.set('trust proxy', true);

// ───────────────────────────────────────────────
// 🔧 Middlewares globaux
// ───────────────────────────────────────────────

// Normalise une URL en enlevant les slashes finaux pour une comparaison cohérente
const normalizeOrigin = (url) => {
  if (!url) return url;
  return url.replace(/\/+$/, ''); // Enlève tous les slashes finaux
};

const DEV_DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function isLocalDevOrigin(origin) {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/** Lit ALLOWED_ORIGINS à chaque requête (réagit au wizard sans redémarrage). */
function getAllowedOrigins() {
  const fromEnv = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter(Boolean);

  if (fromEnv.length > 0) return fromEnv;

  // Premier démarrage : .env pas encore configuré par /setup
  if (process.env.NODE_ENV !== 'production') {
    return DEV_DEFAULT_ORIGINS;
  }

  return [];
}

const corsOptions = {
  origin: (origin, callback) => {
    // Sans Origin : requêtes serveur-à-serveur ou same-origin (pas de CORS navigateur).
    // En production, ne pas accorder d'en-têtes CORS permissifs (credentials + Origin absent).
    if (!origin) {
      callback(null, process.env.NODE_ENV !== "production");
      return;
    }

    const normalizedOrigin = normalizeOrigin(origin);
    const allowedOrigins = getAllowedOrigins();

    if (allowedOrigins.includes(normalizedOrigin)) {
      callback(null, true);
      return;
    }

    // Pendant l'assistant d'installation, autoriser le frontend local
    if (!isSetupMarkedComplete() && isLocalDevOrigin(normalizedOrigin)) {
      callback(null, true);
      return;
    }

    console.warn(`⚠️  CORS blocked — origin: "${origin}" (normalized: "${normalizedOrigin}")`);
    console.warn('   Allowed origins:', allowedOrigins);
    callback(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(securityHeaders);
const jsonBodyParser = express.json({
  limit: "25mb",
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
});

app.use((req, res, next) => {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    return next();
  }
  return jsonBodyParser(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: "25mb" })); // Pour les formulaires encodés
app.use(cookieParser());

// ───────────────────────────────────────────────
// 🔧 Middleware de maintenance (doit être après cookieParser)
// ───────────────────────────────────────────────
app.use(checkMaintenanceMode);

// 📁 Assets login publics (page de connexion, avant authentification)
app.use('/uploads/login-branding', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'");
  next();
}, express.static('uploads/login-branding'));

// 📁 Sert les fichiers statiques depuis le dossier uploads
app.use('/uploads', verifyJWT, express.static('uploads'));

// ───────────────────────────────────────────────
// 🧠 Connexion à la base de données
// ───────────────────────────────────────────────
await initDBConnection(); // ⚙️ Tente une connexion dynamique via la table `settings` ; fallback `.env`
if (await canRunAutoSchemaMigrations()) {
  try {
    await runPostSetupSchemaMigrations();
  } catch (err) {
    console.error("[startup] Post-installation migrations failed:", err.message);
  }
} else if (!isSetupMarkedComplete()) {
  console.log(
    "[setup] Installation in progress — create the schema via the wizard: http://localhost:3000/setup"
  );
}

await refreshProLicenseState();

// 🛠️ Assistant de première installation (accessible tant que needsSetup = true)
app.use('/api/setup', setupRoutes);
app.use('/api/edition', editionRoutes);
app.use('/api/license', licenseRoutes);

// ⏰ Job cron : sync des jobs de sauvegarde CheckMK (last_backup_date, last_backup_duration) — toutes les heures
cron.schedule('0 * * * *', async () => {
  if (await isInstallationInProgress()) return;
  try {
    const result = await runSaveJobsSync();
    if (result.total > 0) {
      console.log(`[cron] CheckMK backup job sync: ${result.updated}/${result.total} updated`);
    }
  } catch (error) {
    console.error('[cron] CheckMK backup job sync:', error.message);
  }
});

// Collecte des boîtes mail collecteurs (chaque minute).
cron.schedule('* * * * *', async () => {
  if (await isInstallationInProgress()) return;
  try {
    const collectors = await loadMailCollectorsRaw();
    for (const collector of collectors) {
      await processCollectorInbox(collector);
    }
  } catch (error) {
    console.error('[cron] Mail collectors:', error.message);
  }
});

// Vérification périodique des événements date-based (*_soon, *_reached, *_expired).
cron.schedule('0 * * * *', async () => {
  if (await isInstallationInProgress()) return;
  try {
    await runNotificationSoonScheduler();
  } catch (error) {
    console.error('[cron] Notifications date-based:', error.message);
  }
});

// Statut hors ligne des agents RMM (ordinateurs) — toutes les 5 minutes.
cron.schedule('*/5 * * * *', async () => {
  if (await isInstallationInProgress()) return;
  try {
    const result = await syncAllRmmAgentOfflineStatus();
    if (result.updated > 0) {
      console.log(`[cron] RMM offline sync: ${result.updated}/${result.checked} computer(s) updated`);
    }
  } catch (error) {
    console.error('[cron] RMM offline sync:', error.message);
  }
});

// Validation périodique de la licence Pro — toutes les 15 minutes.
cron.schedule('*/15 * * * *', async () => {
  if (await isInstallationInProgress()) return;
  try {
    const before = isPro();
    await refreshProLicenseState();
    const after = isPro();
    if (before !== after) {
      console.log(`[cron] Pro license: edition ${after ? "pro" : "community"} (status ${after ? "active" : "revoked/expired"})`);
    }
  } catch (error) {
    console.error('[cron] Licence Pro:', error.message);
  }
});

// Scan alertes surveillance → tickets support — toutes les 5 minutes.
cron.schedule('*/5 * * * *', async () => {
  if (await isInstallationInProgress()) return;
  try {
    const result = await runEquipmentMonitoringAlertScan();
    if (result.created > 0) {
      console.log(`[cron] Monitoring alerts: ${result.created} ticket(s) created (${result.evaluated} evaluated)`);
    }
  } catch (error) {
    console.error('[cron] Monitoring alerts:', error.message);
  }
});

// Clôture auto des tickets résolus sans validation client sous 48 h — toutes les heures.
cron.schedule('0 * * * *', async () => {
  if (await isInstallationInProgress()) return;
  try {
    const result = await autoCloseExpiredResolutionValidations();
    if (result.closed > 0) {
      console.log(`[cron] Expired client validation: ${result.closed} ticket(s) closed automatically`);
    }
  } catch (error) {
    console.error('[cron] Expired client validation:', error.message);
  }
});

// ───────────────────────────────────────────────
// 🚏 Routes API
// ───────────────────────────────────────────────

app.use("/api", async (req, res, next) => {
  try {
    await ensureFreshLicense();
    next();
  } catch (error) {
    console.error("[license] ensureFreshLicense:", error.message);
    next(error);
  }
});

// ── 🔐 Authentification & Utilisateurs
app.use('/api/auth', authRoutes);                      // Connexion / Mot de passe oublié
app.use('/api/users', userRoutes);                     // Gestion des comptes utilisateurs
app.use("/api/profiles", profilesRouter);              // Récupération des informations du profil utilisateur
app.use("/api/teams", requireProAuth, teamsRoutes);                    // Gestion des équipes
app.use('/api/user-settings', userSettingsRoutes);     // Paramètres utilisateur

// ── 👥 Clients & Modules
app.use('/api/clients', campaignRoutes);               // Routes campagnes cybersécurité (doit être avant clientsRoutes)
app.use('/api/clients', clientsRoutes);                // Gestion des clients (monitoring, général)
app.use('/api/clients-general', clientsRoutes);        // Alias pour compatibilité
app.use('/api/clients/modules', modulesRouterExport);  // Inventaire / modules équipements (Community + Pro)
app.use('/api/material-types', materialTypesRoutes);   // Types personnalisés de matériels
app.use('/api/contacts', contactsRoutes);              // Contacts clients

// ── 📄 Documents & Historique
app.use("/api/monitoring-documents", requireProAuth, monitoringDocumentsRouter); // Documents de monitoring dédiés
app.use("/api/client-files", requireProAuth, clientFilesRouter);
app.use("/api/vault-secrets", requireProAuth, vaultSecretsRouter);
app.use("/api/equipment-files", equipmentFilesRouter);
app.use("/api/client-portal", clientPortalRouter);
app.use("/api/client-portal-users", clientPortalUsersRouter);

// ── ⚙️ Configuration & Maintenance
app.use('/api/settings', settingsRoutes);              // Lecture / écriture des paramètres globaux
app.use('/api/general-settings', generalSettingsRoutes); // Langue, fuseau horaire, préférences globales
app.use('/api/login-branding', loginBrandingRoutes); // Personnalisation page login (Pro)
app.use('/api/sla-settings', slaSettingsRoutes); // Horaires support et mode de calcul SLA (Community + Pro)
app.use('/api/contract-module-options', requireProAuth, contractModuleOptionsRoutes); // Options de contrat configurables
app.use('/api/equipment-families', equipmentFamiliesRoutes); // Familles de matériel configurables
app.use('/api/maintenance', maintenanceRoutes);       // Maintenance IT events

// ── 📊 Statistiques & Utilitaires
app.use("/api/stats", statsRoutes);                    // Statistiques globales (page d'accueil, etc.)
app.use("/api/tech-news", techNewsRoutes);             // Fil d'actualités tech / CVE (accueil)
app.use("/api/email", requireProAuth, emailRoutes);                    // Envoi de rapports par email
app.use("/api/events", requireProAuth, eventsRoutes);                   // Gestion des événements du planning
app.use("/api/tickets", ticketsRoutes);                 // Gestion du ticketing natif
app.use("/api/notifications", notificationsRoutes);     // Notifications in-app agents
app.use("/api/rmm", rmmRouter);                        // Agents RMM (avant testsRoutes qui capture /api/*)
app.use("/rmm", rmmRouter);                            // Compatibilité URL sans préfixe /api
app.use("/api", testsRoutes);                          // Endpoints de test et vérification
app.use("/api", supportReportRoutes);                  // Demandes de support utilisateur

// ── 🔌 Intégrations Externes
app.use("/api/bitdefender", bitdefenderRouter);        // Intégration BitDefender GravityZone (Community + Pro)
app.use("/api/mailinblack", mailinblackRouter);       // Intégration Mailinblack Protect (Community + Pro)
app.use("/api/equipment-monitoring-alerts", equipmentMonitoringAlertsRouter);
app.use("/api/equipment", equipmentMetaRouter);
app.use("/api/supervision/alert-rules", supervisionAlertRulesRouter);
app.use("/api/checkmk", checkmkRouter);                // Surveillance CheckMK (Community + Pro)
app.use("/api/unifi", requireProAuth, unifiEquipmentRouter);           // API UniFi par équipement (UDM Pro)
app.use("/api/ovh", ovhRouter);                        // Intégration OVH (Community + Pro)
app.use("/api/partner-center", requireProAuth, partnerCenterRouter);  // Intégration Microsoft Partner Center
app.use("/api/office365", verifyJWT, office365Router);            // Intégration Microsoft Graph API pour Office 365
app.use("/api/whatsapp", requirePro, whatsappRouter);              // Webhook Meta public ; test JWT dans le routeur
app.use("/api/client-office365", verifyJWT, office365ClientRouter); // Gestion des credentials Office 365 par client
app.use("/api/client-bitdefender", bitdefenderClientRouter); // Tenants Bitdefender dédiés par client
app.use("/api/client-mailinblack", mailinblackClientRouter); // Tenants Mailinblack dédiés par client

// ───────────────────────────────────────────────
// 🔄 Routes de compatibilité (pour reverse proxy qui enlève /api)
// Ces routes permettent d'accéder aux endpoints avec ou sans le préfixe /api
// ───────────────────────────────────────────────
app.use("/maintenance", maintenanceRoutes);       // Compatibilité: /maintenance/* → /api/maintenance/*
app.use("/auth", authRoutes);                    // Compatibilité: /auth/* → /api/auth/*
app.use("/users", userRoutes);                    // Compatibilité: /users/* → /api/users/*
app.use("/profiles", profilesRouter);             // Compatibilité: /profiles/* → /api/profiles/*
app.use("/teams", requireProAuth, teamsRoutes);                   // Compatibilité: /teams/* → /api/teams/*
app.use("/", testsRoutes);                        // Compatibilité: /status, /db-status → /api/status, /api/db-status

// ───────────────────────────────────────────────
// 🏥 Health check endpoints (pour Docker/Kubernetes)
// ───────────────────────────────────────────────

// Endpoint "liveness" : vérifie uniquement que le serveur répond
// Utilisé par le healthcheck Docker pour savoir si le container est démarré
app.get('/health/live', (req, res) => {
  res.status(200).json({ 
    status: 'alive', 
    timestamp: new Date().toISOString()
  });
});

// Endpoint "readiness" : vérifie que le serveur ET la base de données sont prêts
// Utilisé pour les tests complets de santé de l'application
app.get('/health', async (req, res) => {
  try {
    // Vérifie la connexion à la base de données
    await pool.query('SELECT 1');
    res.status(200).json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      ...(process.env.NODE_ENV !== 'production' ? { error: err.message } : {}),
    });
  }
});

// ───────────────────────────────────────────────
// 🔍 Route pour /api (évite l'erreur "cannot GET /")
// ───────────────────────────────────────────────
app.get('/api', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    database: 'connected',
    message: 'API endpoint accessible',
    endpoints: {
      health: '/api/health',
      status: '/api/status',
      dbStatus: '/api/db-status',
      maintenance: '/api/maintenance/status',
      auth: '/api/auth/me'
    }
  });
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "Corps de requête invalide." });
  }
  next(err);
});

// ───────────────────────────────────────────────
// 🚀 Lancement du serveur
// ───────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

// Fonction pour récupérer toutes les IPs disponibles
function getServerIPs() {
  const interfaces = os.networkInterfaces();
  const ips = ['localhost'];
  
  // Récupérer toutes les IPs IPv4 non-localhost
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  
  return ips;
}

// Détermine le protocole (http ou https)
const PROTOCOL = process.env.PROTOCOL || 'http';
const SERVER_IPS = getServerIPs();

app.listen(PORT, '0.0.0.0', () => {
  const urls = SERVER_IPS.map(ip => `${PROTOCOL}://${ip}:${PORT}`);
  const editionInfo = getEditionPayload();
  console.log(`✅ Server running on:`);
  urls.forEach(url => console.log(`   ${url}`));
  const licenseNote = editionInfo.license?.devBypass
    ? " (dev Pro bypass)"
    : editionInfo.license?.valid
      ? ` (license ${editionInfo.license.status || "active"})`
      : editionInfo.limits
        ? " (Community limits active)"
        : "";
  console.log(`   Veritas edition: ${editionInfo.edition}${licenseNote}`);
});
