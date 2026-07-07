// ───────────────────────────────────────────────
// 🧪 Routes de test et vérification
// ───────────────────────────────────────────────
import express from 'express';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import { pool } from '../../database/db.js';
import { getSettingsMap } from '../../utils/settingsHelper.js';
import { getAppVersion, APP_NAME } from '../../utils/version.js';
import { requireSetupOrAdmin } from '../../middleware/setupGuard.js';
import {
  applyDatabaseConfiguration,
  createDatabaseTestPool,
  loadCurrentDatabaseSettings,
  normalizeDatabaseConfig,
  resolveDatabaseCredentials,
} from '../../utils/databaseConfigStore.js';
import { verifyVeritasConformance } from '../../utils/verifyVeritasDatabase.js';

const router = express.Router();

// ───────────────────────────────────────────────
// 🩺 GET /api/status — Vérifie si l'API répond
// ───────────────────────────────────────────────
router.get('/status', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.json({ status: 'ok' });
  }
  res.json({ status: 'ok', name: APP_NAME, version: getAppVersion() });
});

// ───────────────────────────────────────────────
// 🗄️ GET /api/db-status — Vérifie si la base de données est joignable
// ───────────────────────────────────────────────
router.get('/db-status', async (req, res) => {
  if (!process.env.DATABASE_URL?.trim()) {
    return res.json({ status: 'error', error: 'Base de données non configurée' });
  }
  try {
    await pool.query('SELECT 1');
    res.json({ status: "ok" });
  } catch (err) {
    console.error("[db-status]", err.message);
    const payload = { status: "error" };
    if (process.env.NODE_ENV !== "production") {
      payload.error = err.message;
    }
    res.json(payload);
  }
});

router.use(requireSetupOrAdmin);

