import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";
import { adaptMigrationSql } from "../utils/migrationSql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILE = "schema/patches/20260710_monitoring_automation.sql";

let ensured = false;

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [tableName]
  );
  return result.rows.length > 0;
}

export async function ensureMonitoringAutomationSchema() {
  if (ensured) return;
  if (!(await canRunAutoSchemaMigrations())) return;

  const client = await pool.connect();
  try {
    const exists = await tableExists(client, "v_b_monitoring_automation_config");
    if (!exists) {
      const filePath = path.join(root, MIGRATION_FILE);
      if (!fs.existsSync(filePath)) {
        console.warn("[monitoring-automation] Migration file not found:", MIGRATION_FILE);
        return;
      }
      const userResult = await client.query("SELECT current_user");
      const dbUser = userResult.rows[0]?.current_user || "postgres";
      await client.query(adaptMigrationSql(fs.readFileSync(filePath, "utf8"), dbUser));
    }
    ensured = true;
  } catch (err) {
    console.error("[monitoring-automation] Migration failed:", err.message);
  } finally {
    client.release();
  }
}
