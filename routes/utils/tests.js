import express from 'express';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import { pool } from '../../database/db.js';
import { getSettingsMap } from '../../utils/settingsHelper.js';
import { getAppVersion, APP_NAME } from '../../utils/version.js';
import { requireSetupOrAdmin } from '../../middleware/setupGuard.js';
import { applyDatabaseConfiguration, createDatabaseTestPool, loadCurrentDatabaseSettings, normalizeDatabaseConfig, resolveDatabaseCredentials } from '../../utils/databaseConfigStore.js';
import { verifyVeritasConformance } from '../../utils/verifyVeritasDatabase.js';
const router = express.Router();
router.get('/status', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.json({
      status: 'ok'
    });
  }
  res.json({
    status: 'ok',
    name: APP_NAME,
    version: getAppVersion()
  });
});
router.get('/db-status', async (req, res) => {
  if (!process.env.DATABASE_URL?.trim()) {
    return res.json({
      status: 'error',
      error: 'Database not configured'
    });
  }
  try {
    await pool.query('SELECT 1');
    res.json({
      status: "ok"
    });
  } catch (err) {
    console.error("[db-status]", err.message);
    const payload = {
      status: "error"
    };
    if (process.env.NODE_ENV !== "production") {
      payload.error = err.message;
    }
    res.json(payload);
  }
});
router.use(requireSetupOrAdmin);
router.get('/db-stats', async (req, res) => {
  if (!process.env.DATABASE_URL?.trim()) {
    return res.status(503).json({
      connected: false,
      error: 'Database not configured'
    });
  }
  try {
    await pool.query('SELECT 1');
    const [sizeResult, tablesResult, connResult, maxConnResult, versionResult, topTablesResult] = await Promise.all([pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
                  pg_database_size(current_database()) AS size_bytes`), pool.query(`SELECT count(*)::int AS count
           FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`), pool.query(`SELECT count(*)::int AS active
           FROM pg_stat_activity
           WHERE datname = current_database()`), pool.query('SHOW max_connections'), pool.query('SELECT version()'), pool.query(`SELECT relname AS name,
                  pg_size_pretty(pg_total_relation_size(relid)) AS size_pretty,
                  pg_total_relation_size(relid) AS size_bytes
           FROM pg_catalog.pg_statio_user_tables
           ORDER BY pg_total_relation_size(relid) DESC
           LIMIT 8`)]);
    const maxConnections = parseInt(maxConnResult.rows[0]?.max_connections, 10);
    res.json({
      connected: true,
      sizePretty: sizeResult.rows[0]?.size,
      sizeBytes: Number(sizeResult.rows[0]?.size_bytes || 0),
      tableCount: tablesResult.rows[0]?.count ?? 0,
      activeConnections: connResult.rows[0]?.active ?? 0,
      maxConnections: Number.isFinite(maxConnections) ? maxConnections : null,
      version: String(versionResult.rows[0]?.version || '').split(',')[0],
      topTables: (topTablesResult.rows || []).map(row => ({
        name: row.name,
        sizePretty: row.size_pretty,
        sizeBytes: Number(row.size_bytes || 0)
      }))
    });
  } catch (err) {
    console.error('[db-stats]', err.message);
    res.status(500).json({
      connected: false,
      error: 'Unable to retrieve statistics',
      details: process.env.NODE_ENV !== 'production' ? err.message : undefined
    });
  }
});
router.post('/db-test', async (req, res) => {
  try {
    const current = await loadCurrentDatabaseSettings().catch(() => normalizeDatabaseConfig());
    const config = resolveDatabaseCredentials(req.body || {}, current);
    if (!config.db_host || !config.db_port || !config.db_user || !config.db_name) {
      return res.status(400).json({
        success: false,
        connectionOk: false,
        veritasOk: false,
        error: 'Missing parameters',
        details: 'Host, port, database, user and password are required'
      });
    }
    if (!String(config.db_password ?? '').trim()) {
      return res.status(400).json({
        success: false,
        connectionOk: false,
        veritasOk: false,
        error: 'Password required',
        details: 'Enter the PostgreSQL password or keep the one already saved.'
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
        user: dbInfoResult.rows[0].user
      };
      const veritas = await verifyVeritasConformance((sql, params = []) => client.query(sql, params));
      const connectionOk = true;
      const veritasOk = veritas.conformant;
      res.json({
        success: connectionOk && veritasOk,
        connectionOk,
        veritasOk,
        message: connectionOk ? 'Connection successful' : 'Connection failed',
        veritasMessage: veritasOk ? 'Database matches Veritas schema.' : veritas.missingTables.length > 0 ? `Tables Veritas manquantes : ${veritas.missingTables.join(', ')}` : 'Veritas schema incomplete (reference migration missing).',
        databaseInfo,
        veritas
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
      error: 'Database connection error',
      details: err.message
    });
  }
});
router.post('/db-apply', async (req, res) => {
  try {
    const current = await loadCurrentDatabaseSettings().catch(() => normalizeDatabaseConfig());
    const config = resolveDatabaseCredentials(req.body || {}, current);
    if (!config.db_host || !config.db_port || !config.db_user || !config.db_name) {
      return res.status(400).json({
        success: false,
        error: 'Missing parameters',
        details: 'Host, port, database and user are required'
      });
    }
    if (!String(config.db_password ?? '').trim()) {
      return res.status(400).json({
        success: false,
        error: 'Password required',
        details: 'Enter the PostgreSQL password or keep the one already saved.'
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
          error: 'Database does not match Veritas',
          details: veritas.missingTables.length > 0 ? `Tables manquantes : ${veritas.missingTables.join(', ')}` : 'Veritas reference migration is missing on this database.',
          veritas
        });
      }
    } finally {
      if (client) client.release();
      await testPool.end().catch(() => {});
    }
    await applyDatabaseConfiguration(config);
    res.json({
      success: true,
      message: 'PostgreSQL configuration saved and applied.',
      restartRecommended: true
    });
  } catch (err) {
    console.error('[db-apply]', err.message);
    res.status(500).json({
      success: false,
      error: 'Unable to apply PostgreSQL configuration',
      details: err.message
    });
  }
});
router.post('/db-maintenance', async (req, res) => {
  try {
    const {
      action
    } = req.body || {};
    if (action !== 'vacuum_analyze') {
      return res.status(400).json({
        success: false,
        error: 'Unsupported action',
        details: 'Only the vacuum_analyze action is available'
      });
    }
    if (!process.env.DATABASE_URL?.trim()) {
      return res.status(503).json({
        success: false,
        error: 'Database not configured'
      });
    }
    await pool.query('VACUUM ANALYZE');
    res.json({
      success: true,
      message: 'VACUUM ANALYZE maintenance completed'
    });
  } catch (err) {
    console.error('[db-maintenance]', err.message);
    res.status(500).json({
      success: false,
      error: 'Error during maintenance',
      details: err.message
    });
  }
});
router.get('/unifi-status', async (req, res) => {
  try {
    const settingsMap = await getSettingsMap(['UNIFI_API_KEY']);
    const apiKey = settingsMap.UNIFI_API_KEY || process.env.UNIFI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        status: "error",
        error: "UniFi configuration incomplete"
      });
    }
    const response = await fetch('https://api.ui.com/v1/hosts', {
      method: 'GET',
      headers: {
        'X-API-KEY': apiKey,
        'Accept': 'application/json'
      }
    });
    if (response.ok) {
      res.json({
        status: "ok"
      });
    } else {
      res.status(500).json({
        status: "error",
        error: "UniFi connection failed"
      });
    }
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: err.message
    });
  }
});
router.post('/unifi-test', async (req, res) => {
  try {
    const {
      UNIFI_API_KEY
    } = req.body;
    if (!UNIFI_API_KEY) {
      return res.status(400).json({
        success: false,
        error: 'Missing parameter',
        details: 'UniFi API key is required'
      });
    }
    const response = await fetch('https://api.ui.com/v1/hosts', {
      method: 'GET',
      headers: {
        'X-API-KEY': UNIFI_API_KEY,
        'Accept': 'application/json'
      }
    });
    if (response.ok) {
      const data = await response.json();
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
        message: 'Connection to l\\\'API UniFi Site Manager successful',
        unifiInfo: {
          apiKey: UNIFI_API_KEY.substring(0, 8) + '...',
          hostsAvailable: Array.isArray(data.data) ? data.data.length : 0,
          sitesAvailable: sitesInfo?.count || 0,
          ...(sitesInfo && {
            sitesCount: sitesInfo.count
          })
        }
      });
    } else {
      const errorData = await response.json().catch(() => ({}));
      let errorMessage = 'UniFi API connection error';
      if (response.status === 401) {
        errorMessage = 'Invalid or expired API key';
      } else if (response.status === 403) {
        errorMessage = 'Access denied - Check your API key permissions';
      } else if (response.status === 429) {
        errorMessage = 'Rate limit exceeded - Too many requests';
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
      error: 'UniFi API connection error',
      details: err.message
    });
  }
});
router.post('/github-test', async (req, res) => {
  try {
    const {
      GITHUB_TOKEN,
      GITHUB_REPO_FRONT,
      GITHUB_REPO_BACK
    } = req.body;
    if (!GITHUB_TOKEN) {
      return res.status(400).json({
        success: false,
        error: 'Missing parameters',
        details: 'GitHub token is required'
      });
    }
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
          repoStatus.frontend = 'error';
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
          repoStatus.backend = 'error';
        }
      }
      res.json({
        success: true,
        message: 'GitHub connection successful',
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
        error: 'GitHub connection error',
        details: errorData.message || `HTTP ${response.status}: ${response.statusText}`
      });
    }
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'GitHub connection error',
      details: err.message
    });
  }
});
router.post('/email-test', async (req, res) => {
  try {
    const {
      BUG_REPORT_EMAIL,
      SMTP_HOST,
      SMTP_PORT,
      SMTP_USER,
      SMTP_PASS
    } = req.body;
    const settingsMap = await getSettingsMap(['SMTP_USER', 'SMTP_PASS']);
    if (!BUG_REPORT_EMAIL || !SMTP_HOST || !SMTP_PORT) {
      return res.status(400).json({
        success: false,
        error: 'Missing parameters',
        details: 'All email settings are required'
      });
    }
    const smtpUser = SMTP_USER || settingsMap.SMTP_USER || process.env.SMTP_USER || '';
    const smtpPass = SMTP_PASS || settingsMap.SMTP_PASS || process.env.SMTP_PASS || '';
    const smtpPort = parseInt(SMTP_PORT, 10);
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: smtpUser ? {
        user: smtpUser,
        pass: smtpPass
      } : undefined
    });
    await transporter.verify();
    const fromAddress = smtpUser || BUG_REPORT_EMAIL;
    const testEmail = {
      from: fromAddress,
      to: BUG_REPORT_EMAIL,
      subject: 'Test de configuration email - Veritas',
      text: 'This is a test email to verify SMTP configuration.',
      html: `
 <h2>Email configuration test</h2>
 <p>This is a tis email to verify SMTP configuration de Veritas.</p>
 <p><strong>SMTP server:</strong> ${SMTP_HOST}:${SMTP_PORT}</p>
 <p><strong>Destination email:</strong> ${BUG_REPORT_EMAIL}</p>
 <p>If yor receive this email, the configuration is correct !</p>
 `
    };
    const info = await transporter.sendMail(testEmail);
    res.json({
      success: true,
      message: 'Test email sent successfully',
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
      error: 'Email send error',
      details: err.message
    });
  }
});
export default router;
