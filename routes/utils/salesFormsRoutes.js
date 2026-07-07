import express from "express";
import { body, param, query, validationResult } from "express-validator";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import {
  getUserTeamIds,
  hasAssignmentTargets,
  loadAssignmentsByFormIds,
  mapFormAssignments,
  syncFormAssignments,
  userCanAccessForm,
} from "../../services/salesFormAssignments.js";
import { normalizeTicketTargetsConfig, parseTicketTargetsFromRow } from "../../services/salesFormTicketTargets.js";
import { normalizeVisibilityRules } from "../../services/salesFormConditions.js";

const router = express.Router();
router.use(verifyJWT);

const SALES_KINDS = new Set(["prestation", "installation"]);
const FIELD_TYPES = new Set(["text", "textarea", "select", "checkbox", "user", "number", "date"]);
const VISIBILITY_VALUES = new Set(["public", "assigned"]);

function validationErrorOrNull(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: errors.array()[0]?.msg || "Données invalides", details: errors.array() });
    return true;
  }
  return false;
}

function isAdminUser(req) {
  return String(req.user?.role || "").toLowerCase() === "admin";
}

async function getUserProfileName(userId) {
  if (!userId) return null;
  const result = await pool.query(`SELECT profile FROM v_b_users WHERE id = $1`, [userId]);
  return result.rows[0]?.profile || null;
}

