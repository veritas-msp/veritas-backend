// ───────────────────────────────────────────────
// 📦 Main imports
// ───────────────────────────────────────────────
import express from 'express';           // Framework HTTP
import cors from 'cors';                 // Middleware to allow cross-origin requests
import dotenv from 'dotenv';             // Load environment variables
import cookieParser from "cookie-parser";
import os from 'os';                    // System utilities (to get the IP)
import { resetRateLimitBuckets } from './middleware/rateLimit.js';
dotenv.config();                         // Enable process.env access
if (process.env.NODE_ENV !== "production") {
  resetRateLimitBuckets();
}

// ───────────────────────────────────────────────
// 🗄️ Database
// ───────────────────────────────────────────────
import { pool, initDBConnection } from './database/db.js'; // Pool + dynamic init via the `settings` table
import { runPostSetupSchemaMigrations } from './services/runPostSetupSchemaMigrations.js';

// ───────────────────────────────────────────────
// 📁 Route imports (REST API)
// ───────────────────────────────────────────────

// ── 🔐 Authentication & Users
import authRoutes from './routes/auth/auth.js';
import userRoutes from './routes/auth/users.js';
import profilesRouter from "./routes/auth/profiles.js";
import permissionsRouter from "./routes/config/permissions.js";
import teamsRoutes from "./routes/auth/teams.js";
import userSettingsRoutes from './routes/auth/userSettings.js';

// ── 👥 Clients & Modules
import clientsRoutes, { modulesRouterExport } from './routes/clients/clients.js';
import campaignRoutes from './routes/clients/campaign.js';
import materialTypesRoutes from './routes/clients/materialTypes.js';
import contactsRoutes from './routes/clients/contacts.js';

// ── 📄 Documents & History
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
import { getEditionPayload } from './utils/edition.js';
import { refreshProLicenseState, ensureFreshLicense } from './utils/proLicense.js';
import verifyJWT from './middleware/auth.js';

// ── 📊 Statistics & utilities
import statsRoutes from './routes/utils/stats.js';
import techNewsRoutes from './routes/utils/techNews.js';
import emailRoutes from "./routes/utils/email.js";
import testsRoutes from './routes/utils/tests.js';
import supportReportRoutes from './routes/utils/supportReport.js';
import eventsRoutes from './routes/utils/events.js';
import ticketsRoutes from './routes/utils/tickets.js';
import notificationsRoutes from './routes/utils/notifications.js';

// ── 🔌 External Integrations
import bitdefenderRouter from "./routes/integrations/bitdefender.js";
import mailinblackRouter from "./routes/integrations/mailinblack.js";
import rmmRouter from "./routes/rmm/rmm.js";
import equipmentMonitoringAlertsRouter from "./routes/equipment/monitoringAlerts.js";
import equipmentMetaRouter from "./routes/equipment/equipmentMeta.js";
import supervisionAlertRulesRouter from "./routes/supervision/alertRules.js";
import monitoringAutomationRouter from "./routes/supervision/monitoringAutomation.js";
import checkmkRouter from "./routes/integrations/checkmk.js";
import ovhRouter from "./routes/integrations/ovh.js";
import partnerCenterRouter from "./routes/integrations/partnerCenter.js";
import office365Router from "./routes/integrations/office365.js";
import unifiEquipmentRouter from "./routes/integrations/unifi/equipment.js";
import whatsappRouter from "./routes/integrations/whatsapp/index.js";
import office365ClientRouter from "./routes/clients/office365-client.js";
import bitdefenderClientRouter from "./routes/clients/bitdefender-client.js";
import mailinblackClientRouter from "./routes/clients/mailinblack-client.js";
import aiRouter from "./routes/ai/index.js";

import { checkMaintenanceMode } from './middleware/maintenance.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { canRunAutoSchemaMigrations, isSetupMarkedComplete } from './utils/setupState.js';

const app = express();

// ───────────────────────────────────────────────
// 🔧 Reverse proxy configuration (HTTPS)
// ───────────────────────────────────────────────
// Lets Express correctly detect HTTPS via the reverse proxy
app.set('trust proxy', true);

