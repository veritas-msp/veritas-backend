import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILE = "schema/patches/20260618_teams_core.sql";

let ensured = false;

export async function ensureTeamsSchema() {
  if (ensured) return;
  if (!(await canRunAutoSchemaMigrations())) return;

  const client = await pool.connect();
  try {
    const exists = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'v_b_teams'
       LIMIT 1`
    );
    if (exists.rows.length > 0) {
      ensured = true;
      return;
    }

    const filePath = path.join(root, MIGRATION_FILE);
    if (!fs.existsSync(filePath)) {
      console.warn("[teams] Migration not found:", MIGRATION_FILE);
      return;
    }

    await client.query(fs.readFileSync(filePath, "utf8"));
    ensured = true;
  } catch (err) {
    console.error("[teams] Automatic migration failed:", err.message);
  } finally {
    client.release();
  }
}