// ───────────────────────────────────────────────
// 📊 GET /api/db-stats — Statistiques PostgreSQL
// ───────────────────────────────────────────────
router.get('/db-stats', async (req, res) => {
  if (!process.env.DATABASE_URL?.trim()) {
    return res.status(503).json({
      connected: false,
      error: 'Base de données non configurée',
    });
  }

  try {
    await pool.query('SELECT 1');

    const [sizeResult, tablesResult, connResult, maxConnResult, versionResult, topTablesResult] =
      await Promise.all([
        pool.query(
          `SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
                  pg_database_size(current_database()) AS size_bytes`
        ),
        pool.query(
          `SELECT count(*)::int AS count
           FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
        ),
        pool.query(
          `SELECT count(*)::int AS active
           FROM pg_stat_activity
           WHERE datname = current_database()`
        ),
        pool.query('SHOW max_connections'),
        pool.query('SELECT version()'),
        pool.query(
          `SELECT relname AS name,
                  pg_size_pretty(pg_total_relation_size(relid)) AS size_pretty,
                  pg_total_relation_size(relid) AS size_bytes
           FROM pg_catalog.pg_statio_user_tables
           ORDER BY pg_total_relation_size(relid) DESC
           LIMIT 8`
        ),
      ]);

    const maxConnections = parseInt(maxConnResult.rows[0]?.max_connections, 10);

    res.json({
      connected: true,
      sizePretty: sizeResult.rows[0]?.size,
      sizeBytes: Number(sizeResult.rows[0]?.size_bytes || 0),
      tableCount: tablesResult.rows[0]?.count ?? 0,
      activeConnections: connResult.rows[0]?.active ?? 0,
      maxConnections: Number.isFinite(maxConnections) ? maxConnections : null,
      version: String(versionResult.rows[0]?.version || '').split(',')[0],
      topTables: (topTablesResult.rows || []).map((row) => ({
        name: row.name,
        sizePretty: row.size_pretty,
        sizeBytes: Number(row.size_bytes || 0),
      })),
    });
  } catch (err) {
    console.error('[db-stats]', err.message);
    res.status(500).json({
      connected: false,
      error: 'Impossible de récupérer les statistiques',
      details: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// 🧪 POST /api/db-test — Test de connexion + conformité Veritas
// ───────────────────────────────────────────────
router.post('/db-test', async (req, res) => {
  try {
    const current = await loadCurrentDatabaseSettings().catch(() => normalizeDatabaseConfig());
    const config = resolveDatabaseCredentials(req.body || {}, current);

    if (!config.db_host || !config.db_port || !config.db_user || !config.db_name) {
      return res.status(400).json({
        success: false,
        connectionOk: false,
        veritasOk: false,
        error: 'Paramètres manquants',
        details: 'Hôte, port, base, utilisateur et mot de passe sont requis',
      });
    }

    if (!String(config.db_password ?? '').trim()) {
      return res.status(400).json({
        success: false,
        connectionOk: false,
        veritasOk: false,
        error: 'Mot de passe requis',
        details: 'Saisissez le mot de passe PostgreSQL ou conservez celui déjà enregistré.',
      });
    }

    const testPool = await createDatabaseTestPool(config);
    let client;

    try {
      client = await testPool.connect();

      const versionResult = await client.query('SELECT version()');
      const dbInfoResult = await client.query(`
        SELECT
          current_database() as database,
          inet_server_addr() as host,
          inet_server_port() as port,
          current_user as user
      `);

      const databaseInfo = {
        version: versionResult.rows[0].version,
        database: dbInfoResult.rows[0].database,
        host: dbInfoResult.rows[0].host || config.db_host,
        port: dbInfoResult.rows[0].port || config.db_port,
        user: dbInfoResult.rows[0].user,
      };

      const veritas = await verifyVeritasConformance((sql, params = []) => client.query(sql, params));
      const connectionOk = true;
      const veritasOk = veritas.conformant;

      res.json({
        success: connectionOk && veritasOk,
        connectionOk,
        veritasOk,
        message: connectionOk ? 'Connexion réussie' : 'Connexion échouée',
        veritasMessage: veritasOk
          ? 'Base conforme au schéma Veritas.'
          : veritas.missingTables.length > 0
            ? `Tables Veritas manquantes : ${veritas.missingTables.join(', ')}`
            : 'Schéma Veritas incomplet (migration de référence absente).',
        databaseInfo,
        veritas,
      });
    } finally {
      if (client) client.release();
      await testPool.end().catch(() => {});
    }
  } catch (err) {
    res.status(500).json({
      success: false,
      connectionOk: false,
      veritasOk: false,
      error: 'Erreur de connexion à la base de données',
      details: err.message,
    });
  }
});

// 💾 POST /api/db-apply — Enregistre et applique la configuration PostgreSQL
// ───────────────────────────────────────────────
router.post('/db-apply', async (req, res) => {
  try {
    const current = await loadCurrentDatabaseSettings().catch(() => normalizeDatabaseConfig());
    const config = resolveDatabaseCredentials(req.body || {}, current);

    if (!config.db_host || !config.db_port || !config.db_user || !config.db_name) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres manquants',
        details: 'Hôte, port, base et utilisateur sont requis',
      });
    }

    if (!String(config.db_password ?? '').trim()) {
      return res.status(400).json({
        success: false,
        error: 'Mot de passe requis',
        details: 'Saisissez le mot de passe PostgreSQL ou conservez celui déjà enregistré.',
      });
    }

    const testPool = await createDatabaseTestPool(config);
    let client;

    try {
      client = await testPool.connect();
      await client.query('SELECT 1');
      const veritas = await verifyVeritasConformance((sql, params = []) => client.query(sql, params));

      if (!veritas.conformant) {
        return res.status(400).json({
          success: false,
          error: 'Base non conforme à Veritas',
          details: veritas.missingTables.length > 0
            ? `Tables manquantes : ${veritas.missingTables.join(', ')}`
            : 'La migration de référence Veritas est absente sur cette base.',
          veritas,
        });
      }
    } finally {
      if (client) client.release();
      await testPool.end().catch(() => {});
    }

    await applyDatabaseConfiguration(config);

    res.json({
      success: true,
      message: 'Configuration PostgreSQL enregistrée et appliquée.',
      restartRecommended: true,
    });
  } catch (err) {
    console.error('[db-apply]', err.message);
    res.status(500).json({
      success: false,
      error: 'Impossible d\'appliquer la configuration PostgreSQL',
      details: err.message,
    });
  }
});

// ───────────────────────────────────────────────
// 🧹 POST /api/db-maintenance — Maintenance PostgreSQL
// ───────────────────────────────────────────────
router.post('/db-maintenance', async (req, res) => {
  try {
    const { action } = req.body || {};

    if (action !== 'vacuum_analyze') {
      return res.status(400).json({
        success: false,
        error: 'Action non supportée',
        details: 'Seule l\'action vacuum_analyze est disponible',
      });
    }

    if (!process.env.DATABASE_URL?.trim()) {
      return res.status(503).json({
        success: false,
        error: 'Base de données non configurée',
      });
    }

    await pool.query('VACUUM ANALYZE');

    res.json({
      success: true,
      message: 'Maintenance VACUUM ANALYZE terminée',
    });
  } catch (err) {
    console.error('[db-maintenance]', err.message);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la maintenance',
      details: err.message,
    });
  }
});

// ───────────────────────────────────────────────
// 📡 GET /api/unifi-status — Statut de l'API UniFi
// ───────────────────────────────────────────────
router.get('/unifi-status', async (req, res) => {
  try {
    // Récupération des paramètres depuis la base de données (décryptés)
    const settingsMap = await getSettingsMap(['UNIFI_API_KEY']);
    const apiKey = settingsMap.UNIFI_API_KEY || process.env.UNIFI_API_KEY;
    
    if (!apiKey) {
      return res.status(500).json({ 
        status: "error", 
        error: "Configuration UniFi incomplète" 
      });
    }

    // Test de connexion à l'API UniFi Site Manager
    // Endpoint de base pour vérifier l'authentification
    const response = await fetch('https://api.ui.com/v1/hosts', {
      method: 'GET',
      headers: {
        'X-API-KEY': apiKey,
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      res.json({ status: "ok" });
    } else {
      res.status(500).json({ status: "error", error: "Connexion UniFi échouée" });
    }
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ───────────────────────────────────────────────
// 📡 POST /api/unifi-test — Test de connexion UniFi avec paramètres personnalisés
// ───────────────────────────────────────────────
router.post('/unifi-test', async (req, res) => {
  try {
    const { UNIFI_API_KEY } = req.body;
    
    // Validation des paramètres requis
    if (!UNIFI_API_KEY) {
      return res.status(400).json({
        success: false,
        error: 'Paramètre manquant',
        details: 'La clé API UniFi est requise'
      });
    }

    // Test de connexion à l'API UniFi Site Manager
    // Endpoint pour récupérer la liste des hosts (test basique d'authentification)
    const response = await fetch('https://api.ui.com/v1/hosts', {
      method: 'GET',
      headers: {
        'X-API-KEY': UNIFI_API_KEY,
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      
      // Essayer de récupérer la liste des sites pour vérifier les permissions
      const sitesResponse = await fetch('https://api.ui.com/v1/sites', {
        method: 'GET',
        headers: {
          'X-API-KEY': UNIFI_API_KEY,
          'Accept': 'application/json'
        }
      });

      let sitesInfo = null;
      if (sitesResponse.ok) {
        const sitesData = await sitesResponse.json();
        sitesInfo = {
          count: Array.isArray(sitesData.data) ? sitesData.data.length : 0,
          available: true
        };
      }

      res.json({
        success: true,
        message: 'Connexion à l\'API UniFi Site Manager réussie',
        unifiInfo: {
          apiKey: UNIFI_API_KEY.substring(0, 8) + '...',
          hostsAvailable: Array.isArray(data.data) ? data.data.length : 0,
          sitesAvailable: sitesInfo?.count || 0,
          ...(sitesInfo && { sitesCount: sitesInfo.count })
        }
      });
    } else {
      const errorData = await response.json().catch(() => ({}));
      
      // Gérer les erreurs spécifiques de l'API UniFi
      let errorMessage = 'Erreur de connexion à l\'API UniFi';
      if (response.status === 401) {
        errorMessage = 'API Key invalide ou expirée';
      } else if (response.status === 403) {
        errorMessage = 'Accès refusé - Vérifiez les permissions de votre API Key';
      } else if (response.status === 429) {
        errorMessage = 'Limite de taux dépassée - Trop de requêtes';
      }
      
      res.status(500).json({
        success: false,
        error: errorMessage,
        details: errorData.message || `HTTP ${response.status}: ${response.statusText}`
      });
    }

  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Erreur de connexion à l\'API UniFi',
      details: err.message
    });
  }
});

// ───────────────────────────────────────────────
// 🐙 POST /api/github-test — Test de connexion GitHub
// ───────────────────────────────────────────────
router.post('/github-test', async (req, res) => {
  try {
    const { GITHUB_TOKEN, GITHUB_REPO_FRONT, GITHUB_REPO_BACK } = req.body;
    
    // Validation des paramètres requis
    if (!GITHUB_TOKEN) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres manquants',
        details: 'Le token GitHub est requis'
      });
    }

    // Test de connexion à l'API GitHub
    const response = await fetch('https://api.github.com/user', {
      method: 'GET',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Veritas-App'
      }
    });

    if (response.ok) {
      const userData = await response.json();
      
      // Test des repositories si fournis
      let repoStatus = {};
      if (GITHUB_REPO_FRONT) {
        try {
          const repoResponse = await fetch(`https://api.github.com/repos/${GITHUB_REPO_FRONT}`, {
            headers: {
              'Authorization': `token ${GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'Veritas-App'
            }
          });
          repoStatus.frontend = repoResponse.ok ? 'accessible' : 'inaccessible';
        } catch (e) {
          repoStatus.frontend = 'erreur';
        }
      }
      
      if (GITHUB_REPO_BACK) {
        try {
          const repoResponse = await fetch(`https://api.github.com/repos/${GITHUB_REPO_BACK}`, {
            headers: {
              'Authorization': `token ${GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'Veritas-App'
            }
          });
          repoStatus.backend = repoResponse.ok ? 'accessible' : 'inaccessible';
        } catch (e) {
          repoStatus.backend = 'erreur';
        }
      }
      
      res.json({
        success: true,
        message: 'Connexion GitHub réussie',
        githubInfo: {
          user: userData.login,
          name: userData.name,
          email: userData.email,
          token: GITHUB_TOKEN.substring(0, 8) + '...',
          repositories: repoStatus
        }
      });
    } else {
      const errorData = await response.json().catch(() => ({}));
      res.status(500).json({
        success: false,
        error: 'Erreur de connexion à GitHub',
        details: errorData.message || `HTTP ${response.status}: ${response.statusText}`
      });
    }

  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Erreur de connexion à GitHub',
      details: err.message
    });
  }
});

// ───────────────────────────────────────────────
// 📧 POST /api/email-test — Test d'envoi d'email
// ───────────────────────────────────────────────
router.post('/email-test', async (req, res) => {
  try {
    const {
      BUG_REPORT_EMAIL,
      SMTP_HOST,
      SMTP_PORT,
      SMTP_USER,
      SMTP_PASS,
    } = req.body;

    const settingsMap = await getSettingsMap(['SMTP_USER', 'SMTP_PASS']);
    
    // Validation des paramètres requis
    if (!BUG_REPORT_EMAIL || !SMTP_HOST || !SMTP_PORT) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres manquants',
        details: 'Tous les paramètres email sont requis'
      });
    }

    const smtpUser = SMTP_USER || settingsMap.SMTP_USER || process.env.SMTP_USER || '';
    const smtpPass = SMTP_PASS || settingsMap.SMTP_PASS || process.env.SMTP_PASS || '';
    const smtpPort = parseInt(SMTP_PORT, 10);

    // Configuration du transporteur SMTP
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: smtpPort,
      secure: smtpPort === 465, // true pour 465, false pour autres ports
      auth: smtpUser
        ? {
            user: smtpUser,
            pass: smtpPass,
          }
        : undefined,
    });

    // Test de connexion SMTP
    await transporter.verify();
    
    // Envoi d'un email de test
    const fromAddress = smtpUser || BUG_REPORT_EMAIL;
    const testEmail = {
      from: fromAddress,
      to: BUG_REPORT_EMAIL,
      subject: 'Test de configuration email - Veritas',
      text: 'Ceci est un email de test pour vérifier la configuration SMTP.',
      html: `
        <h2>Test de configuration email</h2>
        <p>Ceci est un email de test pour vérifier la configuration SMTP de Veritas.</p>
        <p><strong>Serveur SMTP:</strong> ${SMTP_HOST}:${SMTP_PORT}</p>
        <p><strong>Email de destination:</strong> ${BUG_REPORT_EMAIL}</p>
        <p>Si vous recevez cet email, la configuration est correcte !</p>
      `
    };

    const info = await transporter.sendMail(testEmail);
    
    res.json({
      success: true,
      message: 'Email de test envoyé avec succès',
      emailInfo: {
        to: BUG_REPORT_EMAIL,
        smtpHost: SMTP_HOST,
        smtpPort: SMTP_PORT,
        messageId: info.messageId,
        response: info.response
      }
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Erreur d\'envoi d\'email',
      details: err.message
    });
  }
});

export default router;

