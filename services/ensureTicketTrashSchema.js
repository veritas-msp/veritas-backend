import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILE = "schema/patches/20260625_ticket_trash.sql";

let columnsReady = false;
let migrationAttempted = false;
let lastFailureMessage = "";

async function columnExists(client, columnName) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.oid = to_regclass('v_b_tickets')
         AND a.attname = $1
         AND a.attnum > 0
         AND NOT a.attisdropped
     ) AS has_column`,
    [columnName]
  );
  return Boolean(result.rows?.[0]?.has_column);
}

async function refreshColumnState(client) {
  const hasDeletedAt = await columnExists(client, "deleted_at");
  const hasIsDeleted = await columnExists(client, "is_deleted");
  columnsReady = hasDeletedAt && hasIsDeleted;
  return columnsReady;
}

export function isTicketTrashSchemaReady() {
  return columnsReady;
}

export function getTicketTrashSchemaFailure() {
  return lastFailureMessage;
}

export async function ensureTicketTrashSchema({ allowAutoMigrate = true } = {}) {
  if (columnsReady) return { ready: true };
  if (!(await canRunAutoSchemaMigrations())) {
    return { ready: false, error: "Installation en cours — migrations différées." };
  }

  const client = await pool.connect();
  try {
    if (await refreshColumnState(client)) {
      return { ready: true };
    }

    if (!allowAutoMigrate || migrationAttempted) {
      return {
        ready: false,
        error:
          lastFailureMessage ||
          "Colonnes corbeille absentes. Exécutez schema/patches/20260625_ticket_trash.sql avec le propriétaire de la table (ex. postgres).",
      };
    }

    migrationAttempted = true;

    const filePath = path.join(root, MIGRATION_FILE);
    if (!fs.existsSync(filePath)) {
      lastFailureMessage = `Fichier migration introuvable : ${MIGRATION_FILE}`;
      console.warn(`[ticket-trash] ${lastFailureMessage}`);
      return { ready: false, error: lastFailureMessage };
    }

    console.log("[ticket-trash] Application de la migration corbeille tickets…");
    try {
      await client.query(fs.readFileSync(filePath, "utf8"));
      if (await refreshColumnState(client)) {
        console.log("[ticket-trash] Corbeille tickets prête.");
        lastFailureMessage = "";
        return { ready: true };
      }
      lastFailureMessage = "Migration exécutée mais colonnes corbeille introuvables.";
      console.error(`[ticket-trash] ${lastFailureMessage}`);
      return { ready: false, error: lastFailureMessage };
    } catch (err) {
      lastFailureMessage = err?.message || String(err);
      console.error(
        "[ticket-trash] Échec migration automatique:",
        lastFailureMessage,
        "\n→ Relancez le serveur ou exécutez : npm run schema:incremental"
      );
      return { ready: false, error: lastFailureMessage };
    }
  } finally {
    client.release();
  }
}

export function resetTicketTrashSchemaCache() {
  columnsReady = false;
  migrationAttempted = false;
  lastFailureMessage = "";
}
