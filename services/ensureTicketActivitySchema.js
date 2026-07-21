import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILE = "schema/patches/20260720_ticket_activity.sql";
let ensured = false;

async function tableExists(client) {
  const result = await client.query(`SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'v_b_ticket_activity'
     LIMIT 1`);
  return result.rows.length > 0;
}

export async function ensureTicketActivitySchema() {
  if (ensured) return true;
  if (!(await canRunAutoSchemaMigrations())) return false;
  const client = await pool.connect();
  try {
    if (await tableExists(client)) {
      ensured = true;
      return true;
    }
    const filePath = path.join(root, MIGRATION_FILE);
    if (!fs.existsSync(filePath)) {
      console.warn("[ticket-activity] Migration file not found:", MIGRATION_FILE);
      return false;
    }
    await client.query(fs.readFileSync(filePath, "utf8"));
    ensured = await tableExists(client);
    return ensured;
  } catch (err) {
    console.error("[ticket-activity] Migration failed:", err.message);
    return false;
  } finally {
    client.release();
  }
}
