import { pool } from '../database/db.js';
import { decrypt, encrypt } from './encryption.js';
export function decryptSetting(row) {
  if (row?.value_encrypted && row?.value_iv && row?.value_auth_tag) {
    try {
      return decrypt(row.value_encrypted, row.value_iv, row.value_auth_tag);
    } catch (e) {
      return null;
    }
  }
  return row?.value ?? null;
}
export async function getSettingsMap(keys = []) {
  const result = await pool.query(`SELECT key, value, value_encrypted, value_iv, value_auth_tag
     FROM v_b_settings
     ${keys.length ? 'WHERE key = ANY($1)' : ''}`, keys.length ? [keys] : []);
  const map = {};
  result.rows.forEach(row => {
    map[row.key] = decryptSetting(row);
  });
  return map;
}
export function encryptSettingValue(value) {
  if (value === undefined || value === null || value === '') {
    return {
      value: null,
      value_encrypted: null,
      value_iv: null,
      value_auth_tag: null
    };
  }
  const enc = encrypt(String(value));
  if (!enc) {
    return {
      value: null,
      value_encrypted: null,
      value_iv: null,
      value_auth_tag: null
    };
  }
  return {
    value: null,
    value_encrypted: enc.encrypted,
    value_iv: enc.iv,
    value_auth_tag: enc.authTag
  };
}
