import express from "express";
import { pool, isDatabaseConfigured } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { decryptSetting } from "../../utils/settingsHelper.js";
import {
  DEFAULT_GENERAL_SETTINGS,
  GENERAL_SETTINGS_LABELS,
  GENERAL_SETTING_KEYS,
  GENERAL_SETTINGS_SECTION,
  normalizeGeneralSettings,
} from "../../utils/generalSettings.js";
import { seedSolutionCatalogIfEmpty } from "../../services/ensureTicketSolutionCatalogSchema.js";

const router = express.Router();

async function readGeneralSettingsFromDb() {
  if (!isDatabaseConfigured()) {
    return normalizeGeneralSettings(DEFAULT_GENERAL_SETTINGS);
  }

  try {
    const tableCheck = await pool.query(
      "SELECT to_regclass('public.v_b_settings') AS settings_table"
    );
    if (!tableCheck.rows[0]?.settings_table) {
      return normalizeGeneralSettings(DEFAULT_GENERAL_SETTINGS);
    }

    const result = await pool.query(
      `SELECT key, value, value_encrypted, value_iv, value_auth_tag
       FROM v_b_settings
       WHERE section = $1`,
      [GENERAL_SETTINGS_SECTION]
    );

    const fromDb = {};
    for (const row of result.rows) {
      fromDb[row.key] = decryptSetting(row) ?? "";
    }

    return normalizeGeneralSettings({ ...DEFAULT_GENERAL_SETTINGS, ...fromDb });
  } catch (err) {
    if (err?.code === "DATABASE_NOT_CONFIGURED" || err?.code === "42P01") {
      return normalizeGeneralSettings(DEFAULT_GENERAL_SETTINGS);
    }
    throw err;
  }
}

async function upsertGeneralSetting(client, key, value) {
  await client.query(
    `INSERT INTO v_b_settings (key, value, label, section)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       label = EXCLUDED.label,
       section = EXCLUDED.section`,
    [key, String(value ?? ""), GENERAL_SETTINGS_LABELS[key] || key, GENERAL_SETTINGS_SECTION]
  );
}

// GET /api/general-settings — Global preferences (public read)
router.get("/", async (_req, res) => {
  try {
    const settings = await readGeneralSettingsFromDb();
    res.json(settings);
  } catch (err) {
    console.error("GET /general-settings", err);
    res.status(500).json({ error: "Impossible de charger les paramètres généraux." });
  }
});

// PATCH /api/general-settings — Update (admin only)
router.patch("/", verifyJWT, requireRole("admin"), async (req, res) => {
  const existing = await readGeneralSettingsFromDb();
  const normalized = normalizeGeneralSettings({ ...existing, ...req.body });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of Object.entries(normalized)) {
      await upsertGeneralSetting(client, key, value);
    }
    await client.query("COMMIT");

    try {
      await seedSolutionCatalogIfEmpty(client, normalized[GENERAL_SETTING_KEYS.defaultLocale]);
    } catch (seedErr) {
      console.warn("[general-settings] Solution catalog seed skipped:", seedErr.message);
    }

    res.json({ success: true, settings: normalized });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /general-settings", err);
    res.status(500).json({ error: "Impossible d'enregistrer les paramètres généraux." });
  } finally {
    client.release();
  }
});

export default router;
