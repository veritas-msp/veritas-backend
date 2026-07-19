import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILE = "schema/patches/20260704_ticket_comment_updated_at.sql";

let ensured = false;

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [tableName, columnName]
  );
  return result.rows.length > 0;
}

export async function ensureTicketCommentUpdatedAtSchema() {
  if (ensured) return;
  if (!(await canRunAutoSchemaMigrations())) return;

  const client = await pool.connect();
  try {
    const hasColumn = await columnExists(client, "v_b_ticket_comments", "updated_at");
    if (!hasColumn) {
      const filePath = path.join(root, MIGRATION_FILE);
      if (!fs.existsSync(filePath)) {
        console.warn("[ticket-comment-updated-at] Migration file not found:", MIGRATION_FILE);
        return;
      }
      await client.query(fs.readFileSync(filePath, "utf8"));
    }
    ensured = true;
  } catch (err) {
    console.error("[ticket-comment-updated-at] Migration failed:", err?.message || err);
  } finally {
    client.release();
  }
}
