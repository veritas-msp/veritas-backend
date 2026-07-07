import { pool } from '../database/db.js';
import { decrypt } from './encryption.js';
import { getSettingsMap } from './settingsHelper.js';

export async function resolveMailinblackCredentials({ clientId, mailinblackTenantId } = {}) {
  if (mailinblackTenantId) {
    const params = [mailinblackTenantId];
    let query = `
      SELECT id, client_id, api_url, api_key_encrypted, iv, auth_tag, auth_client_id
      FROM v_b_clients_mailinblack
      WHERE id = $1
    `;
    if (clientId) {
      query += ' AND client_id = $2';
      params.push(clientId);
    }
    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      throw new Error('Tenant Mailinblack dédié introuvable');
    }
    const row = result.rows[0];
    const authKey = decrypt(row.api_key_encrypted, row.iv, row.auth_tag);
    if (!authKey) {
      throw new Error('Impossible de déchiffrer la clé auth Mailinblack');
    }
    return {
      apiUrl: row.api_url,
      authKey,
      apiKey: authKey,
      authClientId: row.auth_client_id || null,
      source: 'dedicated',
      mailinblackTenantId: row.id,
      clientId: row.client_id,
    };
  }

  const settings = await getSettingsMap([
    'MAILINBLACK_API_KEY',
    'MAILINBLACK_API_URL',
    'MAILINBLACK_CLIENT_ID',
  ]);
  const authKey = settings.MAILINBLACK_API_KEY || process.env.MAILINBLACK_API_KEY;
  const apiUrl = settings.MAILINBLACK_API_URL || process.env.MAILINBLACK_API_URL;
  const authClientId =
    settings.MAILINBLACK_CLIENT_ID || process.env.MAILINBLACK_CLIENT_ID || null;

  if (!authKey || !apiUrl) {
    throw new Error('API Mailinblack globale non configurée');
  }

  return {
    apiUrl,
    authKey,
    apiKey: authKey,
    authClientId,
    source: 'global',
    mailinblackTenantId: null,
    clientId: clientId || null,
  };
}

export async function getGlobalMailinblackConfigStatus() {
  const settings = await getSettingsMap([
    'MAILINBLACK_API_KEY',
    'MAILINBLACK_API_URL',
    'MAILINBLACK_CLIENT_ID',
  ]);
  const authKey = settings.MAILINBLACK_API_KEY || process.env.MAILINBLACK_API_KEY;
  const apiUrl = settings.MAILINBLACK_API_URL || process.env.MAILINBLACK_API_URL;
  const authClientId =
    settings.MAILINBLACK_CLIENT_ID || process.env.MAILINBLACK_CLIENT_ID || null;
  return {
    configured: Boolean(authKey && apiUrl),
    apiUrl: apiUrl || null,
    authClientId: authClientId || null,
  };
}
