import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILE = "schema/patches/20260618_client_ssl_certificates.sql";
let ensured = false;
async function tableExists(client) {
  const result = await client.query(`SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'v_b_clients_m_ssl'
     LIMIT 1`);
  return result.rows.length > 0;
}
export async function ensureSslSchema() {
  if (ensured) return;
  if (!(await canRunAutoSchemaMigrations())) return;
  const client = await pool.connect();
  try {
    if (await tableExists(client)) {
      ensured = true;
      return;
    }
    const filePath = path.join(root, MIGRATION_FILE);
    if (!fs.existsSync(filePath)) {
      console.warn("[ssl] Migration not found:", MIGRATION_FILE);
      return;
    }
    await client.query(fs.readFileSync(filePath, "utf8"));
    if (!(await tableExists(client))) {
      throw new Error("Table v_b_clients_m_ssl missing after migration");
    }
    ensured = true;
  } catch (err) {
    console.error("[ssl] Automatic migration failed:", err.message);
  } finally {
    client.release();
  }
}
