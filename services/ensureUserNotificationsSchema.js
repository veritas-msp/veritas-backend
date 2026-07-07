import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILE = "schema/patches/20260721_user_notifications.sql";
const ARCHIVE_MIGRATION_FILE = "schema/patches/20260623_user_notifications_archive.sql";

let ensured = false;

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [tableName]
  );
  return result.rows.length > 0;
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [tableName, columnName]
  );
  return result.rows.length > 0;
}

async function applyMigrationFile(client, relativePath, label) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    console.warn(`[user-notifications] Fichier migration introuvable : ${relativePath}`);
    return false;
  }
  console.log(`[user-notifications] Application de la migration ${label}…`);
  await client.query(fs.readFileSync(filePath, "utf8"));
  console.log(`[user-notifications] Migration ${label} OK`);
  return true;
}

export async function ensureUserNotificationsSchema() {
  if (ensured) return;
  if (!(await canRunAutoSchemaMigrations())) return;

  const client = await pool.connect();
  try {
    const hasTable = await tableExists(client, "v_b_user_notifications");
    if (!hasTable) {
      await applyMigrationFile(client, MIGRATION_FILE, "table");
    }

    if (hasTable || (await tableExists(client, "v_b_user_notifications"))) {
      const hasArchiveColumn = await columnExists(client, "v_b_user_notifications", "archived_at");
      if (!hasArchiveColumn) {
        await applyMigrationFile(client, ARCHIVE_MIGRATION_FILE, "archive");
      }
    }

    ensured = true;
  } catch (err) {
    console.error("[user-notifications] Erreur migration:", err?.message || err);
  } finally {
    client.release();
  }
}