function slugifyCategory(kind, formKey) {
  const safeKey = String(formKey || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${kind}-${safeKey}`;
}

function normalizeVisibility(value) {
  const v = String(value || "public");
  return VISIBILITY_VALUES.has(v) ? v : "public";
}

function extractAssignmentsFromBody(body = {}, fallback = {}) {
  return {
    profileNames: body.profileNames !== undefined ? body.profileNames : fallback.profileNames || [],
    userIds: body.userIds !== undefined ? body.userIds : fallback.userIds || [],
    teamIds: body.teamIds !== undefined ? body.teamIds : fallback.teamIds || [],
  };
}

function mapFormRow(row, fields = [], assignments = null) {
  if (!row) return null;
  const mapped = {
    id: row.id,
    kind: row.kind,
    key: row.form_key,
    label: row.label,
    icon: row.icon,
    categorySlug: row.category_slug,
    description: row.description || "",
    displayOrder: Number(row.display_order || 0),
    enabled: row.enabled !== false,
    visibility: normalizeVisibility(row.visibility),
    ticketTargets: parseTicketTargetsFromRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fields: fields.map(mapFieldRow).filter(Boolean),
  };
  if (assignments) {
    Object.assign(mapped, mapFormAssignments(assignments));
  }
  return mapped;
}

function mapFieldRow(row) {
  if (!row) return null;
  let options = row.options;
  if (typeof options === "string") {
    try {
      options = JSON.parse(options);
    } catch {
      options = [];
    }
  }
  let visibilityRules = row.visibility_rules;
  if (typeof visibilityRules === "string") {
    try {
      visibilityRules = JSON.parse(visibilityRules);
    } catch {
      visibilityRules = {};
    }
  }
  return {
    id: row.id,
    formId: row.form_id,
    fieldKey: row.field_key,
    label: row.label,
    fieldType: row.field_type,
    required: row.required === true,
    placeholder: row.placeholder || "",
    options: Array.isArray(options) ? options : [],
    visibilityRules: normalizeVisibilityRules(visibilityRules),
    displayOrder: Number(row.display_order || 0),
    enabled: row.enabled !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadFormsWithFields({
  kind,
  includeDisabled = false,
  userId = null,
  userProfileName = null,
  userTeamIds = [],
  skipVisibilityFilter = false,
  includeAssignments = false,
} = {}) {
  const values = [];
  const where = [];
  let joinSql = "";

  if (kind) {
    values.push(kind);
    where.push(`d.kind = $${values.length}`);
  }
  if (!includeDisabled) {
    where.push("d.enabled = TRUE");
  }

  if (!skipVisibilityFilter && userId) {
    values.push(userId, userProfileName);
    const userIdx = values.length - 1;
    const profileIdx = values.length;
    joinSql = `
      LEFT JOIN v_b_sales_form_profiles fp ON fp.form_id = d.id
      LEFT JOIN v_b_sales_form_users fu ON fu.form_id = d.id
      LEFT JOIN v_b_sales_form_teams ft ON ft.form_id = d.id
      LEFT JOIN v_b_team_members tm ON tm.team_id = ft.team_id AND tm.user_id = $${userIdx}`;
    where.push(`(
      d.visibility = 'public'
      OR (
        d.visibility = 'assigned'
        AND (
          fp.profile_name = $${profileIdx}
          OR fu.user_id = $${userIdx}
          OR tm.user_id IS NOT NULL
        )
      )
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const distinctSql = !skipVisibilityFilter && userId ? "DISTINCT" : "";
  const formsResult = await pool.query(
    `SELECT ${distinctSql} d.*
     FROM v_b_sales_form_definitions d
     ${joinSql}
     ${whereSql}
     ORDER BY d.kind ASC, d.display_order ASC, d.label ASC`,
    values
  );
  const forms = formsResult.rows || [];
  if (forms.length === 0) return [];

  const formIds = forms.map((row) => row.id);
  const fieldsResult = await pool.query(
    `SELECT f.*
     FROM v_b_sales_form_fields f
     WHERE f.form_id = ANY($1::text[])
       ${includeDisabled ? "" : "AND f.enabled = TRUE"}
     ORDER BY f.display_order ASC, f.label ASC`,
    [formIds]
  );
  const fieldsByForm = new Map();
  (fieldsResult.rows || []).forEach((field) => {
    const list = fieldsByForm.get(field.form_id) || [];
    list.push(field);
    fieldsByForm.set(field.form_id, list);
  });

  let assignmentMap = {};
  if (includeAssignments) {
    assignmentMap = await loadAssignmentsByFormIds(formIds);
  }

  return forms.map((form) =>
    mapFormRow(form, fieldsByForm.get(form.id) || [], includeAssignments ? assignmentMap[String(form.id)] : null)
  );
}

async function loadFormById(formId, { includeDisabledFields = true, includeAssignments = false } = {}) {
  const formResult = await pool.query(`SELECT * FROM v_b_sales_form_definitions WHERE id = $1`, [formId]);
  if (!formResult.rows.length) return null;
  const fieldsResult = await pool.query(
    `SELECT *
     FROM v_b_sales_form_fields
     WHERE form_id = $1
       ${includeDisabledFields ? "" : "AND enabled = TRUE"}
     ORDER BY display_order ASC, label ASC`,
    [formId]
  );
  let assignments = null;
  if (includeAssignments) {
    const assignmentMap = await loadAssignmentsByFormIds([formId]);
    assignments = assignmentMap[String(formId)] || null;
  }
  return mapFormRow(formResult.rows[0], fieldsResult.rows || [], assignments);
}

async function assertUserCanAccessForm(req, res, formRow) {
  if (!formRow) {
    res.status(404).json({ error: "Formulaire introuvable" });
    return false;
  }
  if (isAdminUser(req) && (req.query?.includeDisabled === "true" || req.query?.includeDisabled === true)) {
    return true;
  }
  const visibility = normalizeVisibility(formRow.visibility);
  if (visibility === "public") return true;
  const userId = req.user?.id;
  const userProfileName = await getUserProfileName(userId);
  const userTeamIds = await getUserTeamIds(userId);
  const assignmentMap = await loadAssignmentsByFormIds([formRow.id]);
  const assignments = assignmentMap[String(formRow.id)];
  if (userCanAccessForm({ visibility }, assignments, userId, userProfileName, userTeamIds)) return true;
  res.status(403).json({ error: "Accès refusé à ce formulaire" });
  return false;
}

router.get(
  "/",
  verifyJWT,
  [query("kind").optional().isIn(["prestation", "installation"]), query("includeDisabled").optional().isBoolean()],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;
    try {
      const kind = req.query?.kind ? String(req.query.kind) : "";
      const includeDisabled = req.query?.includeDisabled === "true" || req.query?.includeDisabled === true;
      const isAdmin = isAdminUser(req);
      const userId = req.user?.id;
      const userProfileName = await getUserProfileName(userId);
      const userTeamIds = await getUserTeamIds(userId);

      const rows = await loadFormsWithFields({
        kind: kind || undefined,
        includeDisabled: includeDisabled && isAdmin,
        userId: includeDisabled && isAdmin ? null : userId,
        userProfileName,
        userTeamIds,
        skipVisibilityFilter: includeDisabled && isAdmin,
        includeAssignments: includeDisabled && isAdmin,
      });
      return res.json(rows);
    } catch (err) {
      console.error("Erreur chargement formulaires ventes:", err);
      return res.status(500).json({ error: "Erreur lors du chargement des formulaires ventes" });
    }
  }
);

router.get("/:formId", verifyJWT, [param("formId").isString().notEmpty()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const formId = String(req.params.formId);
    const raw = await pool.query(`SELECT * FROM v_b_sales_form_definitions WHERE id = $1`, [formId]);
    if (!(await assertUserCanAccessForm(req, res, raw.rows[0]))) return;
    const form = await loadFormById(formId, {
      includeDisabledFields: isAdminUser(req),
      includeAssignments: isAdminUser(req),
    });
    return res.json(form);
  } catch (err) {
    console.error("Erreur chargement formulaire vente:", err);
    return res.status(500).json({ error: "Erreur lors du chargement du formulaire" });
  }
});

