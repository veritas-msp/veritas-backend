import { pool } from "../database/db.js";

let visibleToClientColumnCache = null;

export async function hasVisibleToClientColumn() {
  if (visibleToClientColumnCache !== null) return visibleToClientColumnCache;
  try {
    const { rows } = await pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'v_b_client_files'
         AND column_name = 'visible_to_client'
       LIMIT 1`
    );
    visibleToClientColumnCache = rows.length > 0;
  } catch {
    visibleToClientColumnCache = false;
  }
  return visibleToClientColumnCache;
}

/** Applique la migration visible_to_client si nécessaire (coffre-fort portail). */
export async function ensureVisibleToClientColumn() {
  if (await hasVisibleToClientColumn()) return true;
  try {
    await pool.query(`
      ALTER TABLE v_b_client_files
        ADD COLUMN IF NOT EXISTS visible_to_client BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await pool.query(`
      COMMENT ON COLUMN v_b_client_files.visible_to_client IS
        'Si true, le document est visible et téléchargeable depuis le portail client (coffre-fort).'
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_v_b_client_files_portal_visible
        ON v_b_client_files (client_id, visible_to_client)
        WHERE is_deleted = FALSE AND visible_to_client = TRUE
    `);
    visibleToClientColumnCache = true;
    return true;
  } catch (err) {
    console.error("[clientFiles] ensureVisibleToClientColumn:", err.message);
    return false;
  }
}

export function parseVisibleToClient(value) {
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  return false;
}

export function visibilitySelectSql(hasVisibility = null) {
  return hasVisibility === false
    ? "FALSE AS visible_to_client"
    : "visible_to_client";
}
