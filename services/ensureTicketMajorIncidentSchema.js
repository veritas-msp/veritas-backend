import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILE = "schema/patches/20260621_ticket_major_incident_contact_slots.sql";

let ensured = false;

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [tableName, columnName]
  );
  return result.rows.length > 0;
}

export async function ensureTicketMajorIncidentSchema() {
  if (ensured) return;
  if (!(await canRunAutoSchemaMigrations())) return;

  const client = await pool.connect();
  try {
    const hasColumn = await columnExists(client, "v_b_tickets", "is_major_incident");
    if (!hasColumn) {
      const filePath = path.join(root, MIGRATION_FILE);
      if (!fs.existsSync(filePath)) {
        console.warn("[ticket-major-incident] Migration file not found:", MIGRATION_FILE);
        return;
      }
      await client.query(fs.readFileSync(filePath, "utf8"));
    }
    ensured = true;
  } catch (err) {
    console.error("[ticket-major-incident] Migration failed:", err.message);
  } finally {
    client.release();
  }
}
