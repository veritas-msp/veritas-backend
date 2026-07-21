import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { isCommunity } from "../../utils/edition.js";
import { getProfileRow, resolveEffectiveProfile, profileHasChildren } from "../../services/profilePermissions.js";
import { ensureProfilesSchema } from "../../services/ensureProfilesSchema.js";
import { syncPermissionsFromModuleFlag } from "../../services/permissionService.js";
import { MODULE_FLAG_TO_GROUPS } from "../../config/permissionCatalog.js";
import { isSuperAdminPresetProfile } from "../../config/permissionPresets.js";
const router = express.Router();
router.use(verifyJWT);
function mapProfileRow(row) {
  if (!row) return null;
  return {
    name: row.name,
    label: row.label,
    parent_profile: row.parent_profile || null,
    monitoring_enabled: row.monitoring_enabled,
    infrastructure_enabled: row.infrastructure_enabled,
    cybersecurite_enabled: row.cybersecurite_enabled,
    planning_enabled: row.planning_enabled,
    service_enabled: row.service_enabled,
    contrat_enabled: row.contrat_enabled,
    contact_enabled: row.contact_enabled,
    configurateur_enabled: row.configurateur_enabled,
    tickets_enabled: row.tickets_enabled,
    dashboard_enabled: row.dashboard_enabled,
    documents_enabled: row.documents_enabled,
    display_order: row.display_order
  };
}
router.get("/:name", async (req, res) => {
  const {
    name
  } = req.params;
  await ensureProfilesSchema();
  if (!name) {
    return res.status(400).json({
      error: "Nom de profil required"
    });
  }
  try {
    const effective = await resolveEffectiveProfile(name);
    if (!effective) {
      return res.status(404).json({
        error: "Profile not found"
      });
    }
    res.json({
      name: effective.name,
      label: effective.label,
      parent_profile: effective.parent_profile || null,
      monitoring_enabled: effective.monitoring_enabled,
      infrastructure_enabled: effective.infrastructure_enabled,
      cybersecurite_enabled: effective.cybersecurite_enabled,
      planning_enabled: effective.planning_enabled,
      service_enabled: effective.service_enabled,
      contrat_enabled: effective.contrat_enabled,
      contact_enabled: effective.contact_enabled,
      configurateur_enabled: effective.configurateur_enabled,
      tickets_enabled: effective.tickets_enabled,
      dashboard_enabled: effective.dashboard_enabled,
      documents_enabled: effective.documents_enabled
    });
  } catch (err) {
    if (String(err.message || "").includes("Cycle")) {
      return res.status(500).json({
        error: err.message
      });
    }
    res.status(500).json({
      error: "Internal error retrieving profile."
    });
  }
});
router.patch("/:name", requireRole("admin"), async (req, res) => {
  const {
    name
  } = req.params;
  if (isSuperAdminPresetProfile(name)) {
    return res.status(403).json({
      error: "The Super Admin profile cannot be modified.",
      code: "PROTECTED_PROFILE"
    });
  }
  const {
    label,
    monitoring_enabled,
    infrastructure_enabled,
    cybersecurite_enabled,
    planning_enabled,
    service_enabled,
    tickets_enabled,
    configurateur_enabled,
    dashboard_enabled,
    documents_enabled
  } = req.body;
  try {
    if (isCommunity()) {
      const hasPermissionChanges = [monitoring_enabled, infrastructure_enabled, cybersecurite_enabled, planning_enabled, service_enabled, tickets_enabled, configurateur_enabled, dashboard_enabled, documents_enabled].some(value => value !== undefined);
      if (hasPermissionChanges) {
        return res.status(403).json({
          error: "Access rights customization — available with Veritas Pro.",
          code: "COMMUNITY_PROFILE_ACCESS"
        });
      }
      const result = await pool.query(`UPDATE v_b_users_profiles
         SET label = COALESCE($1, label)
         WHERE name = $2`, [label, name]);
      if (result.rowCount === 0) {
        return res.status(404).json({
          error: "Profile not found"
        });
      }
      return res.json({
        success: true
      });
    }
    const result = await pool.query(`UPDATE v_b_users_profiles
       SET label = COALESCE($1, label),
           monitoring_enabled = COALESCE($2, monitoring_enabled),
           infrastructure_enabled = COALESCE($3, infrastructure_enabled),
           cybersecurite_enabled = COALESCE($4, cybersecurite_enabled),
           planning_enabled = COALESCE($5, planning_enabled),
           service_enabled = COALESCE($6, service_enabled),
           contrat_enabled = TRUE,
           contact_enabled = TRUE,
           tickets_enabled = COALESCE($7, tickets_enabled),
           configurateur_enabled = COALESCE($8, configurateur_enabled),
           dashboard_enabled = COALESCE($9, dashboard_enabled),
           documents_enabled = COALESCE($10, documents_enabled)
       WHERE name = $11`, [label, monitoring_enabled, infrastructure_enabled, cybersecurite_enabled, planning_enabled, service_enabled, tickets_enabled, configurateur_enabled, dashboard_enabled, documents_enabled, name]);
    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Profile not found"
      });
    }
    const flagPayload = {
      monitoring_enabled,
      infrastructure_enabled,
      cybersecurite_enabled,
      planning_enabled,
      service_enabled,
      tickets_enabled,
      configurateur_enabled,
      dashboard_enabled,
      documents_enabled
    };
    for (const [flagKey, value] of Object.entries(flagPayload)) {
      if (value === undefined || !MODULE_FLAG_TO_GROUPS[flagKey]) continue;
      await syncPermissionsFromModuleFlag(name, flagKey, Boolean(value));
    }
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: "SQL error"
    });
  }
});
router.post("/", requireRole("admin"), async (req, res) => {
  if (isCommunity()) {
    return res.status(403).json({
      error: "Creating additional profiles — available with Veritas Pro.",
      code: "COMMUNITY_PROFILE_LIMIT"
    });
  }
  const {
    name,
    label,
    parentProfile,
    parent_profile,
    monitoring_enabled = false,
    infrastructure_enabled = false,
    cybersecurite_enabled = false,
    planning_enabled = false,
    service_enabled = false,
    contrat_enabled = true,
    contact_enabled = true,
    tickets_enabled = false,
    configurateur_enabled = false,
    dashboard_enabled = false,
    documents_enabled = false,
    display_order = 999
  } = req.body || {};
  const parentName = String(parentProfile || parent_profile || "").trim() || null;
  if (!name || !label) {
    return res.status(400).json({
      error: "Name and label required"
    });
  }
  if (isSuperAdminPresetProfile(name)) {
    return res.status(403).json({
      error: "The Super Admin profile name is reserved.",
      code: "PROTECTED_PROFILE"
    });
  }
  try {
    if (parentName) {
      const parent = await getProfileRow(parentName);
      if (!parent) {
        return res.status(400).json({
          error: `Profil parent « ${parentName} » not found`
        });
      }
      await pool.query(`INSERT INTO v_b_users_profiles
          (name, label, parent_profile,
           monitoring_enabled, infrastructure_enabled, cybersecurite_enabled,
           planning_enabled, service_enabled, contrat_enabled, contact_enabled,
           configurateur_enabled, tickets_enabled, dashboard_enabled, documents_enabled, display_order)
         SELECT
           $1, $2, $3,
           monitoring_enabled, infrastructure_enabled, cybersecurite_enabled,
           planning_enabled, service_enabled, TRUE, TRUE,
           configurateur_enabled, tickets_enabled, dashboard_enabled, documents_enabled,
           COALESCE($4, display_order)
         FROM v_b_users_profiles
         WHERE name = $3`, [String(name).trim(), String(label).trim(), parentName, Number(display_order) || 999]);
    } else {
      await pool.query(`INSERT INTO v_b_users_profiles
         (name, label, monitoring_enabled, infrastructure_enabled, cybersecurite_enabled, planning_enabled, service_enabled, contrat_enabled, contact_enabled, configurateur_enabled, tickets_enabled, dashboard_enabled, documents_enabled, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, TRUE, $8, $9, $10, $11, $12)`, [String(name).trim(), String(label).trim(), monitoring_enabled, infrastructure_enabled, cybersecurite_enabled, planning_enabled, service_enabled, configurateur_enabled, tickets_enabled, dashboard_enabled, documents_enabled, Number.isFinite(Number(display_order)) ? Number(display_order) : 999]);
    }
    res.status(201).json({
      success: true
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({
        error: "A profile with this name already exists"
      });
    }
    res.status(500).json({
      error: "Error creating profile",
      details: err.message
    });
  }
});
router.delete("/:name", requireRole("admin"), async (req, res) => {
  const {
    name
  } = req.params;
  if (!name) {
    return res.status(400).json({
      error: "Nom de profil required"
    });
  }
  if (isSuperAdminPresetProfile(name)) {
    return res.status(403).json({
      error: "The Super Admin profile cannot be deleted.",
      code: "PROTECTED_PROFILE"
    });
  }
  try {
    const usersUsingProfile = await pool.query(`SELECT COUNT(*)::int AS total
       FROM v_b_users
       WHERE profile = $1`, [name]);
    if ((usersUsingProfile.rows[0]?.total || 0) > 0) {
      return res.status(409).json({
        error: "This profile is still assigned to one or more users"
      });
    }
    if (await profileHasChildren(name)) {
      return res.status(409).json({
        error: "This profile is used as parent by other profiles"
      });
    }
    const result = await pool.query("DELETE FROM v_b_users_profiles WHERE name = $1", [name]);
    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Profile not found"
      });
    }
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: "Error deleting profile",
      details: err.message
    });
  }
});
router.get("/", async (req, res) => {
  try {
    await ensureProfilesSchema();
    const result = await pool.query(`SELECT name, label, parent_profile,
              monitoring_enabled, infrastructure_enabled, cybersecurite_enabled,
              planning_enabled, service_enabled, contrat_enabled, contact_enabled,
              configurateur_enabled, tickets_enabled, dashboard_enabled, documents_enabled, display_order
       FROM v_b_users_profiles
       ORDER BY display_order ASC, label ASC`);
    res.json(result.rows.map(mapProfileRow));
  } catch (err) {
    res.status(500).json({
      error: "Server error"
    });
  }
});
export default router;
