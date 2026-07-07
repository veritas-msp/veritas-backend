import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";
import { getSolutionCatalogDefaults, normalizeSolutionCatalogLocale } from "../utils/ticketSolutionCatalogDefaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILE = "schema/patches/20260709_ticket_solution_catalog.sql";

let ensured = false;
let schemaCache = null;

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS has_table`,
    [`public.${tableName}`]
  );
  return Boolean(result.rows?.[0]?.has_table);
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.oid = to_regclass($1)
         AND a.attname = $2
         AND NOT a.attisdropped
     ) AS has_column`,
    [`public.${tableName}`, columnName]
  );
  return Boolean(result.rows?.[0]?.has_column);
}

async function resolveSeedLocale(client) {
  try {
    const result = await client.query(
      `SELECT value FROM v_b_settings WHERE key = 'app_default_locale' LIMIT 1`
    );
    return normalizeSolutionCatalogLocale(result.rows?.[0]?.value);
  } catch {
    return "fr";
  }
}

export async function seedSolutionCatalogIfEmpty(client, locale) {
  const countResult = await client.query(`SELECT COUNT(*)::int AS count FROM v_b_ticket_solution_catalog`);
  if ((countResult.rows?.[0]?.count || 0) > 0) return false;

  const resolvedLocale =
    locale != null && String(locale).trim()
      ? normalizeSolutionCatalogLocale(locale)
      : await resolveSeedLocale(client);
  await seedDefaultCatalog(client, resolvedLocale);
  return true;
}

async function seedDefaultCatalog(client, locale = "fr") {
  const entries = getSolutionCatalogDefaults(locale);
  for (const entry of entries) {
    await client.query(
      `INSERT INTO v_b_ticket_solution_catalog (category, label, display_order, is_active, created_at, updated_at)
       SELECT $1::varchar, $2::varchar, $3::int, TRUE, NOW(), NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM v_b_ticket_solution_catalog
         WHERE category = $1::varchar AND lower(trim(label)) = lower(trim($2::varchar))
       )`,
      [entry.category, entry.label, entry.displayOrder]
    );
  }
}

export async function resolveTicketSolutionCatalogSchema() {
  if (schemaCache) return schemaCache;
  const [hasCatalog, hasInterventionCol, hasActionCol] = await Promise.all([
    tableExists(pool, "v_b_ticket_solution_catalog"),
    columnExists(pool, "v_b_ticket_resolution_validations", "intervention_type"),
    columnExists(pool, "v_b_ticket_resolution_validations", "action_type"),
  ]);
  schemaCache = {
    hasCatalog,
    hasInterventionCol,
    hasActionCol,
  };
  return schemaCache;
}

export async function ensureTicketSolutionCatalogSchema() {
  if (ensured) return resolveTicketSolutionCatalogSchema();

  const schema = await resolveTicketSolutionCatalogSchema();
  if (schema.hasCatalog && schema.hasInterventionCol && schema.hasActionCol) {
    ensured = true;
    if (schema.hasCatalog) {
      const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM v_b_ticket_solution_catalog`);
      if ((countResult.rows?.[0]?.count || 0) === 0) {
        const client = await pool.connect();
        try {
          await seedSolutionCatalogIfEmpty(client);
        } finally {
          client.release();
        }
      }
    }
    return schema;
  }

  if (!(await canRunAutoSchemaMigrations())) {
    return schema;
  }

  const client = await pool.connect();
  try {
    const migrationPath = path.join(root, MIGRATION_FILE);
    if (!fs.existsSync(migrationPath)) {
      console.warn(`[ticket-solution-catalog] Migration introuvable : ${MIGRATION_FILE}`);
      return schema;
    }

    console.log("[ticket-solution-catalog] Schéma incomplet — application de la migration…");
    await client.query(fs.readFileSync(migrationPath, "utf8"));
    await seedSolutionCatalogIfEmpty(client);
    schemaCache = null;
    ensured = true;
    const next = await resolveTicketSolutionCatalogSchema();
    console.log("[ticket-solution-catalog] Schéma prêt.");
    return next;
  } catch (err) {
    console.error("[ticket-solution-catalog] Échec migration:", err.message);
    return schema;
  } finally {
    client.release();
  }
}
