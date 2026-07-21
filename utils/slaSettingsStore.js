import { pool } from "../database/db.js";
import { decryptSetting } from "./settingsHelper.js";
import { DEFAULT_SLA_SETTINGS, SLA_SETTINGS_KEY, SLA_SETTINGS_SECTION, normalizeSlaSettings } from "./slaSettings.js";
let cachedSettings = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;
export function invalidateSlaSettingsCache() {
  cachedSettings = null;
  cacheTimestamp = 0;
}
export async function loadSlaSettings({
  force = false
} = {}) {
  if (!force && cachedSettings && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSettings;
  }
  const result = await pool.query(`SELECT key, value, value_encrypted, value_iv, value_auth_tag
     FROM v_b_settings
     WHERE section = $1 AND key = $2`, [SLA_SETTINGS_SECTION, SLA_SETTINGS_KEY]);
  if (!result.rows.length) {
    cachedSettings = normalizeSlaSettings(DEFAULT_SLA_SETTINGS);
    cacheTimestamp = Date.now();
    return cachedSettings;
  }
  const raw = decryptSetting(result.rows[0]) ?? "";
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    cachedSettings = normalizeSlaSettings({
      ...DEFAULT_SLA_SETTINGS,
      ...parsed
    });
  } catch {
    cachedSettings = normalizeSlaSettings(DEFAULT_SLA_SETTINGS);
  }
  cacheTimestamp = Date.now();
  return cachedSettings;
}
