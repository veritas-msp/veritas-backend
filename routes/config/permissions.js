import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import {
  PERMISSION_CATALOG,
  PERMISSION_ACTION_LABELS,
  ALL_PERMISSION_KEYS,
  VIEW_PERMISSION_TO_MODULE_FLAG,
  permissionKey,
  isValidPermissionKey,
} from "../../config/permissionCatalog.js";
import { isAdminPresetProfile } from "../../config/permissionPresets.js";
import {
  getUserPermissions,
  getProfilePermissions,
  invalidateProfilePermissions,
} from "../../services/permissionService.js";
import { ensurePermissionsSchema } from "../../services/ensurePermissionsSchema.js";

const router = express.Router();

router.use(verifyJWT);

/**
 * Derive *_enabled columns from granted *.view permissions.
 * Multiple views may share one flag → logical OR.
 */
function moduleFlagsFromGranted(grantedSet) {
  const flags = {};
  for (const [viewKey, flag] of Object.entries(VIEW_PERMISSION_TO_MODULE_FLAG)) {
    if (!flags[flag]) flags[flag] = false;
    if (grantedSet.has(viewKey)) flags[flag] = true;
  }
  return flags;
}

async function syncModuleFlags(client, profileName, grantedSet) {
  const flags = moduleFlagsFromGranted(grantedSet);
  const entries = Object.entries(flags);
  if (entries.length === 0) return;
  const sets = entries.map(([col], idx) => `${col} = $${idx + 2}`);
  const params = [profileName, ...entries.map(([, v]) => v)];
  await client.query(
    `UPDATE v_b_users_profiles SET ${sets.join(", ")} WHERE name = $1`,
    params
  );
}

// ── Permission catalog (structure for the UI matrix) ────────────────────
router.get("/catalog", requireRole("admin"), (req, res) => {
  const catalog = PERMISSION_CATALOG.map((group) => ({
    group: group.group,
    label: group.label,
    section: group.section || "autres",
    adminOnly: Boolean(group.adminOnly),
    actions: group.actions.map((action) => ({
      action,
      key: permissionKey(group.group, action),
      label: group.actionLabels?.[action] || PERMISSION_ACTION_LABELS[action] || action,
    })),
  }));
  res.json({ catalog, actionLabels: PERMISSION_ACTION_LABELS });
});

// ── Effective permissions for the current user (for the frontend) ───────
router.get("/me", async (req, res) => {
  try {
    // Do not call ensurePermissionsSchema here: too heavy on login.
    // getUserPermissions applies standard presets when the matrix is empty.
    const perms = await getUserPermissions(req.user);
    res.json({
      isAdmin: String(req.user.role || "").toLowerCase() === "admin",
      permissions: Array.from(perms),
    });
  } catch (err) {
    console.error("[permissions] /me échec:", err.message);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ── Profile matrix (all keys → boolean) ────────────────────────────────
router.get("/profiles/:name", requireRole("admin"), async (req, res) => {
  const name = String(req.params.name || "").trim();
  if (!name) return res.status(400).json({ error: "Nom de profil requis." });
  try {
    await ensurePermissionsSchema();
    const granted = await getProfilePermissions(name);
    const permissions = {};
    for (const key of ALL_PERMISSION_KEYS) {
      permissions[key] = granted.has(key);
    }
    res.json({ name, permissions });
  } catch (err) {
    console.error("[permissions] lecture profil échec:", err.message);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ── Update a profile permission matrix ──────────────────────────────────
router.put("/profiles/:name", requireRole("admin"), async (req, res) => {
  const name = String(req.params.name || "").trim();
  if (!name) return res.status(400).json({ error: "Nom de profil requis." });

  if (isAdminPresetProfile(name)) {
    return res.status(403).json({
      error: "Le profil Administrateur conserve un accès total non modifiable.",
      code: "PROTECTED_PROFILE",
    });
  }

  const input = req.body?.permissions;
  if (!input || typeof input !== "object") {
    return res.status(400).json({ error: "Champ 'permissions' requis (objet clé → booléen)." });
  }

  const grantedSet = Array.isArray(input)
    ? new Set(input.filter(isValidPermissionKey))
    : new Set(
        Object.entries(input)
          .filter(([k, v]) => isValidPermissionKey(k) && Boolean(v))
          .map(([k]) => k)
      );

  const client = await pool.connect();
  try {
    const profileExists = await client.query(
      `SELECT 1 FROM v_b_users_profiles WHERE name = $1 LIMIT 1`,
      [name]
    );
    if (profileExists.rows.length === 0) {
      return res.status(404).json({ error: "Profil non trouvé." });
    }

    await client.query("BEGIN");
    await client.query(`DELETE FROM v_b_profile_permissions WHERE profile_name = $1`, [name]);

    const values = [];
    const params = [];
    let i = 1;
    for (const key of ALL_PERMISSION_KEYS) {
      values.push(`($${i++}, $${i++}, $${i++})`);
      params.push(name, key, grantedSet.has(key));
    }
    await client.query(
      `INSERT INTO v_b_profile_permissions (profile_name, permission_key, allowed)
       VALUES ${values.join(", ")}`,
      params
    );

    await syncModuleFlags(client, name, grantedSet);

    await client.query("COMMIT");

    invalidateProfilePermissions(name);
    res.json({ success: true, granted: Array.from(grantedSet) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[permissions] écriture profil échec:", err.message);
    res.status(500).json({ error: "Erreur lors de l'enregistrement des permissions." });
  } finally {
    client.release();
  }
});

export default router;