router.post(
  "/",
  verifyJWT,
  [
    body("kind").isIn(["prestation", "installation"]),
    body("key").isString().notEmpty(),
    body("label").isString().notEmpty(),
    body("icon").optional().isString(),
    body("categorySlug").optional().isString(),
    body("description").optional().isString(),
    body("displayOrder").optional().isInt(),
    body("enabled").optional().isBoolean(),
    body("visibility").optional().isIn(["public", "assigned"]),
    body("profileNames").optional().isArray(),
    body("userIds").optional().isArray(),
    body("teamIds").optional().isArray(),
    body("ticketTargets").optional().isObject(),
  ],
  async (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: "Accès réservé aux administrateurs" });
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;
    try {
      const kind = String(req.body.kind);
      const formKey = String(req.body.key || "").trim();
      const label = String(req.body.label || "").trim();
      const icon = String(req.body.icon || "mdi:file-document-outline").trim();
      const categorySlug = String(req.body.categorySlug || slugifyCategory(kind, formKey)).trim();
      const description = String(req.body.description || "").trim();
      const displayOrder = Number.isFinite(Number(req.body.displayOrder)) ? Number(req.body.displayOrder) : 0;
      const enabled = req.body.enabled !== false;
      const visibility = normalizeVisibility(req.body.visibility);
      const ticketTargets = normalizeTicketTargetsConfig(req.body.ticketTargets);
      const assignments = extractAssignmentsFromBody(req.body);
      if (visibility === "assigned" && !hasAssignmentTargets(assignments)) {
        return res.status(400).json({ error: "Sélectionnez au moins un profil, utilisateur ou équipe" });
      }
      const id = `sales-form-${kind}-${formKey}-${Date.now().toString(36)}`;
      const result = await pool.query(
        `INSERT INTO v_b_sales_form_definitions
          (id, kind, form_key, label, icon, category_slug, description, display_order, enabled, visibility, ticket_targets, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW(), NOW())
         RETURNING *`,
        [id, kind, formKey, label, icon, categorySlug, description, displayOrder, enabled, visibility, JSON.stringify(ticketTargets)]
      );
      if (visibility === "assigned") {
        await syncFormAssignments(id, assignments);
      }
      const form = await loadFormById(id, { includeDisabledFields: true, includeAssignments: true });
      return res.status(201).json(form);
    } catch (err) {
      if (String(err?.code) === "23505") {
        return res.status(409).json({ error: "Un formulaire avec cette clé ou catégorie existe déjà" });
      }
      console.error("Erreur création formulaire vente:", err);
      return res.status(500).json({ error: "Erreur lors de la création du formulaire" });
    }
  }
);

