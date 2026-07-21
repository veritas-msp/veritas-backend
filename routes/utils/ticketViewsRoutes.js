import express from "express";
import { body, param, query, validationResult } from "express-validator";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { normalizeRules, validateViewRules } from "../../services/ticketViewRules.js";
import { ensureTicketViewsSchema } from "../../services/ensureTicketViewsSchema.js";
import { countTickets, countTicketsByStatus, resolveTicketListSchema } from "../../services/ticketPagedListService.js";
import { BUILTIN_TICKET_VIEWS, resolveBuiltinViewRules } from "../../utils/builtinTicketViews.js";
import { isCommunity } from "../../utils/edition.js";
import { loadAssignmentsByViewIds, syncViewAssignments, getUserTeamIds, isAssignedVisibility, hasAssignmentTargets, userCanAccessAssignedView, mapViewAssignments } from "../../services/ticketViewAssignments.js";
const router = express.Router();
router.use(verifyJWT);
function isAdminUser(req) {
  return String(req.user?.role || "").toLowerCase() === "admin";
}
function validationErrorOrNull(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      errors: errors.array()
    });
    return true;
  }
  return false;
}
async function getUserProfileName(userId) {
  if (!userId) return null;
  const result = await pool.query(`SELECT profile FROM v_b_users WHERE id = $1`, [userId]);
  return result.rows[0]?.profile || null;
}
function mapViewRow(row, assignments = {}) {
  if (!row) return null;
  const mappedAssignments = mapViewAssignments(assignments);
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    pageScope: row.page_scope,
    visibility: row.visibility === "profile" ? "assigned" : row.visibility,
    ownerUserId: row.owner_user_id,
    icon: row.icon || "mdi:view-list",
    color: row.color,
    rules: normalizeRules(row.rules),
    sortBy: row.sort_by || "updated_at",
    sortDirection: row.sort_direction || "desc",
    displayOrder: row.display_order ?? 0,
    isBuiltin: row.is_builtin === true,
    ...mappedAssignments
  };
}
async function getViewById(viewId) {
  const result = await pool.query(`SELECT * FROM v_b_ticket_views WHERE id = $1`, [viewId]);
  return result.rows[0] || null;
}
async function resolveViewRulesForCount(viewId, customViews = []) {
  const normalizedId = String(viewId || "").trim();
  if (!normalizedId) return null;
  const builtinRules = resolveBuiltinViewRules(normalizedId);
  if (builtinRules) return normalizeRules(builtinRules);
  if (normalizedId === "__satisfaction_mine__" || normalizedId === "__satisfaction_all__") {
    return null;
  }
  const fromList = customViews.find(view => String(view.id) === normalizedId);
  if (fromList?.rules) return normalizeRules(fromList.rules);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedId);
  if (!isUuid) return null;
  const viewRow = await getViewById(normalizedId);
  if (viewRow?.rules) return normalizeRules(viewRow.rules);
  return null;
}
function normalizeVisibility(value) {
  const v = String(value || "private");
  if (v === "profile") return "assigned";
  return v;
}
function extractAssignmentsFromBody(body = {}, fallback = {}) {
  return {
    profileNames: body.profileNames !== undefined ? body.profileNames : fallback.profileNames || [],
    userIds: body.userIds !== undefined ? body.userIds : fallback.userIds || [],
    teamIds: body.teamIds !== undefined ? body.teamIds : fallback.teamIds || []
  };
}
function canReadView(view, userId, userProfileName, assignments, userTeamIds) {
  if (!view) return false;
  if (view.visibility === "public") return true;
  if (isAssignedVisibility(view.visibility)) {
    return userCanAccessAssignedView(assignments, userId, userProfileName, userTeamIds);
  }
  return view.owner_user_id && String(view.owner_user_id) === String(userId);
}
function canWriteView(view, req) {
  if (!view) return false;
  if (view.is_builtin && !isAdminUser(req)) return false;
  if (isAssignedVisibility(view.visibility)) return isAdminUser(req);
  const isOwner = view.owner_user_id && String(view.owner_user_id) === String(req.user?.id);
  if (view.visibility === "public") return isAdminUser(req) || isOwner;
  return isOwner;
}
function canChangeViewVisibility(nextVisibility, view, req) {
  const normalizedNext = normalizeVisibility(nextVisibility);
  if (normalizedNext === "private") return true;
  if (isAdminUser(req)) return true;
  const isOwner = view.owner_user_id && String(view.owner_user_id) === String(req.user?.id);
  if (normalizedNext === "public" && normalizeVisibility(view.visibility) === "public" && isOwner) {
    return true;
  }
  return false;
}
router.get("/counts", verifyJWT, [query("pageScope").optional().isIn(["ticket", "ticket_sales"]), query("viewId").optional().isString(), query("search").optional().isString(), query("ticketType").optional().isString(), query("scope").optional().isIn(["all", "views", "statuses"])], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    const pageScope = String(req.query.pageScope || "ticket");
    const scope = String(req.query.scope || "all");
    if (pageScope !== "ticket") {
      return res.json({
        views: {},
        statuses: null
      });
    }
    const schema = await resolveTicketListSchema(pool, {
      isCommunityEdition: isCommunity
    });
    const userId = req.user?.id;
    const userProfileName = await getUserProfileName(userId);
    const userTeamIds = await getUserTeamIds(userId);
    let customViews = [];
    if (scope === "all" || scope === "views") {
      const result = await pool.query(`SELECT DISTINCT v.*
           FROM v_b_ticket_views v
           LEFT JOIN v_b_ticket_view_profiles vp ON vp.view_id = v.id
           LEFT JOIN v_b_ticket_view_users vu ON vu.view_id = v.id
           LEFT JOIN v_b_ticket_view_teams vt ON vt.view_id = v.id
           LEFT JOIN v_b_team_members tm ON tm.team_id = vt.team_id AND tm.user_id = $2
           WHERE v.page_scope = $1
             AND (
               v.visibility = 'public'
               OR (v.visibility = 'private' AND v.owner_user_id = $2)
               OR (
                 v.visibility IN ('profile', 'assigned')
                 AND (
                   vp.profile_name = $3
                   OR vu.user_id = $2
                   OR tm.user_id IS NOT NULL
                 )
               )
             )
           ORDER BY v.display_order ASC, v.name ASC`, [pageScope, userId, userProfileName]);
      customViews = (result.rows || []).map(row => ({
        id: row.id,
        rules: normalizeRules(row.rules)
      }));
    }
    let views = {};
    if (scope === "all" || scope === "views") {
      const viewsToCount = [...BUILTIN_TICKET_VIEWS.map(view => ({
        id: view.id,
        rules: view.rules
      })), ...customViews];
      const viewCountsResults = await Promise.allSettled(viewsToCount.map(async view => {
        const rules = normalizeRules(view.rules);
        const viewMode = rules.viewMode === "trash" ? "trash" : "active";
        const total = await countTickets(pool, {
          viewRules: rules,
          viewMode
        }, schema);
        return [String(view.id), total];
      }));
      views = Object.fromEntries(viewCountsResults.filter(result => result.status === "fulfilled").map(result => result.value));
    }
    let statuses = null;
    if (scope === "all" || scope === "statuses") {
      const viewId = String(req.query.viewId || "").trim();
      if (viewId) {
        const rules = await resolveViewRulesForCount(viewId, customViews);
        if (rules) {
          const viewMode = rules.viewMode === "trash" ? "trash" : "active";
          statuses = await countTicketsByStatus(pool, {
            viewRules: rules,
            viewMode,
            search: req.query.search || "",
            ticketType: req.query.ticketType || ""
          }, schema);
        }
      }
    }
    return res.json({
      views,
      statuses
    });
  } catch (err) {
    console.error("Failed to count ticket views:", err);
    return res.status(500).json({
      error: "Error during counting tickand views"
    });
  }
});
router.get("/admin", verifyJWT, [query("pageScope").optional().isIn(["ticket", "ticket_sales"])], async (req, res) => {
  if (!isAdminUser(req)) {
    return res.status(403).json({
      error: "Access restricted to administrators"
    });
  }
  if (validationErrorOrNull(req, res)) return;
  try {
    await ensureTicketViewsSchema();
    const pageScope = String(req.query.pageScope || "ticket");
    const result = await pool.query(`SELECT * FROM v_b_ticket_views
         WHERE page_scope = $1
         ORDER BY display_order ASC, name ASC`, [pageScope]);
    const rows = result.rows || [];
    const assignmentMap = await loadAssignmentsByViewIds(rows.map(r => r.id));
    return res.json(rows.map(row => mapViewRow(row, assignmentMap[String(row.id)])));
  } catch (err) {
    console.error("Failed to load admin ticket views:", err);
    return res.status(500).json({
      error: "Error loading ticket views"
    });
  }
});
router.get("/", verifyJWT, [query("pageScope").optional().isIn(["ticket", "ticket_sales"])], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    await ensureTicketViewsSchema();
    const pageScope = String(req.query.pageScope || "ticket");
    const userId = req.user?.id;
    const userProfileName = await getUserProfileName(userId);
    const userTeamIds = await getUserTeamIds(userId);
    const result = await pool.query(`SELECT DISTINCT v.*
         FROM v_b_ticket_views v
         LEFT JOIN v_b_ticket_view_profiles vp ON vp.view_id = v.id
         LEFT JOIN v_b_ticket_view_users vu ON vu.view_id = v.id
         LEFT JOIN v_b_ticket_view_teams vt ON vt.view_id = v.id
         LEFT JOIN v_b_team_members tm ON tm.team_id = vt.team_id AND tm.user_id = $2
         WHERE v.page_scope = $1
           AND (
             v.visibility = 'public'
             OR (v.visibility = 'private' AND v.owner_user_id = $2)
             OR (
               v.visibility IN ('profile', 'assigned')
               AND (
                 vp.profile_name = $3
                 OR vu.user_id = $2
                 OR tm.user_id IS NOT NULL
               )
             )
           )
         ORDER BY v.display_order ASC, v.name ASC`, [pageScope, userId, userProfileName]);
    const rows = result.rows || [];
    const assignmentMap = await loadAssignmentsByViewIds(rows.map(r => r.id));
    return res.json(rows.map(row => mapViewRow(row, assignmentMap[String(row.id)])));
  } catch (err) {
    console.error("Failed to load ticket views:", err);
    return res.status(500).json({
      error: "Error loading ticket views"
    });
  }
});
const viewBodyValidators = [body("name").optional().isString().trim().isLength({
  min: 1,
  max: 120
}), body("description").optional({
  nullable: true
}).isString(), body("pageScope").optional().isIn(["ticket", "ticket_sales"]), body("visibility").optional().isIn(["private", "public", "profile", "assigned"]), body("profileNames").optional().isArray(), body("userIds").optional().isArray(), body("teamIds").optional().isArray(), body("icon").optional().isString(), body("color").optional({
  nullable: true
}).isString(), body("rules").optional().isObject(), body("sortBy").optional().isString(), body("sortDirection").optional().isIn(["asc", "desc"]), body("displayOrder").optional().isInt()];
router.post("/", verifyJWT, [body("name").isString().trim().isLength({
  min: 1,
  max: 120
}), body("description").optional({
  nullable: true
}).isString(), body("pageScope").optional().isIn(["ticket", "ticket_sales"]), body("visibility").optional().isIn(["private", "public", "profile", "assigned"]), body("profileNames").optional().isArray(), body("userIds").optional().isArray(), body("teamIds").optional().isArray(), body("icon").optional().isString(), body("color").optional({
  nullable: true
}).isString(), body("rules").optional().isObject(), body("sortBy").optional().isString(), body("sortDirection").optional().isIn(["asc", "desc"]), body("displayOrder").optional().isInt()], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    const visibility = normalizeVisibility(req.body.visibility || "private");
    if ((visibility === "public" || visibility === "assigned") && !isAdminUser(req)) {
      return res.status(403).json({
        error: "Only administrators can create an assigned or public view"
      });
    }
    const assignments = extractAssignmentsFromBody(req.body);
    if (visibility === "assigned" && !hasAssignmentTargets(assignments)) {
      return res.status(400).json({
        error: "Select at least one user, profile or team for an assigned view"
      });
    }
    const rules = normalizeRules(req.body.rules);
    const rulesError = validateViewRules(rules);
    if (rulesError) return res.status(400).json({
      error: rulesError
    });
    const result = await pool.query(`INSERT INTO v_b_ticket_views
          (name, description, page_scope, visibility, owner_user_id, icon, color, rules, sort_by, sort_direction, display_order, is_builtin, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, FALSE, NOW(), NOW())
         RETURNING *`, [String(req.body.name).trim(), req.body.description ? String(req.body.description).trim() : null, String(req.body.pageScope || "ticket"), visibility, req.user?.id, String(req.body.icon || "mdi:view-list").trim(), req.body.color ? String(req.body.color).trim() : null, JSON.stringify(rules), String(req.body.sortBy || "updated_at"), String(req.body.sortDirection || "desc"), Number(req.body.displayOrder) || 0]);
    const created = result.rows[0];
    if (visibility === "assigned") {
      await syncViewAssignments(created.id, assignments);
    }
    const assignmentMap = await loadAssignmentsByViewIds([created.id]);
    return res.status(201).json(mapViewRow(created, assignmentMap[String(created.id)]));
  } catch (err) {
    console.error("Failed to create vue ticket:", err);
    return res.status(500).json({
      error: "Error creating view"
    });
  }
});
router.put("/:viewId", verifyJWT, [param("viewId").isUUID(), ...viewBodyValidators], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    const view = await getViewById(req.params.viewId);
    if (!view) return res.status(404).json({
      error: "View not found"
    });
    const userProfileName = await getUserProfileName(req.user?.id);
    const userTeamIds = await getUserTeamIds(req.user?.id);
    const existingMap = await loadAssignmentsByViewIds([view.id]);
    const existingAssignments = existingMap[String(view.id)] || {};
    if (!canReadView(view, req.user?.id, userProfileName, existingAssignments, userTeamIds)) {
      return res.status(403).json({
        error: "Access denied"
      });
    }
    if (!canWriteView(view, req)) return res.status(403).json({
      error: "Modification not allowed"
    });
    const nextVisibility = req.body.visibility !== undefined ? normalizeVisibility(req.body.visibility) : normalizeVisibility(view.visibility);
    if ((nextVisibility === "public" || nextVisibility === "assigned") && !canChangeViewVisibility(nextVisibility, view, req)) {
      return res.status(403).json({
        error: "Only administrators can publish a view"
      });
    }
    const assignments = extractAssignmentsFromBody(req.body, existingAssignments);
    if (nextVisibility === "assigned" && !hasAssignmentTargets(assignments)) {
      return res.status(400).json({
        error: "Select at least one user, profile or team for an assigned view"
      });
    }
    const rules = req.body.rules !== undefined ? normalizeRules(req.body.rules) : normalizeRules(view.rules);
    const rulesError = validateViewRules(rules);
    if (rulesError) return res.status(400).json({
      error: rulesError
    });
    const result = await pool.query(`UPDATE v_b_ticket_views SET
          name = COALESCE($2, name),
          description = COALESCE($3, description),
          visibility = COALESCE($4, visibility),
          icon = COALESCE($5, icon),
          color = COALESCE($6, color),
          rules = COALESCE($7::jsonb, rules),
          sort_by = COALESCE($8, sort_by),
          sort_direction = COALESCE($9, sort_direction),
          display_order = COALESCE($10, display_order),
          updated_at = NOW()
         WHERE id = $1
         RETURNING *`, [req.params.viewId, req.body.name !== undefined ? String(req.body.name).trim() : null, req.body.description !== undefined ? req.body.description ? String(req.body.description).trim() : null : null, req.body.visibility !== undefined ? nextVisibility : null, req.body.icon !== undefined ? String(req.body.icon).trim() : null, req.body.color !== undefined ? req.body.color ? String(req.body.color).trim() : null : null, req.body.rules !== undefined ? JSON.stringify(rules) : null, req.body.sortBy !== undefined ? String(req.body.sortBy) : null, req.body.sortDirection !== undefined ? String(req.body.sortDirection) : null, req.body.displayOrder !== undefined ? Number(req.body.displayOrder) : null]);
    const updated = result.rows[0];
    if (nextVisibility === "assigned") {
      await syncViewAssignments(updated.id, assignments);
    } else {
      await syncViewAssignments(updated.id, {
        profileNames: [],
        userIds: [],
        teamIds: []
      });
    }
    const assignmentMap = await loadAssignmentsByViewIds([updated.id]);
    return res.json(mapViewRow(updated, assignmentMap[String(updated.id)]));
  } catch (err) {
    console.error("Error updating tickand view:", err);
    return res.status(500).json({
      error: "Error updating view"
    });
  }
});
router.delete("/:viewId", verifyJWT, [param("viewId").isUUID()], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    const view = await getViewById(req.params.viewId);
    if (!view) return res.status(404).json({
      error: "View not found"
    });
    const userProfileName = await getUserProfileName(req.user?.id);
    const userTeamIds = await getUserTeamIds(req.user?.id);
    const existingMap = await loadAssignmentsByViewIds([view.id]);
    const existingAssignments = existingMap[String(view.id)] || {};
    if (!canReadView(view, req.user?.id, userProfileName, existingAssignments, userTeamIds)) {
      return res.status(403).json({
        error: "Access denied"
      });
    }
    if (!canWriteView(view, req)) return res.status(403).json({
      error: "Deletion not allowed"
    });
    await pool.query(`DELETE FROM v_b_ticket_views WHERE id = $1`, [req.params.viewId]);
    return res.status(204).send();
  } catch (err) {
    console.error("Failed to delete vue ticket:", err);
    return res.status(500).json({
      error: "Error deleting view"
    });
  }
});
export default router;
