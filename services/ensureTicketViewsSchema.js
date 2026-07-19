import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const MIGRATION_FILES = [
  "schema/patches/20260617_ticket_views_core.sql",
  "schema/patches/20260618_profiles_inheritance_ticket_view_profiles.sql",
  "schema/patches/20260619_ticket_view_assignments.sql",
];

let ensured = false;

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [tableName]
  );
  return result.rows.length > 0;
}

async function runSqlFile(client, rel) {
  const filePath = path.join(root, rel);
  if (!fs.existsSync(filePath)) {
    console.warn(`[ticket-views] Migration file not found: ${rel}`);
    return;
  }
  await client.query(fs.readFileSync(filePath, "utf8"));
}

export async function ensureTicketViewsSchema() {
  if (ensured) return;
  if (!(await canRunAutoSchemaMigrations())) return;

  const client = await pool.connect();
  try {
    const hasViewsTable = await tableExists(client, "v_b_ticket_views");
    const hasProfilesLink = await tableExists(client, "v_b_ticket_view_profiles");
    const hasUsersLink = await tableExists(client, "v_b_ticket_view_users");
    const hasTeamsLink = await tableExists(client, "v_b_ticket_view_teams");

    if (hasViewsTable && hasProfilesLink && hasUsersLink && hasTeamsLink) {
      ensured = true;
      return;
    }

    if (!hasViewsTable) {
      await runSqlFile(client, MIGRATION_FILES[0]);
    }
    if (!hasProfilesLink) {
      await runSqlFile(client, MIGRATION_FILES[1]);
    }
    if (!hasUsersLink || !hasTeamsLink) {
      await runSqlFile(client, MIGRATION_FILES[2]);
    }

    ensured = true;
  } catch (err) {
    console.error("[ticket-views] Automatic migration failed:", err.message);
  } finally {
    client.release();
  }
}
