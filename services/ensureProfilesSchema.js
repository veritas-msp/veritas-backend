import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";
import { REFERENCE_SCHEMA_SEEDS_SQL } from "../utils/schemaFromCsv.js";
import { adaptMigrationSql } from "../utils/migrationSql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const INHERITANCE_MIGRATION = "schema/patches/20260618_profiles_inheritance_ticket_view_profiles.sql";

let ensured = false;

async function columnExists(client, table, column) {
  const { rows } = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function tableExists(client, table) {
  const { rows } = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
  return Boolean(rows[0]?.reg);
}

/** Colonne parent_profile + profils par défaut si la table est vide. */
export async function ensureProfilesSchema() {
  if (ensured) return;
  if (!(await canRunAutoSchemaMigrations())) return;

  const client = await pool.connect();
  try {
    if (!(await tableExists(client, "v_b_users_profiles"))) {
      return;
    }

    if (!(await columnExists(client, "v_b_users_profiles", "parent_profile"))) {
      const filePath = path.join(root, INHERITANCE_MIGRATION);
      if (fs.existsSync(filePath)) {
        const userResult = await client.query("SELECT current_user");
        const dbUser = userResult.rows[0]?.current_user || "postgres";
        console.log("[profiles] Application de la migration héritage profils…");
        await client.query(adaptMigrationSql(fs.readFileSync(filePath, "utf8"), dbUser));
      } else {
        console.warn("[profiles] Migration introuvable:", INHERITANCE_MIGRATION);
      }
    }

    const countResult = await client.query("SELECT COUNT(*)::int AS count FROM v_b_users_profiles");
    if ((countResult.rows[0]?.count || 0) === 0) {
      console.log("[profiles] Table vide — insertion des profils par défaut…");
      await client.query(REFERENCE_SCHEMA_SEEDS_SQL);
    }

    ensured = true;
  } catch (err) {
    console.error("[profiles] Échec migration automatique:", err.message);
  } finally {
    client.release();
  }
}
