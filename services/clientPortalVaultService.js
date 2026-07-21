import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { ensureVisibleToClientColumn, hasVisibleToClientColumn } from "../utils/clientFilesVisibility.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_FILES_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "client-files");
function mapPortalVaultFile(row) {
  return {
    id: row.id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    category: row.category,
    description: row.description || "",
    created_at: row.created_at
  };
}
export async function listPortalVaultFiles(clientId, {
  category,
  search,
  limit,
  offset
} = {}) {
  const ready = await ensureVisibleToClientColumn();
  if (!ready || !(await hasVisibleToClientColumn())) return [];
  const conditions = ["client_id = $1", "is_deleted = FALSE", "visible_to_client = TRUE"];
  const values = [Number(clientId)];
  if (category && category !== "all") {
    values.push(String(category));
    conditions.push(`category = $${values.length}`);
  }
  const trimmedSearch = String(search || "").trim();
  if (trimmedSearch) {
    values.push(`%${trimmedSearch}%`);
    conditions.push(`(file_name ILIKE $${values.length} OR COALESCE(description, '') ILIKE $${values.length} OR category ILIKE $${values.length})`);
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  values.push(safeLimit, safeOffset);
  const {
    rows
  } = await pool.query(`SELECT id, file_name, mime_type, size_bytes, category, description, created_at
     FROM v_b_client_files
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  return rows.map(mapPortalVaultFile);
}
export async function countPortalVaultFiles(clientId, {
  category,
  search
} = {}) {
  const ready = await ensureVisibleToClientColumn();
  if (!ready || !(await hasVisibleToClientColumn())) return 0;
  const conditions = ["client_id = $1", "is_deleted = FALSE", "visible_to_client = TRUE"];
  const values = [Number(clientId)];
  if (category && category !== "all") {
    values.push(String(category));
    conditions.push(`category = $${values.length}`);
  }
  const trimmedSearch = String(search || "").trim();
  if (trimmedSearch) {
    values.push(`%${trimmedSearch}%`);
    conditions.push(`(file_name ILIKE $${values.length} OR COALESCE(description, '') ILIKE $${values.length} OR category ILIKE $${values.length})`);
  }
  const {
    rows
  } = await pool.query(`SELECT COUNT(*)::int AS total
     FROM v_b_client_files
     WHERE ${conditions.join(" AND ")}`, values);
  return rows[0]?.total || 0;
}
export async function getPortalVaultFileRecord(clientId, fileId) {
  const ready = await ensureVisibleToClientColumn();
  if (!ready || !(await hasVisibleToClientColumn())) return null;
  const conditions = ["id = $1", "client_id = $2", "is_deleted = FALSE", "visible_to_client = TRUE"];
  const {
    rows
  } = await pool.query(`SELECT id, client_id, file_name, file_path, mime_type, size_bytes, category, description, created_at
     FROM v_b_client_files
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`, [fileId, Number(clientId)]);
  return rows[0] || null;
}
export function resolveClientFileDiskPath(filePath) {
  const fileName = path.basename(String(filePath || ""));
  if (!fileName) return null;
  const fullPath = path.join(CLIENT_FILES_UPLOAD_DIR, fileName);
  if (!fs.existsSync(fullPath)) return null;
  return fullPath;
}
