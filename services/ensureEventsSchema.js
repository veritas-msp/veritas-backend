import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const TICKET_ID_MIGRATION = "schema/patches/20260708_events_ticket_reminder.sql";

let ensured = false;
let schemaCache = null;

async function columnExists(client, columnName) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.oid = to_regclass('public.v_b_events')
         AND a.attname = $1
         AND NOT a.attisdropped
     ) AS has_column`,
    [columnName]
  );
  return Boolean(result.rows[0]?.has_column);
}

async function readHasTicketId(client = pool) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.oid = to_regclass('public.v_b_events')
         AND a.attname = 'ticket_id'
         AND NOT a.attisdropped
     ) AS has_ticket_id`
  );
  return Boolean(result.rows[0]?.has_ticket_id);
}

export async function resolveEventsSchema() {
  if (schemaCache) return schemaCache;
  schemaCache = { hasTicketId: await readHasTicketId() };
  return schemaCache;
}

export async function ensureEventsSchema() {
  if (ensured) return resolveEventsSchema();

  const hasTicketId = await readHasTicketId();
  if (hasTicketId) {
    ensured = true;
    schemaCache = { hasTicketId: true };
    return schemaCache;
  }

  if (!(await canRunAutoSchemaMigrations())) {
    schemaCache = { hasTicketId: false };
    return schemaCache;
  }

  const client = await pool.connect();
  try {
    const migrationPath = path.join(root, TICKET_ID_MIGRATION);
    if (!fs.existsSync(migrationPath)) {
      console.warn(`[events] Migration introuvable : ${TICKET_ID_MIGRATION}`);
      schemaCache = { hasTicketId: false };
      return schemaCache;
    }

    console.log("[events] Colonne ticket_id absente — application de la migration…");
    await client.query(fs.readFileSync(migrationPath, "utf8"));

    const applied = await columnExists(client, "ticket_id");
    schemaCache = { hasTicketId: applied };
    ensured = true;
    if (applied) {
      console.log("[events] Schéma événements (ticket_id) prêt.");
    } else {
      console.warn("[events] Migration terminée mais ticket_id toujours absent.");
    }
    return schemaCache;
  } catch (err) {
    console.error("[events] Échec migration ticket_id:", err.message);
    schemaCache = { hasTicketId: false };
    return schemaCache;
  } finally {
    client.release();
  }
}
