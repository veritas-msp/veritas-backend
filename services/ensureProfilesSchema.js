import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";
import { REFERENCE_SCHEMA_SEEDS_SQL } from "../utils/schemaFromCsv.js";
import { adaptMigrationSql } from "../utils/migrationSql.js";
import { SUPER_ADMIN_PROFILE_NAME } from "../config/permissionPresets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const INHERITANCE_MIGRATION = "schema/patches/20260618_profiles_inheritance_ticket_view_profiles.sql";
let ensured = false;

async function columnExists(client, table, column) {
  const {
    rows
  } = await client.query(`SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`, [table, column]);
  return rows.length > 0;
}

async function tableExists(client, table) {
  const {
    rows
  } = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
  return Boolean(rows[0]?.reg);
}

/** Ensure Super Admin exists on existing installs (FR/EN seeds may predate this profile). */
export async function ensureSuperAdminProfile(client = null) {
  const owned = !client;
  const db = client || await pool.connect();
  try {
    if (!(await tableExists(db, "v_b_users_profiles"))) return false;
    await db.query(`ALTER TABLE v_b_users_profiles
      ADD COLUMN IF NOT EXISTS documents_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
    const result = await db.query(`INSERT INTO v_b_users_profiles (
        name, label,
        monitoring_enabled, infrastructure_enabled, cybersecurite_enabled,
        planning_enabled, service_enabled, contrat_enabled, contact_enabled,
        configurateur_enabled, tickets_enabled, dashboard_enabled, documents_enabled, display_order
      ) VALUES (
        $1,
        'Accès total non modifiable — propriétaire de l''instance.',
        true, true, true, true, true, true, true, true, true, true, true, 1
      )
      ON CONFLICT (name) DO NOTHING
      RETURNING name`, [SUPER_ADMIN_PROFILE_NAME]);
    return result.rowCount > 0;
  } finally {
    if (owned) db.release();
  }
}

export async function ensureProfilesSchema() {
  if (!(await canRunAutoSchemaMigrations())) return;
  const client = await pool.connect();
  try {
    if (!(await tableExists(client, "v_b_users_profiles"))) {
      return;
    }
    if (!ensured) {
      if (!(await columnExists(client, "v_b_users_profiles", "parent_profile"))) {
        const filePath = path.join(root, INHERITANCE_MIGRATION);
        if (fs.existsSync(filePath)) {
          const userResult = await client.query("SELECT current_user");
          const dbUser = userResult.rows[0]?.current_user || "postgres";
          await client.query(adaptMigrationSql(fs.readFileSync(filePath, "utf8"), dbUser));
        } else {
          console.warn("[profiles] Migration not found:", INHERITANCE_MIGRATION);
        }
      }
      const countResult = await client.query("SELECT COUNT(*)::int AS count FROM v_b_users_profiles");
      if ((countResult.rows[0]?.count || 0) === 0) {
        await client.query(REFERENCE_SCHEMA_SEEDS_SQL);
      }
      ensured = true;
    }
    const created = await ensureSuperAdminProfile(client);
    if (created) {
      console.log(`[profiles] Created system profile « ${SUPER_ADMIN_PROFILE_NAME} ».`);
    }
  } catch (err) {
    console.error("[profiles] Automatic migration failed:", err.message);
  } finally {
    client.release();
  }
}
