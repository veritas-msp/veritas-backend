import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import fetch from 'node-fetch';
import {
  resolveBitdefenderCredentials,
  getGlobalBitdefenderConfigStatus,
} from '../../utils/bitdefenderCredentials.js';

const router = express.Router();
router.use(verifyJWT);

function createAuthHeader(apiKey) {
  const encoded = Buffer.from(`${apiKey}:`).toString('base64');
  return `Basic ${encoded}`;
}

async function testBitdefenderConnection(apiUrl, apiKey) {
  const url = `${apiUrl}/v1.0/jsonrpc/accounts`;
  const requestBody = {
    id: `test_${Date.now()}`,
    jsonrpc: '2.0',
    method: 'getAccountsList',
    params: {},
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: createAuthHeader(apiKey),
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || 'Erreur API Bitdefender');
  }

  let accounts = [];
  const result = data.result;
  if (Array.isArray(result)) {
    accounts = result;
  } else if (result?.items) {
    accounts = result.items;
  }

  return { accountsCount: accounts.length };
}

/**
 * GET /api/client-bitdefender/global-status
 */
router.get('/global-status', async (_req, res) => {
  try {
    const status = await getGlobalBitdefenderConfigStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/client-bitdefender/test-credentials
 */
router.post('/test-credentials', async (req, res) => {
  try {
    const { apiUrl, apiKey } = req.body;
    if (!apiUrl || !apiKey) {
      return res.status(400).json({
        success: false,
        error: 'URL API et clé API sont requises',
      });
    }
    const result = await testBitdefenderConnection(apiUrl.trim(), apiKey.trim());
    res.json({
      success: true,
      message: 'Connexion Bitdefender GravityZone réussie',
      ...result,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/client-bitdefender/:clientId
 * Liste les tenants dédiés d'un client
 */
router.get('/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const result = await pool.query(
      `SELECT id, client_id, label, solution, api_url, created_at, updated_at
       FROM v_b_clients_bitdefender
       WHERE client_id = $1
       ORDER BY created_at ASC`,
      [clientId]
    );

    res.json({
      success: true,
      tenants: result.rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        label: row.label,
        solution: row.solution,
        apiUrl: row.api_url,
        hasApiKey: true,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/client-bitdefender/:clientId/:tenantId
 */
router.get('/:clientId/:tenantId', async (req, res) => {
  try {
    const { clientId, tenantId } = req.params;
    const result = await pool.query(
      `SELECT id, client_id, label, solution, api_url, created_at, updated_at
       FROM v_b_clients_bitdefender
       WHERE id = $1 AND client_id = $2`,
      [tenantId, clientId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, tenant: null });
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
        hasApiKey: true,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/client-bitdefender/:clientId
 * Crée un tenant dédié
 */
router.post('/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { label, solution, apiUrl, apiKey } = req.body;

    if (!apiUrl || !apiKey) {
      return res.status(400).json({
        success: false,
        error: 'URL API et clé API sont requises',
      });
    }

    const clientCheck = await pool.query('SELECT id FROM v_b_clients WHERE id = $1', [clientId]);
    if (clientCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Client non trouvé' });
    }

    const encryptedData = encrypt(apiKey.trim());
    if (!encryptedData) {
      return res.status(500).json({ success: false, error: 'Erreur de chiffrement' });
    }

    const result = await pool.query(
      `INSERT INTO v_b_clients_bitdefender
       (client_id, label, solution, api_url, api_key_encrypted, iv, auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, client_id, label, solution, api_url, created_at, updated_at`,
      [
        clientId,
        label?.trim() || null,
        solution || 'GravityZone BitDefender',
        apiUrl.trim(),
        encryptedData.encrypted,
        encryptedData.iv,
        encryptedData.authTag,
      ]
    );

    const row = result.rows[0];
    res.json({
      success: true,
      tenant: {
        id: row.id,
        clientId: row.client_id,
        label: row.label,
        solution: row.solution,
        apiUrl: row.api_url,
        hasApiKey: true,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/client-bitdefender/:clientId/:tenantId
 */
router.put('/:clientId/:tenantId', async (req, res) => {
  try {
    const { clientId, tenantId } = req.params;
    const { label, solution, apiUrl, apiKey } = req.body;

    const existing = await pool.query(
      'SELECT id, api_key_encrypted, iv, auth_tag FROM v_b_clients_bitdefender WHERE id = $1 AND client_id = $2',
      [tenantId, clientId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tenant introuvable' });
    }

    let encryptedData;
    if (apiKey && apiKey.trim()) {
      encryptedData = encrypt(apiKey.trim());
      if (!encryptedData) {
        return res.status(500).json({ success: false, error: 'Erreur de chiffrement' });
      }
    } else {
      const row = existing.rows[0];
      encryptedData = {
        encrypted: row.api_key_encrypted,
        iv: row.iv,
        authTag: row.auth_tag,
      };
    }

    if (!apiUrl?.trim()) {
      return res.status(400).json({ success: false, error: 'URL API requise' });
    }

    const result = await pool.query(
      `UPDATE v_b_clients_bitdefender
       SET label = $1, solution = $2, api_url = $3,
           api_key_encrypted = $4, iv = $5, auth_tag = $6, updated_at = NOW()
       WHERE id = $7 AND client_id = $8
       RETURNING id, client_id, label, solution, api_url, created_at, updated_at`,
      [
        label?.trim() || null,
        solution || 'GravityZone BitDefender',
        apiUrl.trim(),
        encryptedData.encrypted,
        encryptedData.iv,
        encryptedData.authTag,
        tenantId,
        clientId,
      ]
    );

    const row = result.rows[0];
    res.json({
      success: true,
      tenant: {
        id: row.id,
        clientId: row.client_id,
        label: row.label,
        solution: row.solution,
        apiUrl: row.api_url,
        hasApiKey: true,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/client-bitdefender/:clientId/:tenantId
 */
router.delete('/:clientId/:tenantId', async (req, res) => {
  try {
    const { clientId, tenantId } = req.params;
    const result = await pool.query(
      'DELETE FROM v_b_clients_bitdefender WHERE id = $1 AND client_id = $2 RETURNING id',
      [tenantId, clientId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Tenant introuvable' });
    }

    res.json({ success: true, message: 'Tenant supprimé' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/client-bitdefender/:clientId/:tenantId/test
 */
router.post('/:clientId/:tenantId/test', async (req, res) => {
  try {
    const { clientId, tenantId } = req.params;
    const creds = await resolveBitdefenderCredentials({
      clientId,
      bitdefenderTenantId: tenantId,
    });
    const result = await testBitdefenderConnection(creds.apiUrl, creds.apiKey);
    res.json({
      success: true,
      message: 'Connexion Bitdefender réussie',
      ...result,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