router.put(
  "/:formId",
  verifyJWT,
  [
    param("formId").isString().notEmpty(),
    body("kind").optional().isIn(["prestation", "installation"]),
    body("key").optional().isString(),
    body("label").optional().isString(),
    body("icon").optional().isString(),
    body("categorySlug").optional().isString(),
    body("description").optional().isString(),
    body("displayOrder").optional().isInt(),
    body("enabled").optional().isBoolean(),
    body("visibility").optional().isIn(["public", "assigned"]),
    body("profileNames").optional().isArray(),
    body("userIds").optional().isArray(),
    body("teamIds").optional().isArray(),
    body("ticketTargets").optional().isObject(),
  ],
  async (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: "Accès réservé aux administrateurs" });
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;
    try {
      const formId = String(req.params.formId);
      const existing = await pool.query(`SELECT * FROM v_b_sales_form_definitions WHERE id = $1`, [formId]);
      if (!existing.rows.length) return res.status(404).json({ error: "Formulaire introuvable" });

      const updates = [];
      const values = [];
      let idx = 1;
      const patchMap = {
        kind: "kind",
        key: "form_key",
        label: "label",
        icon: "icon",
        categorySlug: "category_slug",
        description: "description",
        displayOrder: "display_order",
        enabled: "enabled",
        visibility: "visibility",
      };
      Object.entries(patchMap).forEach(([bodyKey, column]) => {
        if (!Object.prototype.hasOwnProperty.call(req.body, bodyKey)) return;
        let value = req.body[bodyKey];
        if (bodyKey === "key" || bodyKey === "label" || bodyKey === "icon" || bodyKey === "categorySlug" || bodyKey === "description") {
          value = String(value || "").trim();
        }
        if (bodyKey === "displayOrder") value = Number(value || 0);
        if (bodyKey === "enabled") value = value !== false;
        if (bodyKey === "visibility") value = normalizeVisibility(value);
        updates.push(`${column} = $${idx++}`);
        values.push(value);
      });

      if (Object.prototype.hasOwnProperty.call(req.body, "ticketTargets")) {
        updates.push(`ticket_targets = $${idx++}::jsonb`);
        values.push(JSON.stringify(normalizeTicketTargetsConfig(req.body.ticketTargets)));
      }

      const hasAssignmentPatch =
        Object.prototype.hasOwnProperty.call(req.body, "profileNames")
        || Object.prototype.hasOwnProperty.call(req.body, "userIds")
        || Object.prototype.hasOwnProperty.call(req.body, "teamIds");
      const nextVisibility = Object.prototype.hasOwnProperty.call(req.body, "visibility")
        ? normalizeVisibility(req.body.visibility)
        : normalizeVisibility(existing.rows[0].visibility);
      const assignmentMap = await loadAssignmentsByFormIds([formId]);
      const nextAssignments = hasAssignmentPatch
        ? extractAssignmentsFromBody(req.body)
        : assignmentMap[String(formId)] || {};

      if (updates.length === 0 && !hasAssignmentPatch) {
        return res.status(400).json({ error: "Aucun champ à mettre à jour" });
      }
      if (nextVisibility === "assigned" && !hasAssignmentTargets(nextAssignments)) {
        return res.status(400).json({ error: "Sélectionnez au moins un profil, utilisateur ou équipe" });
      }

      if (updates.length > 0) {
        updates.push("updated_at = NOW()");
        values.push(formId);
        await pool.query(
          `UPDATE v_b_sales_form_definitions SET ${updates.join(", ")} WHERE id = $${idx}`,
          values
        );
      }

      if (nextVisibility === "assigned") {
        await syncFormAssignments(formId, nextAssignments);
      } else if (
        Object.prototype.hasOwnProperty.call(req.body, "visibility")
        && nextVisibility === "public"
      ) {
        await syncFormAssignments(formId, { profileNames: [], userIds: [], teamIds: [] });
      }

      const form = await loadFormById(formId, { includeDisabledFields: true, includeAssignments: true });
      return res.json(form);
    } catch (err) {
      if (String(err?.code) === "23505") {
        return res.status(409).json({ error: "Conflit de clé ou catégorie" });
      }
      console.error("Erreur modification formulaire vente:", err);
      return res.status(500).json({ error: "Erreur lors de la modification du formulaire" });
    }
  }
);

router.delete("/:formId", verifyJWT, [param("formId").isString().notEmpty()], async (req, res) => {
  if (!isAdminUser(req)) return res.status(403).json({ error: "Accès réservé aux administrateurs" });
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const formId = String(req.params.formId);
    const result = await pool.query(`DELETE FROM v_b_sales_form_definitions WHERE id = $1`, [formId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Formulaire introuvable" });
    return res.json({ success: true });
  } catch (err) {
    console.error("Erreur suppression formulaire vente:", err);
    return res.status(500).json({ error: "Erreur lors de la suppression du formulaire" });
  }
});

router.post(
  "/:formId/fields",
  verifyJWT,
  [
    param("formId").isString().notEmpty(),
    body("fieldKey").isString().notEmpty(),
    body("label").isString().notEmpty(),
    body("fieldType").optional().isString(),
    body("required").optional().isBoolean(),
    body("placeholder").optional().isString(),
    body("options").optional().isArray(),
    body("visibilityRules").optional().isObject(),
    body("displayOrder").optional().isInt(),
    body("enabled").optional().isBoolean(),
  ],
  async (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: "Accès réservé aux administrateurs" });
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;
    try {
      const formId = String(req.params.formId);
      const formExists = await pool.query(`SELECT id FROM v_b_sales_form_definitions WHERE id = $1`, [formId]);
      if (!formExists.rows.length) return res.status(404).json({ error: "Formulaire introuvable" });

      const fieldKey = String(req.body.fieldKey || "").trim();
      const label = String(req.body.label || "").trim();
      const fieldType = FIELD_TYPES.has(String(req.body.fieldType)) ? String(req.body.fieldType) : "text";
      const required = req.body.required === true;
      const placeholder = String(req.body.placeholder || "").trim();
      const options = Array.isArray(req.body.options) ? req.body.options : [];
      const visibilityRules = normalizeVisibilityRules(req.body.visibilityRules);
      const displayOrder = Number.isFinite(Number(req.body.displayOrder)) ? Number(req.body.displayOrder) : 0;
      const enabled = req.body.enabled !== false;
      const id = `sales-field-${formId}-${fieldKey}-${Date.now().toString(36)}`;

      const result = await pool.query(
        `INSERT INTO v_b_sales_form_fields
          (id, form_id, field_key, label, field_type, required, placeholder, options, visibility_rules, display_order, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, NOW(), NOW())
         RETURNING *`,
        [
          id,
          formId,
          fieldKey,
          label,
          fieldType,
          required,
          placeholder,
          JSON.stringify(options),
          JSON.stringify(visibilityRules),
          displayOrder,
          enabled,
        ]
      );
      return res.status(201).json(mapFieldRow(result.rows[0]));
    } catch (err) {
      if (String(err?.code) === "23505") {
        return res.status(409).json({ error: "Un champ avec cette clé existe déjà sur ce formulaire" });
      }
      console.error("Erreur création champ formulaire vente:", err);
      return res.status(500).json({ error: "Erreur lors de la création du champ" });
    }
  }
);

