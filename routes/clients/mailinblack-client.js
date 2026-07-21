import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { resolveMailinblackCredentials, getGlobalMailinblackConfigStatus } from '../../utils/mailinblackCredentials.js';
import { mailinblackProtectCheck } from '../../utils/mailinblackApi.js';
const router = express.Router();
router.use(verifyJWT);
router.get('/global-status', async (_req, res) => {
  try {
    const status = await getGlobalMailinblackConfigStatus();
    res.json({
      success: true,
      ...status
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
router.post('/test-credentials', async (req, res) => {
  try {
    const {
      apiUrl,
      apiKey,
      authKey,
      authClientId
    } = req.body;
    const key = (authKey || apiKey || '').trim();
    if (!apiUrl || !key) {
      return res.status(400).json({
        success: false,
        error: 'API URL and API key are required'
      });
    }
    const credentials = {
      apiUrl: apiUrl.trim(),
      authKey: key,
      authClientId: (authClientId || '').trim() || null
    };
    const check = await mailinblackProtectCheck(credentials.apiUrl, credentials);
    res.json({
      success: true,
      message: 'Mailinblack Protect connection successful',
      authClientId: check.session?.clientId || credentials.authClientId || null
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: err.message || 'Connection test failed'
    });
  }
});
router.get('/:clientId', async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const result = await pool.query(`SELECT id, client_id, label, solution, api_url, auth_client_id, created_at, updated_at
       FROM v_b_clients_mailinblack
       WHERE client_id = $1
       ORDER BY created_at ASC`, [clientId]);
    res.json({
      success: true,
      tenants: result.rows.map(row => ({
        id: row.id,
        clientId: row.client_id,
        label: row.label,
        solution: row.solution,
        apiUrl: row.api_url,
        authClientId: row.auth_client_id || null,
        hasApiKey: true,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
router.get('/:clientId/:tenantId', async (req, res) => {
  try {
    const {
      clientId,
      tenantId
    } = req.params;
    const result = await pool.query(`SELECT id, client_id, label, solution, api_url, auth_client_id, created_at, updated_at
       FROM v_b_clients_mailinblack
       WHERE id = $1 AND client_id = $2`, [tenantId, clientId]);
    if (result.rows.length === 0) {
      return res.json({
        success: true,
        tenant: null
      });
    }
    const row = result.rows[0];
    res.json({
      success: true,
      tenant: {
        id: row.id,
        clientId: row.client_id,
        label: row.label,
        solution: row.solution,
        apiUrl: row.api_url,
        authClientId: row.auth_client_id || null,
        hasApiKey: true,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
router.post('/:clientId', async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const {
      label,
      apiUrl,
      apiKey,
      authKey,
      authClientId,
      solution
    } = req.body;
    const key = (authKey || apiKey || '').trim();
    if (!apiUrl?.trim() || !key) {
      return res.status(400).json({
        success: false,
        error: 'API URL and API key are required'
      });
    }
    const credentials = {
      apiUrl: apiUrl.trim(),
      authKey: key,
      authClientId: (authClientId || '').trim() || null
    };
    const check = await mailinblackProtectCheck(credentials.apiUrl, credentials);
    const resolvedClientId = check.session?.clientId || credentials.authClientId || null;
    const {
      encrypted,
      iv,
      authTag
    } = encrypt(key);
    const result = await pool.query(`INSERT INTO v_b_clients_mailinblack (client_id, label, solution, api_url, api_key_encrypted, iv, auth_tag, auth_client_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
       RETURNING id, client_id, label, solution, api_url, auth_client_id, created_at, updated_at`, [clientId, label || `Tenant Mailinblack ${clientId}`, solution || 'Mailinblack Protect', apiUrl.trim(), encrypted, iv, authTag, resolvedClientId]);
    const row = result.rows[0];
    res.json({
      success: true,
      tenant: {
        id: row.id,
        clientId: row.client_id,
        label: row.label,
        solution: row.solution,
        apiUrl: row.api_url,
        authClientId: row.auth_client_id || null,
        hasApiKey: true,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
router.put('/:clientId/:tenantId', async (req, res) => {
  try {
    const {
      clientId,
      tenantId
    } = req.params;
    const {
      label,
      apiUrl,
      apiKey,
      authKey,
      authClientId,
      solution
    } = req.body;
    const existing = await pool.query(`SELECT id FROM v_b_clients_mailinblack WHERE id = $1 AND client_id = $2`, [tenantId, clientId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Tenant not found'
      });
    }
    const fields = [];
    const values = [];
    let idx = 1;
    if (label != null) {
      fields.push(`label = $${idx++}`);
      values.push(label);
    }
    if (solution != null) {
      fields.push(`solution = $${idx++}`);
      values.push(solution);
    }
    if (apiUrl != null) {
      fields.push(`api_url = $${idx++}`);
      values.push(apiUrl.trim());
    }
    const incomingKey = (authKey || apiKey || '').trim();
    if (incomingKey) {
      const {
        encrypted,
        iv,
        authTag
      } = encrypt(incomingKey);
      fields.push(`api_key_encrypted = $${idx++}`);
      values.push(encrypted);
      fields.push(`iv = $${idx++}`);
      values.push(iv);
      fields.push(`auth_tag = $${idx++}`);
      values.push(authTag);
    }
    if (authClientId != null) {
      fields.push(`auth_client_id = $${idx++}`);
      values.push(authClientId.trim() || null);
    }
    if (fields.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No changes provided'
      });
    }
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(tenantId, clientId);
    const result = await pool.query(`UPDATE v_b_clients_mailinblack
       SET ${fields.join(', ')}
       WHERE id = $${idx++} AND client_id = $${idx}
       RETURNING id, client_id, label, solution, api_url, auth_client_id, created_at, updated_at`, values);
    const row = result.rows[0];
    res.json({
      success: true,
      tenant: {
        id: row.id,
        clientId: row.client_id,
        label: row.label,
        solution: row.solution,
        apiUrl: row.api_url,
        authClientId: row.auth_client_id || null,
        hasApiKey: true,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
router.delete('/:clientId/:tenantId', async (req, res) => {
  try {
    const {
      clientId,
      tenantId
    } = req.params;
    const result = await pool.query(`DELETE FROM v_b_clients_mailinblack WHERE id = $1 AND client_id = $2 RETURNING id`, [tenantId, clientId]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Tenant not found'
      });
    }
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
router.post('/:clientId/:tenantId/test', async (req, res) => {
  try {
    const {
      clientId,
      tenantId
    } = req.params;
    const creds = await resolveMailinblackCredentials({
      clientId,
      mailinblackTenantId: tenantId
    });
    await mailinblackProtectCheck(creds.apiUrl, creds);
    res.json({
      success: true,
      message: 'Mailinblack Protect connection successful'
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: err.message || 'Connection test failed'
    });
  }
});
export default router;
