import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILES = ["schema/patches/20260728_client_vault_secrets.sql", "schema/patches/20260728_client_vault_secrets_grants.sql"];
const CONTACT_ID_MIGRATION = "schema/patches/20260729_client_vault_secrets_contact_id.sql";
let ensured = false;
async function columnExists(client, tableName, columnName) {
  const {
    rows
  } = await client.query(`SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`, [tableName, columnName]);
  return rows.length > 0;
}
async function applyMigrationFile(client, relPath) {
  const filePath = path.join(root, relPath);
  if (!fs.existsSync(filePath)) {
    console.warn("[vault-secrets] Migration not found:", relPath);
    return;
  }
  await client.query(fs.readFileSync(filePath, "utf8"));
}
export async function ensureClientVaultSecretsSchema() {
  if (ensured) return true;
  if (!(await canRunAutoSchemaMigrations())) return false;
  const client = await pool.connect();
  try {
    const exists = await client.query(`SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'v_b_client_vault_secrets'
       LIMIT 1`);
    if (exists.rows.length === 0) {
      for (const relPath of MIGRATION_FILES) {
        await applyMigrationFile(client, relPath);
      }
    } else if (!(await columnExists(client, "v_b_client_vault_secrets", "contact_id"))) {
      await applyMigrationFile(client, CONTACT_ID_MIGRATION);
    }
    ensured = true;
    return true;
  } catch (err) {
    console.error("[vault-secrets] Automatic migration failed:", err.message);
    return false;
  } finally {
    client.release();
  }
}
export async function hasClientVaultSecretsTable() {
  await ensureClientVaultSecretsSchema();
  try {
    const {
      rows
    } = await pool.query(`SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'v_b_client_vault_secrets'
       LIMIT 1`);
    return rows.length > 0;
  } catch {
    return false;
  }
}