router.put(
  "/:formId/fields/:fieldId",
  verifyJWT,
  [
    param("formId").isString().notEmpty(),
    param("fieldId").isString().notEmpty(),
    body("fieldKey").optional().isString(),
    body("label").optional().isString(),
    body("fieldType").optional().isString(),
    body("required").optional().isBoolean(),
    body("placeholder").optional().isString(),
    body("options").optional().isArray(),
    body("visibilityRules").optional().isObject(),
    body("displayOrder").optional().isInt(),
    body("enabled").optional().isBoolean(),
  ],
  async (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: "Accès réservé aux administrateurs" });
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;
    try {
      const formId = String(req.params.formId);
      const fieldId = String(req.params.fieldId);
      const updates = [];
      const values = [];
      let idx = 1;
      const patchMap = {
        fieldKey: "field_key",
        label: "label",
        fieldType: "field_type",
        required: "required",
        placeholder: "placeholder",
        displayOrder: "display_order",
        enabled: "enabled",
      };
      Object.entries(patchMap).forEach(([bodyKey, column]) => {
        if (!Object.prototype.hasOwnProperty.call(req.body, bodyKey)) return;
        let value = req.body[bodyKey];
        if (bodyKey === "fieldType" && !FIELD_TYPES.has(String(value))) return;
        if (bodyKey === "required" || bodyKey === "enabled") value = value === true;
        if (bodyKey === "displayOrder") value = Number(value || 0);
        if (typeof value === "string") value = value.trim();
        updates.push(`${column} = $${idx++}`);
        values.push(value);
      });
      if (Object.prototype.hasOwnProperty.call(req.body, "options")) {
        updates.push(`options = $${idx++}::jsonb`);
        values.push(JSON.stringify(Array.isArray(req.body.options) ? req.body.options : []));
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "visibilityRules")) {
        updates.push(`visibility_rules = $${idx++}::jsonb`);
        values.push(JSON.stringify(normalizeVisibilityRules(req.body.visibilityRules)));
      }
      if (updates.length === 0) return res.status(400).json({ error: "Aucun champ à mettre à jour" });
      updates.push("updated_at = NOW()");
      values.push(fieldId, formId);
      const result = await pool.query(
        `UPDATE v_b_sales_form_fields
         SET ${updates.join(", ")}
         WHERE id = $${idx++} AND form_id = $${idx}
         RETURNING *`,
        values
      );
      if (!result.rows.length) return res.status(404).json({ error: "Champ introuvable" });
      return res.json(mapFieldRow(result.rows[0]));
    } catch (err) {
      console.error("Erreur modification champ formulaire vente:", err);
      return res.status(500).json({ error: "Erreur lors de la modification du champ" });
    }
  }
);

router.delete(
  "/:formId/fields/:fieldId",
  verifyJWT,
  [param("formId").isString().notEmpty(), param("fieldId").isString().notEmpty()],
  async (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: "Accès réservé aux administrateurs" });
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;
    try {
      const result = await pool.query(
        `DELETE FROM v_b_sales_form_fields WHERE id = $1 AND form_id = $2`,
        [String(req.params.fieldId), String(req.params.formId)]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: "Champ introuvable" });
      return res.json({ success: true });
    } catch (err) {
      console.error("Erreur suppression champ formulaire vente:", err);
      return res.status(500).json({ error: "Erreur lors de la suppression du champ" });
    }
  }
);

export { loadFormsWithFields, mapFormRow, slugifyCategory, SALES_KINDS, FIELD_TYPES };
export default router;