// ───────────────────────────────────────────────
// 🔧 Global middleware
// ───────────────────────────────────────────────

// Normalize a URL by stripping trailing slashes for consistent comparison
const normalizeOrigin = (url) => {
  if (!url) return url;
  return url.replace(/\/+$/, ''); // Strip all trailing slashes
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

/** Reads ALLOWED_ORIGINS on each request (reacts to wizard changes without restart). */
function getAllowedOrigins() {
  const fromEnv = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter(Boolean);

  if (fromEnv.length > 0) return fromEnv;

  // First boot: .env not yet configured by /setup
  if (process.env.NODE_ENV !== 'production') {
    return DEV_DEFAULT_ORIGINS;
  }

  return [];
}

const corsOptions = {
  origin: (origin, callback) => {
    // No Origin header: server-to-server or same-origin requests (no browser CORS).
    // In production, do not grant permissive CORS headers (credentials + missing Origin).
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

    // During setup wizard, allow local frontend
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
app.use(express.urlencoded({ extended: true, limit: "25mb" })); // For URL-encoded forms
app.use(cookieParser());

// ───────────────────────────────────────────────
// 🔧 Maintenance middleware (must be after cookieParser)
// ───────────────────────────────────────────────
app.use(checkMaintenanceMode);

// 📁 Public login assets (login page, before authentication)
app.use('/uploads/login-branding', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'");
  next();
}, express.static('uploads/login-branding'));

// 📁 Serve static files from the uploads folder
app.use('/uploads', verifyJWT, express.static('uploads'));

// ───────────────────────────────────────────────
// 🧠 Database connection
// ───────────────────────────────────────────────
await initDBConnection(); // ⚙️ Attempt a dynamic connection via the `settings` ; fallback `.env`
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

// 🛠️ First-install wizard (available while needsSetup = true)
app.use('/api/setup', setupRoutes);
app.use('/api/edition', editionRoutes);
app.use('/api/license', licenseRoutes);

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

// ── 🔐 Authentication & Users
app.use('/api/auth', authRoutes);                      // Login / Forgot password
app.use('/api/users', userRoutes);                     // User account management
app.use("/api/profiles", profilesRouter);              // Fetch user profile information
app.use("/api/permissions", permissionsRouter);        // RBAC matrix: catalog, user rights, per-profile config
app.use("/api/teams", requireProAuth, teamsRoutes);                    // Team management
app.use('/api/user-settings', userSettingsRoutes);     // User settings

// ── 👥 Clients & Modules
app.use('/api/clients', campaignRoutes);               // Cybersecurity campaign routes (must be before clientsRoutes)
app.use('/api/clients', clientsRoutes);                // Client management (monitoring, general)
app.use('/api/clients-general', clientsRoutes);        // Compatibility alias
app.use('/api/clients/modules', modulesRouterExport);  // Inventory / equipment modules (Community + Pro)
app.use('/api/material-types', materialTypesRoutes);   // Custom material types
app.use('/api/contacts', contactsRoutes);              // Client contacts

// ── 📄 Documents & History
app.use("/api/monitoring-documents", requireProAuth, monitoringDocumentsRouter); // Dedicated monitoring documents
app.use("/api/client-files", requireProAuth, clientFilesRouter);
app.use("/api/vault-secrets", requireProAuth, vaultSecretsRouter);
app.use("/api/equipment-files", equipmentFilesRouter);
app.use("/api/client-portal", clientPortalRouter);
app.use("/api/client-portal-users", clientPortalUsersRouter);

// ── ⚙️ Configuration & Maintenance
app.use('/api/settings', settingsRoutes);              // Read / write global settings
app.use('/api/general-settings', generalSettingsRoutes); // Language, timezone, global preferences
app.use('/api/login-branding', loginBrandingRoutes); // Login page customization (Pro)
app.use('/api/sla-settings', slaSettingsRoutes); // Support hours and SLA calculation mode (Community + Pro)
app.use('/api/contract-module-options', requireProAuth, contractModuleOptionsRoutes); // Configurable contract options
app.use('/api/equipment-families', equipmentFamiliesRoutes); // Configurable equipment families
app.use('/api/maintenance', maintenanceRoutes);       // Maintenance IT events

// ── 📊 Statistics & utilities
app.use("/api/stats", statsRoutes);                    // Global statistics (home page, etc.)
app.use("/api/tech-news", techNewsRoutes);             // Tech news / CVE feed (home)
app.use("/api/email", requireProAuth, emailRoutes);                    // Email report delivery
app.use("/api/events", requireProAuth, eventsRoutes);                   // Management events planning
app.use("/api/tickets", ticketsRoutes);                 // Management ticketing natif
app.use("/api/notifications", notificationsRoutes);     // Notifications in-app agents
app.use("/api/rmm", rmmRouter);                        // Agents RMM (before testsRoutes that capture /api/*)
app.use("/rmm", rmmRouter);                            // Compatibility URL without /api prefix
app.use("/api", testsRoutes);                          // Test and verification endpoints
app.use("/api", supportReportRoutes);                  // User support request

// ── 🔌 External Integrations
app.use("/api/bitdefender", bitdefenderRouter);        // Integration BitDefender GravityZo(Community + Pro)
app.use("/api/mailinblack", mailinblackRouter);       // Integration Mailinblack Protect (Community + Pro)
app.use("/api/equipment-monitoring-alerts", equipmentMonitoringAlertsRouter);
app.use("/api/equipment", equipmentMetaRouter);
app.use("/api/supervision/alert-rules", supervisionAlertRulesRouter);
app.use("/api/supervision/monitoring-automation", monitoringAutomationRouter);
app.use("/api/checkmk", checkmkRouter);                // Monitoring CheckMK (Community + Pro)
app.use("/api/unifi", requireProAuth, unifiEquipmentRouter);           // UniFi API per team (UDM Pro)
app.use("/api/ovh", ovhRouter);                        // Integration OVH (Community + Pro)
app.use("/api/partner-center", requireProAuth, partnerCenterRouter);  // Integration Microsoft Partner Center
app.use("/api/office365", verifyJWT, office365Router);            // Microsoft Graph API integration for Office 365
app.use("/api/whatsapp", requirePro, whatsappRouter);              // Public Meta webhook; JWT enforced in router
app.use("/api/ai", aiRouter);                                      // Copilote IA (settings Admin Interconnexions)
app.use("/api/client-office365", verifyJWT, office365ClientRouter); // Per-client Office 365 credential management
app.use("/api/client-bitdefender", bitdefenderClientRouter); // Per-client Bitdefender tenants
app.use("/api/client-mailinblack", mailinblackClientRouter); // Per-client Mailinblack tenants

// ───────────────────────────────────────────────
// Compatibility route aliases (legacy paths without /api prefix)
// ───────────────────────────────────────────────
app.use("/maintenance", maintenanceRoutes);       // Compatibility: /maintenance/* → /api/maintenance/*
app.use("/auth", authRoutes);                    // Compatibility: /auth/* → /api/auth/*
app.use("/users", userRoutes);                    // Compatibility: /users/* → /api/users/*
app.use("/profiles", profilesRouter);             // Compatibility: /profiles/* → /api/profiles/*
app.use("/teams", requireProAuth, teamsRoutes);                   // Compatibility: /teams/* → /api/teams/*
app.use("/", testsRoutes);                        // Compatibility: /status, /db-status → /api/status, /api/db-status

// ───────────────────────────────────────────────
// 🏥 Health check endpoints (for Docker/Kubernetes)
// ───────────────────────────────────────────────

app.get('/health/live', (req, res) => {
  res.status(200).json({ 
    status: 'alive', 
    timestamp: new Date().toISOString()
  });
});

app.get('/health', async (req, res) => {
  try {
    // Verify database connectivity
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
// 📋 API root info endpoint
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
// 🚀 Start the server
// ───────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

// Get all available IPs
function getServerIPs() {
  const interfaces = os.networkInterfaces();
  const ips = ['localhost'];
  
  // Collect all non-localhost IPv4 addresses
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  
  return ips;
}

// Determine protocol (http or https)
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
