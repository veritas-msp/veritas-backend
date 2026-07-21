import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { requirePro } from '../../middleware/edition.js';
import fetch from 'node-fetch';
import { generateCampaignReportPDF } from '../../utils/pdfGenerator.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { dispatchNotificationEvent } from "../../services/notificationDispatcher.js";
import { resolveFileUploadedBy } from "../../utils/fileUploadedBy.js";
import { ensureVisibleToClientColumn, hasVisibleToClientColumn, parseVisibleToClient } from "../../utils/clientFilesVisibility.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CAMPAIGN_REPORTS_DIR = path.join(__dirname, "..", "..", "uploads", "campaign-reports");
if (!fs.existsSync(CAMPAIGN_REPORTS_DIR)) {
  fs.mkdirSync(CAMPAIGN_REPORTS_DIR, {
    recursive: true
  });
}
const CLIENT_FILES_DIR = path.join(__dirname, "..", "..", "uploads", "client-files");
if (!fs.existsSync(CLIENT_FILES_DIR)) {
  fs.mkdirSync(CLIENT_FILES_DIR, {
    recursive: true
  });
}
function buildSnapshotComparison(startSnapshot, endSnapshot) {
  return {
    adminCount: {
      start: startSnapshot.admin_count,
      end: endSnapshot.admin_count,
      change: endSnapshot.admin_count - startSnapshot.admin_count
    },
    userCount: {
      start: startSnapshot.user_count,
      end: endSnapshot.user_count,
      change: endSnapshot.user_count - startSnapshot.user_count
    },
    mfaPercentage: {
      start: parseFloat(startSnapshot.mfa_percentage),
      end: parseFloat(endSnapshot.mfa_percentage),
      change: parseFloat(endSnapshot.mfa_percentage) - parseFloat(startSnapshot.mfa_percentage)
    },
    mfaEnabledCount: {
      start: startSnapshot.mfa_enabled_count,
      end: endSnapshot.mfa_enabled_count,
      change: endSnapshot.mfa_enabled_count - startSnapshot.mfa_enabled_count
    }
  };
}
async function ensureCampaignReportPdf(clientId, campaignId) {
  const pdfPath = path.join(CAMPAIGN_REPORTS_DIR, `campaign_${campaignId}_report.pdf`);
  if (fs.existsSync(pdfPath)) {
    return pdfPath;
  }
  const [startResult, endResult, campaignResult] = await Promise.all([pool.query(`SELECT * FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'start'`, [campaignId]), pool.query(`SELECT * FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'end'`, [campaignId]), pool.query(`SELECT c.*, cl.name as client_name
       FROM v_b_clients_c_campaign c
       LEFT JOIN v_b_clients cl ON c.client_id::text = cl.id::text
       WHERE c.id = $1 AND c.client_id::text = $2::text`, [campaignId, clientId])]);
  if (!campaignResult.rows[0] || !startResult.rows[0] || !endResult.rows[0]) {
    return null;
  }
  const startSnapshot = startResult.rows[0];
  const endSnapshot = endResult.rows[0];
  const comparison = buildSnapshotComparison(startSnapshot, endSnapshot);
  await generateCampaignReportPDF(campaignResult.rows[0], startSnapshot, endSnapshot, comparison, pdfPath);
  return fs.existsSync(pdfPath) ? pdfPath : null;
}
const router = express.Router();
const DEFAULT_MS_SECURITY_STEPS_BY_LOCALE = {
  fr: ["Oral then written communication to the client", "Provide user help documentation at MFA enrollment", "Campaign start snapshot", "Forcer l'enrollement des comptes administrateurs et/ou utilisateurs", "Snapshot de fin de campagne", "Provide campaign report to the client"],
  en: ["Oral then written communication to the client", "Provide user help documentation for MFA enrollment", "Campaign start snapshot", "Enforce MFA enrollment for administrator and/or user accounts", "Campaign end snapshot", "Provide the campaign report to the client"],
  de: ["Mündliche und anschließend schriftliche Kommunikation mit dem Kunden", "Bereitstellung der Benutzerhilfe-Dokumentation zur MFA-Registrierung", "Snapshot zu Beginn der Kampagne", "MFA-Enrollment für Administrator- und/oder Benutzerkonten erzwingen", "Snapshot zum Ende der Kampagne", "Bereitstellung des Kampagnenberichts an den Kunden"],
  it: ["Comunicazione orale e poi scritta al cliente", "Messa a disposizione della documentazione di aiuto utente per la registrazione MFA", "Snapshot di inizio campagna", "Forzare l'enrollment degli account amministratore e/o utente", "Snapshot di fine campagna", "Messa a disposizione del report di campagna al cliente"],
  es: ["Comunicación oral y luego escrita al cliente", "Puesta a disposición de la documentación de ayuda al usuario para el registro MFA", "Instantánea de inicio de campaña", "Forzar el enrollment de las cuentas de administrador y/o usuarios", "Instantánea de fin de campaña", "Puesta a disposición del informe de campaña al cliente"]
};
function normalizeCampaignLocale(locale) {
  const code = String(locale || "fr").trim().toLowerCase().slice(0, 2);
  return DEFAULT_MS_SECURITY_STEPS_BY_LOCALE[code] ? code : "fr";
}
function getDefaultMicrosoftSecuritySteps(locale) {
  const names = DEFAULT_MS_SECURITY_STEPS_BY_LOCALE[normalizeCampaignLocale(locale)];
  return names.map((name, index) => ({
    name,
    order_index: index + 1
  }));
}
function isCampaignApiPath(pathname) {
  const path = String(pathname || "").split("?")[0];
  if (path === "/all-campaigns") return true;
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "campaigns") return true;
  return segments.length >= 2 && segments[1] === "campaigns";
}
router.use((req, res, next) => {
  if (!isCampaignApiPath(req.path)) {
    return next("router");
  }
  next();
});
router.use(verifyJWT, requirePro);
const RECENT_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function normalizeNumericColumn(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
async function getClientMfaStatsFromDb(clientId) {
  const result = await pool.query(`
    SELECT
      COUNT(*) as total_users,
      COUNT(CASE WHEN is_admin = true THEN 1 END) as admin_count,
      COUNT(CASE WHEN is_admin = false THEN 1 END) as non_admin_count,
      COUNT(CASE WHEN has_mfa = true THEN 1 END) as users_with_mfa,
      COUNT(CASE WHEN has_mfa = true AND is_admin = true THEN 1 END) as admins_with_mfa,
      COUNT(CASE WHEN has_mfa = true AND is_admin = false THEN 1 END) as non_admins_with_mfa,
      MAX(last_sync) as last_sync
    FROM v_b_clients_c_azure_mfa
    WHERE client_id = $1 AND account_enabled = true
  `, [clientId]);
  if (result.rows.length === 0 || !result.rows[0].total_users || parseInt(result.rows[0].total_users) === 0) {
    return null;
  }
  const row = result.rows[0];
  const totalUsers = parseInt(row.total_users);
  const adminCount = parseInt(row.admin_count);
  const nonAdminCount = parseInt(row.non_admin_count);
  const usersWithMfa = parseInt(row.users_with_mfa);
  const adminsWithMfa = parseInt(row.admins_with_mfa);
  const nonAdminsWithMfa = parseInt(row.non_admins_with_mfa);
  const adminMfaPercentage = adminCount > 0 ? Math.round(adminsWithMfa / adminCount * 10000) / 100 : 0;
  const nonAdminMfaPercentage = nonAdminCount > 0 ? Math.round(nonAdminsWithMfa / nonAdminCount * 10000) / 100 : 0;
  const userMfaPercentage = totalUsers > 0 ? Math.round(usersWithMfa / totalUsers * 10000) / 100 : 0;
  const mfaPercentage = userMfaPercentage;
  const mfaEnabledCount = usersWithMfa;
  const mfaDisabledCount = Math.max(0, totalUsers - usersWithMfa);
  return {
    adminCount,
    nonAdminCount,
    userCount: totalUsers,
    adminMfaPercentage,
    nonAdminMfaPercentage,
    userMfaPercentage,
    mfaPercentage,
    mfaEnabledCount,
    mfaDisabledCount,
    lastSync: row.last_sync
  };
}
router.get('/all-campaigns', requirePermission('cybersecurite.view'), async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const countResult = await pool.query('SELECT COUNT(*) as total FROM v_b_clients_c_campaign');
    const {
      status,
      type,
      client_id
    } = req.query;
    let query = `
      SELECT
        c.id, c.client_id, c.name, c.type, c.status, c.start_date, c.end_date,
        c.global_progress, c.description, c.objectif_adoption, c.created_at, c.updated_at, c.created_by,
        c.updated_by, c.provider, c.tenant_id, c.azure_credential_id,
        cl.name as client_name
      FROM v_b_clients_c_campaign c
      LEFT JOIN v_b_clients cl ON c.client_id::text = cl.id::text
    `;
    const conditions = [];
    const params = [];
    let paramIndex = 1;
    if (status) {
      conditions.push(`c.status = $${paramIndex++}`);
      params.push(status);
    }
    if (type) {
      conditions.push(`c.type = $${paramIndex++}`);
      params.push(type);
    }
    if (client_id) {
      conditions.push(`c.client_id = $${paramIndex++}`);
      params.push(client_id);
    }
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ` ORDER BY c.created_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    if (error.code === '42P01') {
      return res.json([]);
    }
    res.status(500).json({
      error: 'Error retrieving campaigns',
      details: error.message,
      code: error.code
    });
  }
});
router.get('/:id/campaigns', requirePermission('cybersecurite.view'), async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const {
      status,
      type
    } = req.query;
    let query = `
      SELECT
        c.*,
        cl.name as client_name
      FROM v_b_clients_c_campaign c
      LEFT JOIN v_b_clients cl ON c.client_id::text = cl.id::text
      WHERE c.client_id = $1
    `;
    const params = [id];
    let paramIndex = 2;
    if (status) {
      query += ` AND c.status = $${paramIndex++}`;
      params.push(status);
    }
    if (type) {
      query += ` AND c.type = $${paramIndex++}`;
      params.push(type);
    }
    query += ` ORDER BY c.created_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({
      error: 'Error retrieving campaigns'
    });
  }
});
async function resolveMicrosoftCampaignAzureBinding(clientId, {
  provider,
  tenant_id,
  azure_credential_id
} = {}) {
  const azureResult = await pool.query(`SELECT id, client_id, tenant_id FROM v_b_clients_azure WHERE client_id = $1`, [clientId]);
  if (azureResult.rows.length === 0) {
    return {
      status: 400,
      error: 'Azure configuration required for this client. Configure Office 365 credentials before creating a Microsoft Security campaign.'
    };
  }
  const resolvedProvider = provider || 'microsoft';
  if (resolvedProvider !== 'microsoft') {
    return {
      status: 400,
      error: 'coming soon'
    };
  }
  let resolvedTenantId = tenant_id != null && String(tenant_id).trim() !== '' ? String(tenant_id).trim() : null;
  let resolvedAzureCredentialId = azure_credential_id != null && String(azure_credential_id).trim() !== '' ? azure_credential_id : null;
  if (resolvedAzureCredentialId != null) {
    const credCheck = await pool.query(`SELECT id, tenant_id FROM v_b_clients_azure WHERE id = $1 AND client_id = $2`, [resolvedAzureCredentialId, clientId]);
    if (credCheck.rows.length === 0) {
      return {
        status: 400,
        error: 'Invalid azure_credential_id for this client'
      };
    }
    const cred = credCheck.rows[0];
    if (resolvedTenantId != null && String(resolvedTenantId) !== String(cred.tenant_id)) {
      return {
        status: 400,
        error: "tenant_id does not match the Azure credential"
      };
    }
    resolvedTenantId = resolvedTenantId ?? cred.tenant_id;
    resolvedAzureCredentialId = cred.id;
  } else if (resolvedTenantId != null) {
    const match = azureResult.rows.find(r => String(r.tenant_id) === String(resolvedTenantId));
    if (!match) {
      return {
        status: 400,
        error: 'tenant_id does not match any Azure credential for this client'
      };
    }
    resolvedAzureCredentialId = match.id;
  } else {
    resolvedAzureCredentialId = azureResult.rows[0].id;
    resolvedTenantId = azureResult.rows[0].tenant_id;
  }
  return {
    provider: resolvedProvider,
    tenant_id: resolvedTenantId,
    azure_credential_id: resolvedAzureCredentialId
  };
}
router.post('/:id/campaigns', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const {
      name,
      type,
      status,
      start_date,
      end_date,
      global_progress,
      description,
      objectif_adoption,
      referent_id,
      glpi_ticket_id,
      provider,
      tenant_id,
      azure_credential_id
    } = req.body;
    if (!name || !type) {
      return res.status(400).json({
        error: 'Name and type are required'
      });
    }
    const isMicrosoftSecurity = type === 'microsoft_security' || type === 'microsoft';
    let resolvedProvider = provider ?? null;
    let resolvedTenantId = tenant_id ?? null;
    let resolvedAzureCredentialId = azure_credential_id ?? null;
    if (isMicrosoftSecurity) {
      const binding = await resolveMicrosoftCampaignAzureBinding(id, {
        provider,
        tenant_id,
        azure_credential_id
      });
      if (binding.error) {
        return res.status(binding.status || 400).json({
          error: binding.error
        });
      }
      resolvedProvider = binding.provider;
      resolvedTenantId = binding.tenant_id;
      resolvedAzureCredentialId = binding.azure_credential_id;
    } else if (provider != null && provider !== '' && provider !== 'microsoft') {
      return res.status(400).json({
        error: 'coming soon'
      });
    }
    const userId = req.user?.id || req.user?.user_id || null;
    let userName = req.user?.name || req.user?.username || req.user?.email || 'Unknown user';
    if (userId && userName === 'Unknown user') {
      try {
        const userResult = await pool.query(`SELECT username, email, name FROM v_b_users WHERE id::text = $1`, [userId]);
        if (userResult.rows.length > 0) {
          const user = userResult.rows[0];
          userName = user.name || user.username || user.email || 'Unknown user';
        }
      } catch (userError) {
        console.warn('Error fetching user name:', userError);
      }
    }
    const columns = ['client_id', 'name', 'type', 'status', 'start_date', 'end_date', 'global_progress', 'description', 'objectif_adoption', 'created_by', 'updated_by', 'provider', 'tenant_id', 'azure_credential_id'];
    const gp = normalizeNumericColumn(global_progress);
    const oa = normalizeNumericColumn(objectif_adoption);
    const values = [id, name, type, status || 'en_preparation', start_date, end_date, gp != null ? gp : 0, description, oa, userName, userName, resolvedProvider, resolvedTenantId, resolvedAzureCredentialId];
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const result = await pool.query(`INSERT INTO v_b_clients_c_campaign (${columns.join(', ')})
       VALUES (${placeholders})
       RETURNING id, ${columns.join(', ')}, created_at, updated_at`, values);
    const newCampaign = result.rows[0];
    if (!newCampaign || !newCampaign.id) {
      throw new Error('Unable to retrieve created campaign ID');
    }
    if (type === 'microsoft_security') {
      const defaultSteps = getDefaultMicrosoftSecuritySteps(req.body?.locale);
      try {
        for (const step of defaultSteps) {
          await pool.query(`INSERT INTO v_b_clients_c_campaign_steps 
             (campaign_id, name, order_index)
             VALUES ($1, $2, $3)`, [newCampaign.id, step.name, step.order_index]);
        }
      } catch (stepError) {
        console.error('Error creating default steps:', stepError);
      }
    }
    await dispatchNotificationEvent({
      source: "cyber",
      element: "campaign_updated",
      enterpriseId: String(id || ""),
      user: req.user,
      context: {
        campaign: newCampaign,
        entreprise: {
          id: String(id || "")
        }
      }
    }).catch(() => {});
    res.status(201).json(newCampaign);
  } catch (error) {
    console.error('Error creating campaign:', error);
    res.status(500).json({
      error: 'Error creating campaign',
      details: error.message
    });
  }
});
router.put('/:id/campaigns/:campaignId', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      id,
      campaignId
    } = req.params;
    const {
      name,
      type,
      status,
      start_date,
      end_date,
      global_progress,
      description,
      objectif_adoption,
      referent_id,
      glpi_ticket_id,
      provider,
      tenant_id,
      azure_credential_id
    } = req.body;
    const userId = req.user?.id || req.user?.user_id || null;
    let userName = req.user?.name || req.user?.username || req.user?.email || 'Unknown user';
    if (userId && userName === 'Unknown user') {
      try {
        const userResult = await pool.query(`SELECT username, email, name FROM v_b_users WHERE id::text = $1`, [userId]);
        if (userResult.rows.length > 0) {
          const user = userResult.rows[0];
          userName = user.name || user.username || user.email || 'Unknown user';
        }
      } catch (userError) {
        console.warn('Error fetching user name:', userError);
      }
    }
    const updates = [];
    const values = [];
    let paramIndex = 1;
    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (type !== undefined) {
      updates.push(`type = $${paramIndex++}`);
      values.push(type);
    }
    if (status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
    }
    if (start_date !== undefined) {
      updates.push(`start_date = $${paramIndex++}`);
      values.push(start_date);
    }
    if (end_date !== undefined) {
      updates.push(`end_date = $${paramIndex++}`);
      values.push(end_date);
    }
    if (global_progress !== undefined) {
      updates.push(`global_progress = $${paramIndex++}`);
      values.push(normalizeNumericColumn(global_progress) ?? 0);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (objectif_adoption !== undefined) {
      updates.push(`objectif_adoption = $${paramIndex++}`);
      values.push(normalizeNumericColumn(objectif_adoption));
    }
    const wantsAzureUpdate = provider !== undefined || tenant_id !== undefined || azure_credential_id !== undefined;
    if (wantsAzureUpdate) {
      if (provider !== undefined && provider != null && provider !== '' && provider !== 'microsoft') {
        return res.status(400).json({
          error: 'coming soon'
        });
      }
      if (azure_credential_id !== undefined && azure_credential_id != null && azure_credential_id !== '') {
        const credCheck = await pool.query(`SELECT id, tenant_id FROM v_b_clients_azure WHERE id = $1 AND client_id = $2`, [azure_credential_id, id]);
        if (credCheck.rows.length === 0) {
          return res.status(400).json({
            error: 'Invalid azure_credential_id for this client'
          });
        }
        if (tenant_id !== undefined && tenant_id != null && String(tenant_id).trim() !== '' && String(tenant_id) !== String(credCheck.rows[0].tenant_id)) {
          return res.status(400).json({
            error: "tenant_id does not match the Azure credential"
          });
        }
        updates.push(`azure_credential_id = $${paramIndex++}`);
        values.push(credCheck.rows[0].id);
        if (tenant_id !== undefined) {
          updates.push(`tenant_id = $${paramIndex++}`);
          values.push(tenant_id != null && String(tenant_id).trim() !== '' ? String(tenant_id).trim() : credCheck.rows[0].tenant_id);
        } else {
          updates.push(`tenant_id = $${paramIndex++}`);
          values.push(credCheck.rows[0].tenant_id);
        }
      } else {
        if (azure_credential_id !== undefined) {
          updates.push(`azure_credential_id = $${paramIndex++}`);
          values.push(null);
        }
        if (tenant_id !== undefined) {
          updates.push(`tenant_id = $${paramIndex++}`);
          values.push(tenant_id != null && String(tenant_id).trim() !== '' ? String(tenant_id).trim() : null);
        }
      }
      if (provider !== undefined) {
        updates.push(`provider = $${paramIndex++}`);
        values.push(provider === '' ? null : provider);
      }
    }
    updates.push(`updated_by = $${paramIndex++}`);
    values.push(userName);
    updates.push(`updated_at = NOW()`);
    if (updates.length === 2) {
      return res.status(400).json({
        error: 'No data to update'
      });
    }
    values.push(campaignId, id);
    const result = await pool.query(`UPDATE v_b_clients_c_campaign
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex} AND client_id = $${paramIndex + 1}
       RETURNING *`, values);
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Campaign not found'
      });
    }
    await dispatchNotificationEvent({
      source: "cyber",
      element: "campaign_updated",
      enterpriseId: String(id || ""),
      user: req.user,
      context: {
        campaign: result.rows[0],
        entreprise: {
          id: String(id || "")
        }
      }
    }).catch(() => {});
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating campaign:', error);
    res.status(500).json({
      error: 'Error updating campaign'
    });
  }
});
router.delete('/campaigns/:campaignId', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      campaignId
    } = req.params;
    const campaignResult = await pool.query(`SELECT * FROM v_b_clients_c_campaign WHERE id = $1`, [campaignId]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Campaign not found'
      });
    }
    const campaign = campaignResult.rows[0];
    const clientId = campaign.client_id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mfaDeleteResult = await client.query(`DELETE FROM v_b_clients_c_azure_mfa WHERE client_id = $1`, [clientId]);
      const statsDeleteResult = await client.query(`DELETE FROM v_b_clients_c_azure_stats WHERE client_id = $1`, [clientId]);
      const snapshotsDeleteResult = await client.query(`DELETE FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1`, [campaignId]);
      const stepsDeleteResult = await client.query(`DELETE FROM v_b_clients_c_campaign_steps WHERE campaign_id = $1`, [campaignId]);
      const campaignDeleteResult = await client.query(`DELETE FROM v_b_clients_c_campaign WHERE id = $1 RETURNING *`, [campaignId]);
      await client.query('COMMIT');
      res.json({
        success: true,
        deleted: {
          campaign: campaignDeleteResult.rows[0],
          deletedCounts: {
            mfa: mfaDeleteResult.rowCount,
            stats: statsDeleteResult.rowCount,
            snapshots: snapshotsDeleteResult.rowCount,
            steps: stepsDeleteResult.rowCount
          }
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({
      error: 'Error deleting campaign',
      details: error.message
    });
  }
});
router.delete('/:id/campaigns/:campaignId', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      id,
      campaignId
    } = req.params;
    const campaignResult = await pool.query(`SELECT * FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`, [campaignId, id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Campaign not found'
      });
    }
    const campaign = campaignResult.rows[0];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mfaDeleteResult = await client.query(`DELETE FROM v_b_clients_c_azure_mfa WHERE client_id = $1`, [id]);
      const statsDeleteResult = await client.query(`DELETE FROM v_b_clients_c_azure_stats WHERE client_id = $1`, [id]);
      const snapshotsDeleteResult = await client.query(`DELETE FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1`, [campaignId]);
      const stepsDeleteResult = await client.query(`DELETE FROM v_b_clients_c_campaign_steps WHERE campaign_id = $1`, [campaignId]);
      const campaignDeleteResult = await client.query(`DELETE FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2 RETURNING *`, [campaignId, id]);
      await client.query('COMMIT');
      res.json({
        success: true,
        deleted: {
          campaign: campaignDeleteResult.rows[0],
          deletedCounts: {
            mfa: mfaDeleteResult.rowCount,
            stats: statsDeleteResult.rowCount,
            snapshots: snapshotsDeleteResult.rowCount,
            steps: stepsDeleteResult.rowCount
          }
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({
      error: 'Error deleting campaign',
      details: error.message
    });
  }
});
router.post('/:id/campaigns/:campaignId/launch', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      id,
      campaignId
    } = req.params;
    const campaignResult = await pool.query(`SELECT id, type, status FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`, [campaignId, id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Campaign not found'
      });
    }
    const campaign = campaignResult.rows[0];
    if (campaign.type !== 'microsoft_security') {
      return res.status(400).json({
        error: 'This feature is only available for microsoft_security campaigns'
      });
    }
    if (campaign.status !== 'en_preparation') {
      return res.status(400).json({
        error: campaign.status === 'suspendue' ? 'Campaign paused. Use « Resume » to reactivate it.' : campaign.status === 'inactive' ? 'Campaign completed. Reset it before restarting.' : 'Campaign must be in preparation to be launched.'
      });
    }
    const existingEnd = await pool.query(`SELECT id FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'end' LIMIT 1`, [campaignId]);
    if (existingEnd.rows.length > 0) {
      return res.status(400).json({
        error: 'An end snapshot already exists. Reset the campaign before restarting.'
      });
    }
    const existingSnapshot = await pool.query(`SELECT id FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'start'`, [campaignId]);
    let snapshot = null;
    if (existingSnapshot.rows.length === 0) {
      const stats = await getClientMfaStatsFromDb(id);
      if (!stats) {
        return res.status(400).json({
          error: 'No synchronization data. Synchronize Microsoft data (Sync button) before launching the campaign.'
        });
      }
      if (!stats.lastSync) {
        return res.status(400).json({
          error: 'No synchronization date. Synchronize Microsoft data before launching the campaign.'
        });
      }
      const lastSyncAge = Date.now() - new Date(stats.lastSync).getTime();
      if (lastSyncAge > RECENT_SYNC_MAX_AGE_MS) {
        return res.status(400).json({
          error: 'Last synchronization is too old. Perform a recent sync (less than 24h) before launching the campaign.'
        });
      }
      const snapshotData = {
        source: 'db',
        lastSync: stats.lastSync,
        adminCount: stats.adminCount,
        nonAdminCount: stats.nonAdminCount,
        userCount: stats.userCount,
        mfaPercentage: stats.mfaPercentage,
        adminMfaPercentage: stats.adminMfaPercentage,
        nonAdminMfaPercentage: stats.nonAdminMfaPercentage,
        userMfaPercentage: stats.userMfaPercentage,
        mfaEnabledCount: stats.mfaEnabledCount,
        mfaDisabledCount: stats.mfaDisabledCount
      };
      const snapshotResult = await pool.query(`INSERT INTO v_b_clients_c_campaign_snapshot 
         (campaign_id, snapshot_type, admin_count, user_count, mfa_percentage, admin_mfa_percentage, user_mfa_percentage, mfa_enabled_count, mfa_disabled_count, snapshot_data)
         VALUES ($1, 'start', $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`, [campaignId, stats.adminCount, stats.userCount, stats.mfaPercentage, stats.adminMfaPercentage, stats.userMfaPercentage, stats.mfaEnabledCount, stats.mfaDisabledCount, JSON.stringify(snapshotData)]);
      snapshot = snapshotResult.rows[0];
    } else {
      const snapshotResult = await pool.query(`SELECT * FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'start' LIMIT 1`, [campaignId]);
      snapshot = snapshotResult.rows[0];
    }
    await pool.query(`UPDATE v_b_clients_c_campaign SET status = 'active', updated_at = NOW() WHERE id = $1`, [campaignId]);
    res.json({
      success: true,
      snapshot: snapshot,
      message: existingSnapshot.rows.length > 0 ? 'Campaign status updated successfully' : 'Campaign launched successfully'
    });
  } catch (error) {
    console.error('Error launching campaign:', error);
    res.status(500).json({
      error: 'Error launching campaign',
      details: error.message
    });
  }
});
router.post('/:id/campaigns/:campaignId/pause', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      id,
      campaignId
    } = req.params;
    const campaignResult = await pool.query(`SELECT id, type, status FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`, [campaignId, id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Campaign not found'
      });
    }
    const campaign = campaignResult.rows[0];
    if (campaign.status !== 'active') {
      return res.status(400).json({
        error: 'Only an active campaign can be paused'
      });
    }
    await pool.query(`UPDATE v_b_clients_c_campaign SET status = 'suspendue', updated_at = NOW() WHERE id = $1`, [campaignId]);
    res.json({
      success: true,
      status: 'suspendue',
      message: 'Campagne mise en pause'
    });
  } catch (error) {
    console.error('Error pausing campaign:', error);
    res.status(500).json({
      error: 'Error pausing',
      details: error.message
    });
  }
});
router.post('/:id/campaigns/:campaignId/resume', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      id,
      campaignId
    } = req.params;
    const campaignResult = await pool.query(`SELECT id, type, status FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`, [campaignId, id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Campaign not found'
      });
    }
    const campaign = campaignResult.rows[0];
    if (campaign.status !== 'suspendue') {
      return res.status(400).json({
        error: 'Only a paused campaign can be resumed'
      });
    }
    const endSnap = await pool.query(`SELECT id FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'end' LIMIT 1`, [campaignId]);
    if (endSnap.rows.length > 0) {
      return res.status(400).json({
        error: 'An end snapshot exists. Reset the campaign before restarting.'
      });
    }
    await pool.query(`UPDATE v_b_clients_c_campaign SET status = 'active', updated_at = NOW() WHERE id = $1`, [campaignId]);
    res.json({
      success: true,
      status: 'active',
      message: 'Campagne reprise'
    });
  } catch (error) {
    console.error('Error resuming campaign:', error);
    res.status(500).json({
      error: 'Error resuming',
      details: error.message
    });
  }
});
router.post('/:id/campaigns/:campaignId/finish', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      id,
      campaignId
    } = req.params;
    const campaignResult = await pool.query(`SELECT id, type, status FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`, [campaignId, id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Campaign not found'
      });
    }
    const campaign = campaignResult.rows[0];
    if (campaign.type !== 'microsoft_security') {
      return res.status(400).json({
        error: 'This feature is only available for microsoft_security campaigns'
      });
    }
    if (campaign.status !== 'active' && campaign.status !== 'suspendue') {
      return res.status(400).json({
        error: 'Campaign must be active or paused to be completed'
      });
    }
    const startSnapshotResult = await pool.query(`SELECT * FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'start'`, [campaignId]);
    if (startSnapshotResult.rows.length === 0) {
      return res.status(400).json({
        error: 'No start snapshot found. Please launch the campaign first.'
      });
    }
    const existingEndSnapshot = await pool.query(`SELECT id FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'end'`, [campaignId]);
    if (existingEndSnapshot.rows.length > 0) {
      return res.status(400).json({
        error: 'An end snapshot already exists for this campaign'
      });
    }
    const stats = await getClientMfaStatsFromDb(id);
    if (!stats) {
      return res.status(400).json({
        error: 'No synchronization data. Synchronize Microsoft data (Sync button) before completing the campaign.'
      });
    }
    const snapshotData = {
      source: 'db',
      lastSync: stats.lastSync,
      adminCount: stats.adminCount,
      nonAdminCount: stats.nonAdminCount,
      userCount: stats.userCount,
      mfaPercentage: stats.mfaPercentage,
      adminMfaPercentage: stats.adminMfaPercentage,
      nonAdminMfaPercentage: stats.nonAdminMfaPercentage,
      userMfaPercentage: stats.userMfaPercentage,
      mfaEnabledCount: stats.mfaEnabledCount,
      mfaDisabledCount: stats.mfaDisabledCount
    };
    const endSnapshotResult = await pool.query(`INSERT INTO v_b_clients_c_campaign_snapshot 
       (campaign_id, snapshot_type, admin_count, user_count, mfa_percentage, admin_mfa_percentage, user_mfa_percentage, mfa_enabled_count, mfa_disabled_count, snapshot_data)
       VALUES ($1, 'end', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`, [campaignId, stats.adminCount, stats.userCount, stats.mfaPercentage, stats.adminMfaPercentage, stats.userMfaPercentage, stats.mfaEnabledCount, stats.mfaDisabledCount, JSON.stringify(snapshotData)]);
    const startSnapshot = startSnapshotResult.rows[0];
    const endSnapshot = endSnapshotResult.rows[0];
    const comparison = buildSnapshotComparison(startSnapshot, endSnapshot);
    const fullCampaignResult = await pool.query(`SELECT c.*, cl.name as client_name 
       FROM v_b_clients_c_campaign c
       LEFT JOIN v_b_clients cl ON c.client_id::text = cl.id::text
       WHERE c.id = $1`, [campaignId]);
    const fullCampaign = fullCampaignResult.rows[0];
    const pdfPath = path.join(CAMPAIGN_REPORTS_DIR, `campaign_${campaignId}_report.pdf`);
    try {
      await generateCampaignReportPDF(fullCampaign, startSnapshot, endSnapshot, comparison, pdfPath);
    } catch (pdfError) {
      console.error('Error generating PDF:', pdfError);
    }
    await pool.query(`UPDATE v_b_clients_c_campaign SET status = 'inactive', updated_at = NOW() WHERE id = $1`, [campaignId]);
    const pdfUrl = `/api/clients/${id}/campaigns/${campaignId}/report.pdf`;
    res.json({
      success: true,
      snapshot: endSnapshotResult.rows[0],
      comparison: comparison,
      pdfUrl: pdfUrl,
      message: 'Campaign completed successfully'
    });
  } catch (error) {
    console.error('Error finishing campaign:', error);
    res.status(500).json({
      error: 'Error completing campaign',
      details: error.message
    });
  }
});
router.post('/:id/campaigns/:campaignId/reset', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      id,
      campaignId
    } = req.params;
    const campaignResult = await pool.query(`SELECT id, type, status FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`, [campaignId, id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Campaign not found'
      });
    }
    await pool.query(`DELETE FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1`, [campaignId]);
    await pool.query(`UPDATE v_b_clients_c_campaign SET status = 'en_preparation', updated_at = NOW() WHERE id = $1`, [campaignId]);
    res.json({
      success: true,
      message: 'Campaign reset. You can launch it again.'
    });
  } catch (error) {
    console.error('Error resetting campaign:', error);
    res.status(500).json({
      error: 'Error resetting campaign',
      details: error.message
    });
  }
});
router.get('/:id/campaigns/:campaignId/stats', requirePermission('cybersecurite.view'), async (req, res) => {
  try {
    const {
      id,
      campaignId
    } = req.params;
    const campaignResult = await pool.query(`SELECT id, type, status FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`, [campaignId, id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Campaign not found'
      });
    }
    const campaign = campaignResult.rows[0];
    let lastSync = null;
    if (campaign.type === 'microsoft_security') {
      try {
        const r = await pool.query(`SELECT MAX(last_sync) as last_sync FROM v_b_clients_c_azure_mfa WHERE client_id = $1`, [id]);
        lastSync = r.rows[0]?.last_sync ?? null;
      } catch (_) {}
    }
    const snapshotsResult = await pool.query(`SELECT * FROM v_b_clients_c_campaign_snapshot 
       WHERE campaign_id = $1 
       ORDER BY snapshot_type, created_at DESC 
       LIMIT 2`, [campaignId]);
    const snapshots = snapshotsResult.rows;
    const startSnapshot = snapshots.find(s => s.snapshot_type === 'start');
    const endSnapshot = snapshots.find(s => s.snapshot_type === 'end');
    if (!startSnapshot && !endSnapshot) {
      const includeCurrent = req.query.includeCurrent === 'true';
      if (includeCurrent && campaign.type === 'microsoft_security') {
        const stats = await getClientMfaStatsFromDb(id);
        if (stats) {
          return res.json({
            current: {
              adminCount: stats.adminCount,
              userCount: stats.userCount,
              adminMfaCount: Math.round(stats.adminCount * stats.adminMfaPercentage / 100),
              userMfaCount: stats.mfaEnabledCount,
              adminMfaPercentage: stats.adminMfaPercentage,
              userMfaPercentage: stats.userMfaPercentage,
              regularUserCount: stats.userCount - stats.adminCount,
              regularUserMfaCount: stats.mfaEnabledCount - Math.round(stats.adminCount * stats.adminMfaPercentage / 100)
            },
            lastSync: stats.lastSync,
            hasSnapshots: false
          });
        }
      }
      return res.json({
        current: null,
        lastSync: lastSync ?? undefined,
        hasSnapshots: false
      });
    }
    const parseSnapshotExtra = snap => {
      let nonAdminCount = (snap.user_count || 0) - (snap.admin_count || 0);
      let nonAdminMfaPercentage = null;
      try {
        const data = typeof snap.snapshot_data === 'string' ? JSON.parse(snap.snapshot_data) : snap.snapshot_data;
        if (data) {
          if (data.nonAdminCount != null) nonAdminCount = data.nonAdminCount;
          if (data.nonAdminMfaPercentage != null) nonAdminMfaPercentage = parseFloat(data.nonAdminMfaPercentage);
        }
      } catch (_) {}
      if (nonAdminMfaPercentage == null && nonAdminCount > 0 && snap.user_count > 0) {
        const totalMfa = parseFloat(snap.user_mfa_percentage || snap.mfa_percentage || 0) / 100 * snap.user_count;
        const adminMfa = parseFloat(snap.admin_mfa_percentage || snap.mfa_percentage || 0) / 100 * (snap.admin_count || 0);
        nonAdminMfaPercentage = Math.round((totalMfa - adminMfa) / nonAdminCount * 10000) / 100;
      }
      return {
        nonAdminCount,
        nonAdminMfaPercentage: nonAdminMfaPercentage ?? 0
      };
    };
    if (startSnapshot && endSnapshot) {
      const startExtra = parseSnapshotExtra(startSnapshot);
      const endExtra = parseSnapshotExtra(endSnapshot);
      const startAdminMfa = parseFloat(startSnapshot.admin_mfa_percentage || startSnapshot.mfa_percentage || 0);
      const endAdminMfa = parseFloat(endSnapshot.admin_mfa_percentage || endSnapshot.mfa_percentage || 0);
      const startUserMfa = parseFloat(startSnapshot.user_mfa_percentage || startSnapshot.mfa_percentage || 0);
      const endUserMfa = parseFloat(endSnapshot.user_mfa_percentage || endSnapshot.mfa_percentage || 0);
      const startNonAdminMfa = parseFloat(startExtra.nonAdminMfaPercentage ?? startUserMfa);
      const endNonAdminMfa = parseFloat(endExtra.nonAdminMfaPercentage ?? endUserMfa);
      const comparison = {
        adminCount: {
          start: startSnapshot.admin_count,
          end: endSnapshot.admin_count,
          change: endSnapshot.admin_count - startSnapshot.admin_count
        },
        userCount: {
          start: startSnapshot.user_count,
          end: endSnapshot.user_count,
          change: endSnapshot.user_count - startSnapshot.user_count
        },
        adminMfaPercentage: {
          start: startAdminMfa,
          end: endAdminMfa,
          change: endAdminMfa - startAdminMfa
        },
        nonAdminMfaPercentage: {
          start: startNonAdminMfa,
          end: endNonAdminMfa,
          change: endNonAdminMfa - startNonAdminMfa
        },
        userMfaPercentage: {
          start: startUserMfa,
          end: endUserMfa,
          change: endUserMfa - startUserMfa
        },
        mfaPercentage: {
          start: parseFloat(startSnapshot.mfa_percentage || 0),
          end: parseFloat(endSnapshot.mfa_percentage || 0),
          change: parseFloat(endSnapshot.mfa_percentage || 0) - parseFloat(startSnapshot.mfa_percentage || 0)
        },
        mfaEnabledCount: {
          start: startSnapshot.mfa_enabled_count,
          end: endSnapshot.mfa_enabled_count,
          change: endSnapshot.mfa_enabled_count - startSnapshot.mfa_enabled_count
        }
      };
      return res.json({
        start: {
          adminCount: startSnapshot.admin_count,
          nonAdminCount: startExtra.nonAdminCount,
          userCount: startSnapshot.user_count,
          adminMfaPercentage: parseFloat(startSnapshot.admin_mfa_percentage || startSnapshot.mfa_percentage || 0),
          nonAdminMfaPercentage: startExtra.nonAdminMfaPercentage,
          userMfaPercentage: parseFloat(startSnapshot.user_mfa_percentage || startSnapshot.mfa_percentage || 0),
          mfaPercentage: parseFloat(startSnapshot.mfa_percentage || 0),
          mfaEnabledCount: startSnapshot.mfa_enabled_count,
          mfaDisabledCount: startSnapshot.mfa_disabled_count,
          createdAt: startSnapshot.created_at
        },
        end: {
          adminCount: endSnapshot.admin_count,
          nonAdminCount: endExtra.nonAdminCount,
          userCount: endSnapshot.user_count,
          adminMfaPercentage: parseFloat(endSnapshot.admin_mfa_percentage || endSnapshot.mfa_percentage || 0),
          nonAdminMfaPercentage: endExtra.nonAdminMfaPercentage,
          userMfaPercentage: parseFloat(endSnapshot.user_mfa_percentage || endSnapshot.mfa_percentage || 0),
          mfaPercentage: parseFloat(endSnapshot.mfa_percentage || 0),
          mfaEnabledCount: endSnapshot.mfa_enabled_count,
          mfaDisabledCount: endSnapshot.mfa_disabled_count,
          createdAt: endSnapshot.created_at
        },
        comparison: comparison,
        lastSync: lastSync ?? undefined,
        hasSnapshots: true
      });
    }
    if (startSnapshot) {
      const startExtra = parseSnapshotExtra(startSnapshot);
      return res.json({
        start: {
          adminCount: startSnapshot.admin_count,
          nonAdminCount: startExtra.nonAdminCount,
          userCount: startSnapshot.user_count,
          adminMfaPercentage: parseFloat(startSnapshot.admin_mfa_percentage || startSnapshot.mfa_percentage || 0),
          nonAdminMfaPercentage: startExtra.nonAdminMfaPercentage,
          userMfaPercentage: parseFloat(startSnapshot.user_mfa_percentage || startSnapshot.mfa_percentage || 0),
          mfaPercentage: parseFloat(startSnapshot.mfa_percentage || 0),
          mfaEnabledCount: startSnapshot.mfa_enabled_count,
          mfaDisabledCount: startSnapshot.mfa_disabled_count,
          createdAt: startSnapshot.created_at
        },
        end: null,
        comparison: null,
        lastSync: lastSync ?? undefined,
        hasSnapshots: true
      });
    }
    res.json({
      start: null,
      end: null,
      comparison: null,
      lastSync: lastSync ?? undefined,
      hasSnapshots: false
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({
      error: 'Error retrieving statistics',
      details: error.message
    });
  }
});
router.get('/:id/campaigns/:campaignId/report.pdf', requirePermission('cybersecurite.view'), async (req, res) => {
  try {
    const {
      id,
      campaignId
    } = req.params;
    let pdfPath = path.join(CAMPAIGN_REPORTS_DIR, `campaign_${campaignId}_report.pdf`);
    if (!fs.existsSync(pdfPath)) {
      try {
        pdfPath = await ensureCampaignReportPdf(id, campaignId);
      } catch (regenError) {
        console.error('Error regenerating campaign PDF:', regenError);
        pdfPath = null;
      }
    }
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      return res.status(404).json({
        error: 'PDF report not found'
      });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rapport_campagne_${campaignId}.pdf"`);
    const fileStream = fs.createReadStream(pdfPath);
    fileStream.pipe(res);
  } catch (error) {
    console.error('Error downloading PDF:', error);
    res.status(500).json({
      error: 'Error downloading PDF',
      details: error.message
    });
  }
});
router.post('/:id/campaigns/:campaignId/publish-report', requirePermission('documents.create'), async (req, res) => {
  try {
    const {
      id,
      campaignId
    } = req.params;
    const {
      visibleToClient,
      description = ''
    } = req.body || {};
    const campaignResult = await pool.query(`SELECT c.id, c.name, c.type, c.status, c.client_id, cl.name as client_name
       FROM v_b_clients_c_campaign c
       LEFT JOIN v_b_clients cl ON c.client_id::text = cl.id::text
       WHERE c.id = $1 AND c.client_id::text = $2::text`, [campaignId, id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Campaign not found'
      });
    }
    const campaign = campaignResult.rows[0];
    if (campaign.type !== 'microsoft_security') {
      return res.status(400).json({
        error: 'Report available only for Microsoft Security campaigns'
      });
    }
    if (campaign.status !== 'inactive') {
      return res.status(400).json({
        error: 'Campaign must be completed to publish the report'
      });
    }
    let pdfPath;
    try {
      pdfPath = await ensureCampaignReportPdf(id, campaignId);
    } catch (pdfError) {
      console.error('Error ensuring campaign PDF for publish:', pdfError);
      return res.status(500).json({
        error: 'Unable to generate PDF report'
      });
    }
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      return res.status(404).json({
        error: 'PDF report not found. Complete the campaign with start/end snapshots.'
      });
    }
    await ensureVisibleToClientColumn();
    const hasVisibility = await hasVisibleToClientColumn();
    const shareWithClient = hasVisibility ? parseVisibleToClient(visibleToClient) : false;
    const safeCampaignName = String(campaign.name || `campagne_${campaignId}`).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    const originalName = `Rapport_campagne_${safeCampaignName}.pdf`;
    const storedName = `${Date.now()}_${originalName}`;
    const destPath = path.join(CLIENT_FILES_DIR, storedName);
    fs.copyFileSync(pdfPath, destPath);
    const stats = fs.statSync(destPath);
    const columns = ['client_id', 'client_name', 'file_name', 'file_path', 'mime_type', 'size_bytes', 'category', 'description', 'uploaded_by'];
    const values = [Number(id), campaign.client_name || null, originalName, storedName, 'application/pdf', stats.size, 'Rapport', description || `Campaign PDF report « ${campaign.name || campaignId} »`, resolveFileUploadedBy(req.user)];
    if (hasVisibility) {
      columns.push('visible_to_client');
      values.push(shareWithClient);
    }
    const placeholders = values.map((_, index) => `$${index + 1}`);
    const returningVisibility = hasVisibility ? ', visible_to_client' : ', FALSE AS visible_to_client';
    const insertResult = await pool.query(`INSERT INTO v_b_client_files (${columns.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING id, client_id, client_name, file_name, mime_type, size_bytes, category, description, created_at${returningVisibility}`, values);
    res.status(201).json({
      success: true,
      file: insertResult.rows[0],
      visibleToClient: shareWithClient,
      message: shareWithClient ? 'Report published in documents (visible on client portal)' : 'Report published in documents (internal agents)'
    });
  } catch (error) {
    console.error('Error publishing campaign report:', error);
    res.status(500).json({
      error: 'Error publishing report',
      details: error.message
    });
  }
});
router.get('/:id/campaigns/:campaignId/steps', requirePermission('cybersecurite.view'), async (req, res) => {
  try {
    const {
      campaignId
    } = req.params;
    const result = await pool.query(`SELECT s.*, u.username, u.email
       FROM v_b_clients_c_campaign_steps s
       LEFT JOIN v_b_users u ON s.assigned_user_id::text = u.id::text
       WHERE s.campaign_id = $1
       ORDER BY s.order_index ASC, s.created_at ASC`, [campaignId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching steps:', error);
    res.status(500).json({
      error: 'Error retrieving steps',
      details: error.message
    });
  }
});
router.post('/:id/campaigns/:campaignId/steps', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      campaignId
    } = req.params;
    const {
      name,
      assigned_user_id,
      due_date,
      duration_hours,
      order_index
    } = req.body;
    if (!name) {
      return res.status(400).json({
        error: 'Step name is required'
      });
    }
    let finalOrderIndex = order_index;
    if (finalOrderIndex === undefined || finalOrderIndex === null) {
      const maxOrderResult = await pool.query(`SELECT COALESCE(MAX(order_index), 0) as max_order FROM v_b_clients_c_campaign_steps WHERE campaign_id = $1`, [campaignId]);
      finalOrderIndex = (maxOrderResult.rows[0]?.max_order || 0) + 1;
    }
    const result = await pool.query(`INSERT INTO v_b_clients_c_campaign_steps 
       (campaign_id, name, assigned_user_id, due_date, duration_hours, order_index)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`, [campaignId, name, assigned_user_id || null, due_date || null, duration_hours || null, finalOrderIndex]);
    if (result.rows[0].assigned_user_id) {
      const userResult = await pool.query(`SELECT username, email FROM v_b_users WHERE id = $1`, [result.rows[0].assigned_user_id]);
      result.rows[0].username = userResult.rows[0]?.username;
      result.rows[0].email = userResult.rows[0]?.email;
    }
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating step:', error);
    res.status(500).json({
      error: 'Error creating step',
      details: error.message
    });
  }
});
router.put('/:id/campaigns/:campaignId/steps/reorder', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      campaignId
    } = req.params;
    const {
      stepOrders
    } = req.body;
    if (!Array.isArray(stepOrders) || stepOrders.length === 0) {
      return res.status(400).json({
        error: 'stepOrders must be a non-empty array'
      });
    }
    for (const stepOrder of stepOrders) {
      if (!stepOrder.id || typeof stepOrder.order_index !== 'number') {
        return res.status(400).json({
          error: 'Each stepOrder must have an id and a numeric order_index',
          invalidStep: stepOrder
        });
      }
    }
    const campaignCheck = await pool.query('SELECT campaign_id FROM v_b_clients_c_campaign_steps WHERE campaign_id::text = $1 LIMIT 1', [campaignId]);
    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'No steps found for this campaign'
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let updateCount = 0;
      for (const {
        id,
        order_index
      } of stepOrders) {
        const checkResult = await client.query(`SELECT id FROM v_b_clients_c_campaign_steps
           WHERE id::text = $1::text AND campaign_id::text = $2::text`, [id, campaignId]);
        if (checkResult.rows.length === 0) continue;
        const result = await client.query(`UPDATE v_b_clients_c_campaign_steps
           SET order_index = $1
           WHERE id::text = $2::text AND campaign_id::text = $3::text`, [order_index, id, campaignId]);
        updateCount += result.rowCount;
      }
      if (updateCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'No data to update'
        });
      }
      await client.query('COMMIT');
      const result = await pool.query(`SELECT s.*, u.username, u.email
         FROM v_b_clients_c_campaign_steps s
         LEFT JOIN v_b_users u ON s.assigned_user_id::text = u.id::text
         WHERE s.campaign_id = $1
         ORDER BY s.order_index ASC, s.created_at ASC`, [campaignId]);
      res.json(result.rows);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error reordering steps:', error);
    res.status(500).json({
      error: 'Error reordering steps',
      details: error.message
    });
  }
});
router.put('/:id/campaigns/:campaignId/steps/:stepId', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      stepId
    } = req.params;
    const {
      name,
      assigned_user_id,
      due_date,
      duration_hours,
      completed,
      order_index
    } = req.body;
    const updates = [];
    const values = [];
    let paramIndex = 1;
    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (assigned_user_id !== undefined) {
      updates.push(`assigned_user_id = $${paramIndex++}`);
      values.push(assigned_user_id || null);
    }
    if (due_date !== undefined) {
      updates.push(`due_date = $${paramIndex++}`);
      values.push(due_date || null);
    }
    if (duration_hours !== undefined) {
      updates.push(`duration_hours = $${paramIndex++}`);
      values.push(duration_hours || null);
    }
    if (completed !== undefined) {
      updates.push(`completed = $${paramIndex++}`);
      values.push(completed);
    }
    if (order_index !== undefined) {
      updates.push(`order_index = $${paramIndex++}`);
      values.push(order_index);
    }
    if (updates.length === 0) {
      return res.status(400).json({
        error: 'No data to update'
      });
    }
    updates.push(`updated_at = NOW()`);
    values.push(stepId);
    const result = await pool.query(`UPDATE v_b_clients_c_campaign_steps 
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`, values);
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Step not found'
      });
    }
    if (result.rows[0].assigned_user_id) {
      const userResult = await pool.query(`SELECT username, email FROM v_b_users WHERE id = $1`, [result.rows[0].assigned_user_id]);
      result.rows[0].username = userResult.rows[0]?.username;
      result.rows[0].email = userResult.rows[0]?.email;
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating step:', error);
    res.status(500).json({
      error: 'Error updating step',
      details: error.message
    });
  }
});
router.delete('/:id/campaigns/:campaignId/steps/:stepId', requirePermission('cybersecurite.edit'), async (req, res) => {
  try {
    const {
      stepId
    } = req.params;
    const result = await pool.query(`DELETE FROM v_b_clients_c_campaign_steps WHERE id = $1 RETURNING id`, [stepId]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Step not found'
      });
    }
    res.json({
      success: true,
      message: 'Step deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting step:', error);
    res.status(500).json({
      error: 'Error deleting step',
      details: error.message
    });
  }
});
export default router;
