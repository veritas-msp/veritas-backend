import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { decryptSetting } from "../../utils/settingsHelper.js";
import { DEFAULT_SLA_SETTINGS, SLA_SETTINGS_KEY, SLA_SETTINGS_SECTION, normalizeSlaSettings } from "../../utils/slaSettings.js";
import { invalidateSlaSettingsCache } from "../../utils/slaSettingsStore.js";
const router = express.Router();
async function readSlaSettingsFromDb() {
  try {
    const tableCheck = await pool.query("SELECT to_regclass('public.v_b_settings') AS settings_table");
    if (!tableCheck.rows[0]?.settings_table) {
      return normalizeSlaSettings(DEFAULT_SLA_SETTINGS);
    }
    const result = await pool.query(`SELECT key, value, value_encrypted, value_iv, value_auth_tag
       FROM v_b_settings
       WHERE section = $1 AND key = $2`, [SLA_SETTINGS_SECTION, SLA_SETTINGS_KEY]);
    if (!result.rows.length) {
      return normalizeSlaSettings(DEFAULT_SLA_SETTINGS);
    }
    const raw = decryptSetting(result.rows[0]) ?? "";
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return normalizeSlaSettings({
        ...DEFAULT_SLA_SETTINGS,
        ...parsed
      });
    } catch {
      return normalizeSlaSettings(DEFAULT_SLA_SETTINGS);
    }
  } catch (err) {
    if (err?.code === "DATABASE_NOT_CONFIGURED" || err?.code === "42P01") {
      return normalizeSlaSettings(DEFAULT_SLA_SETTINGS);
    }
    throw err;
  }
}
async function upsertSlaSettings(client, settings) {
  await client.query(`INSERT INTO v_b_settings (key, value, label, section)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       label = EXCLUDED.label,
       section = EXCLUDED.section`, [SLA_SETTINGS_KEY, JSON.stringify(settings), "Support SLA settings", SLA_SETTINGS_SECTION]);
}
router.get("/", verifyJWT, async (_req, res) => {
  try {
    const settings = await readSlaSettingsFromDb();
    res.json(settings);
  } catch (err) {
    console.error("GET /sla-settings", err);
    res.status(500).json({
      error: "Unable to load SLA settings."
    });
  }
});
router.patch("/", verifyJWT, requireRole("admin"), async (req, res) => {
  const existing = await readSlaSettingsFromDb();
  const normalized = normalizeSlaSettings({
    ...existing,
    ...req.body
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await upsertSlaSettings(client, normalized);
    await client.query("COMMIT");
    invalidateSlaSettingsCache();
    res.json({
      success: true,
      settings: normalized
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /sla-settings", err);
    res.status(500).json({
      error: "Unable to save SLA settings."
    });
  } finally {
    client.release();
  }
});
export default router;
