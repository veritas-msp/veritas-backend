import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILE = "schema/patches/20260724_mail_collect_settings.sql";

let ensured = false;

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [tableName]
  );
  return result.rows.length > 0;
}

export async function ensureMailCollectSettingsSchema() {
  if (ensured) return;
  if (!(await canRunAutoSchemaMigrations())) return;

  const client = await pool.connect();
  try {
    if (await tableExists(client, "v_b_ticket_mail_collect_settings_config")) {
      ensured = true;
      return;
    }

    const filePath = path.join(root, MIGRATION_FILE);
    if (!fs.existsSync(filePath)) {
      console.warn("[mail-collect-settings] Migration file not found:", MIGRATION_FILE);
      return;
    }

    await client.query(fs.readFileSync(filePath, "utf8"));
    ensured = true;
  } catch (err) {
    console.error("[mail-collect-settings] Migration failed:", err?.message || err);
  } finally {
    client.release();
  }
}
