import { pool } from "../database/db.js";
import { ensureTicketSolutionCatalogSchema } from "./ensureTicketSolutionCatalogSchema.js";
function mapCatalogRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    category: row.category,
    label: row.label,
    displayOrder: row.display_order ?? 0,
    isActive: row.is_active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
export async function listSolutionCatalog({
  category = "",
  includeInactive = false
} = {}) {
  const schema = await ensureTicketSolutionCatalogSchema();
  if (!schema.hasCatalog) return [];
  const values = [];
  const where = [];
  if (category) {
    values.push(String(category).trim());
    where.push(`category = $${values.length}`);
  }
  if (!includeInactive) {
    where.push("is_active = TRUE");
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const result = await pool.query(`SELECT id, category, label, display_order, is_active, created_at, updated_at
     FROM v_b_ticket_solution_catalog
     ${whereSql}
     ORDER BY category ASC, display_order ASC, label ASC`, values);
  return (result.rows || []).map(mapCatalogRow);
}
export async function createSolutionCatalogEntry({
  category,
  label,
  displayOrder = 0,
  isActive = true
} = {}) {
  await ensureTicketSolutionCatalogSchema();
  const normalizedCategory = String(category || "").trim();
  const normalizedLabel = String(label || "").trim();
  if (!["intervention", "action"].includes(normalizedCategory)) {
    const err = new Error("INVALID_CATEGORY");
    throw err;
  }
  if (!normalizedLabel) {
    const err = new Error("LABEL_REQUIRED");
    throw err;
  }
  const result = await pool.query(`INSERT INTO v_b_ticket_solution_catalog (category, label, display_order, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, category, label, display_order, is_active, created_at, updated_at`, [normalizedCategory, normalizedLabel, Number(displayOrder) || 0, isActive !== false]);
  return mapCatalogRow(result.rows[0]);
}
export async function updateSolutionCatalogEntry(id, patch = {}) {
  await ensureTicketSolutionCatalogSchema();
  const updates = [];
  const values = [];
  let idx = 1;
  if (Object.prototype.hasOwnProperty.call(patch, "label")) {
    const label = String(patch.label || "").trim();
    if (!label) {
      const err = new Error("LABEL_REQUIRED");
      throw err;
    }
    updates.push(`label = $${idx++}`);
    values.push(label);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "displayOrder")) {
    updates.push(`display_order = $${idx++}`);
    values.push(Number(patch.displayOrder) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "isActive")) {
    updates.push(`is_active = $${idx++}`);
    values.push(patch.isActive !== false);
  }
  if (updates.length === 0) {
    const err = new Error("NO_CHANGES");
    throw err;
  }
  updates.push("updated_at = NOW()");
  values.push(id);
  const result = await pool.query(`UPDATE v_b_ticket_solution_catalog
     SET ${updates.join(", ")}
     WHERE id = $${idx}
     RETURNING id, category, label, display_order, is_active, created_at, updated_at`, values);
  return mapCatalogRow(result.rows[0] || null);
}
export async function deleteSolutionCatalogEntry(id) {
  await ensureTicketSolutionCatalogSchema();
  const result = await pool.query(`DELETE FROM v_b_ticket_solution_catalog WHERE id = $1 RETURNING id`, [id]);
  return Boolean(result.rows[0]);
}
