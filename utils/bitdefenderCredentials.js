import { pool } from '../database/db.js';
import { decrypt } from '../utils/encryption.js';
import { getSettingsMap } from '../utils/settingsHelper.js';
export async function resolveBitdefenderCredentials({
  clientId,
  bitdefenderTenantId
} = {}) {
  if (bitdefenderTenantId) {
    const params = [bitdefenderTenantId];
    let query = `
      SELECT id, client_id, api_url, api_key_encrypted, iv, auth_tag
      FROM v_b_clients_bitdefender
      WHERE id = $1
    `;
    if (clientId) {
      query += ' AND client_id = $2';
      params.push(clientId);
    }
    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      throw new Error('Dedicated Bitdefender tenant not found');
    }
    const row = result.rows[0];
    const apiKey = decrypt(row.api_key_encrypted, row.iv, row.auth_tag);
    if (!apiKey) {
      throw new Error('Unable to decrypt the Bitdefender API key');
    }
    return {
      apiUrl: row.api_url,
      apiKey,
      source: 'dedicated',
      bitdefenderTenantId: row.id,
      clientId: row.client_id
    };
  }
  const settings = await getSettingsMap(['BITDEFENDER_API_KEY', 'BITDEFENDER_API_URL']);
  const apiKey = settings.BITDEFENDER_API_KEY || process.env.BITDEFENDER_API_KEY;
  const apiUrl = settings.BITDEFENDER_API_URL || process.env.BITDEFENDER_API_URL;
  if (!apiKey || !apiUrl) {
    throw new Error('Global Bitdefender API is not configured');
  }
  return {
    apiUrl,
    apiKey,
    source: 'global',
    bitdefenderTenantId: null,
    clientId: clientId || null
  };
}
export async function getGlobalBitdefenderConfigStatus() {
  const settings = await getSettingsMap(['BITDEFENDER_API_KEY', 'BITDEFENDER_API_URL']);
  const apiKey = settings.BITDEFENDER_API_KEY || process.env.BITDEFENDER_API_KEY;
  const apiUrl = settings.BITDEFENDER_API_URL || process.env.BITDEFENDER_API_URL;
  return {
    configured: Boolean(apiKey && apiUrl),
    apiUrl: apiUrl || null
  };
}
