import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";
import { adaptMigrationSql } from "../utils/migrationSql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const MIGRATIONS = [
  {
    table: "v_b_clients_bitdefender",
    file: "schema/patches/20260624_clients_bitdefender.sql",
    label: "bitdefender",
  },
  {
    table: "v_b_clients_mailinblack",
    file: "schema/patches/20260625_clients_mailinblack.sql",
    label: "mailinblack",
  },
];

const MAILINBLACK_AUTH_CLIENT_COLUMN = {
  table: "v_b_clients_mailinblack",
  column: "auth_client_id",
  file: "schema/patches/20260625_mailinblack_auth_client_id.sql",
};

let ensured = false;

async function tableExists(client, tableName) {
  const { rows } = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${tableName}`]);
  return Boolean(rows[0]?.reg);
}

async function columnExists(client, tableName, columnName) {
  const { rows } = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function applyMigrationFile(client, relativePath, dbUser) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    console.warn(`[integration-tenants] Migration introuvable : ${relativePath}`);
    return false;
  }
  const sql = adaptMigrationSql(fs.readFileSync(filePath, "utf8"), dbUser);
  await client.query(sql);
  return true;
}

/** Tables tenants dédiés Bitdefender / Mailinblack (hors dossier Avril/). */
export async function ensureIntegrationTenantsSchema() {
  if (ensured) return;
  if (!(await canRunAutoSchemaMigrations())) return;

  const client = await pool.connect();
  try {
    const userResult = await client.query("SELECT current_user");
    const dbUser = userResult.rows[0]?.current_user || "postgres";

    for (const migration of MIGRATIONS) {
      if (await tableExists(client, migration.table)) continue;

      console.log(
        `[integration-tenants] Table ${migration.table} absente — application de ${migration.file}…`
      );
      await applyMigrationFile(client, migration.file, dbUser);

      if (!(await tableExists(client, migration.table))) {
        throw new Error(`Table ${migration.table} absente après migration`);
      }
      console.log(`[integration-tenants] OK ${migration.label}`);
    }

    if (
      (await tableExists(client, MAILINBLACK_AUTH_CLIENT_COLUMN.table)) &&
      !(await columnExists(
        client,
        MAILINBLACK_AUTH_CLIENT_COLUMN.table,
        MAILINBLACK_AUTH_CLIENT_COLUMN.column
      ))
    ) {
      console.log(
        `[integration-tenants] Colonne ${MAILINBLACK_AUTH_CLIENT_COLUMN.column} absente — migration…`
      );
      await applyMigrationFile(client, MAILINBLACK_AUTH_CLIENT_COLUMN.file, dbUser);
    }

    ensured = true;
  } catch (err) {
    console.error("[integration-tenants] Échec migration automatique:", err.message);
    throw err;
  } finally {
    client.release();
  }
}
