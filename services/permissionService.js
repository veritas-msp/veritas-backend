import { pool } from "../database/db.js";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  MODULE_FLAG_TO_GROUPS,
  defaultPermissionsForProfile,
  permissionKey,
} from "../config/permissionCatalog.js";
import { getPresetForProfile } from "../config/permissionPresets.js";
import { resolveEffectiveProfile } from "./profilePermissions.js";

const ALL_PERMISSIONS_SET = new Set(ALL_PERMISSION_KEYS);

// In-memory cache: profile → { perms:Set, expires:number }
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

export function invalidateProfilePermissions(name) {
  if (name) cache.delete(String(name));
  else cache.clear();
}

export function invalidateAllPermissions() {
  cache.clear();
}

function hasAnyViewPermission(perms) {
  for (const key of perms) {
    if (String(key).endsWith(".view")) return true;
  }
  return false;
}

/** Persists a full permission matrix for a profile. */
async function persistProfileMatrix(name, grantedSet) {
  const client = await pool.connect();
  try {
    const values = [];
    const params = [];
    let i = 1;
    for (const key of ALL_PERMISSION_KEYS) {
      values.push(`($${i++}, $${i++}, $${i++})`);
      params.push(name, key, grantedSet.has(key));
    }
    await client.query(`DELETE FROM v_b_profile_permissions WHERE profile_name = $1`, [name]);
    await client.query(
      `INSERT INTO v_b_profile_permissions (profile_name, permission_key, allowed)
       VALUES ${values.join(", ")}`,
      params
    );
  } finally {
    client.release();
  }
}

/**
 * Permissions granted to a profile (keys with allowed = TRUE).
 * Fallback:
 *  - no rows → standard preset, otherwise *_enabled flags
 *  - standard profile with no *.view → reapply preset (broken matrix)
 */
export async function getProfilePermissions(profileName) {
  const name = String(profileName || "").trim();
  if (!name) return new Set();

  const cached = cache.get(name);
  if (cached && cached.expires > Date.now()) return cached.perms;

  let perms;
  try {
    const { rows } = await pool.query(
      `SELECT permission_key, allowed FROM v_b_profile_permissions WHERE profile_name = $1`,
      [name]
    );

    const preset = getPresetForProfile(name);

    if (rows.length === 0) {
      if (preset) {
        perms = preset;
        persistProfileMatrix(name, preset).catch((err) =>
          console.warn("[permissions] Persist preset failed:", err.message)
        );
      } else {
        const effective = await resolveEffectiveProfile(name);
        perms = effective ? defaultPermissionsForProfile(effective) : new Set();
      }
    } else {
      perms = new Set(rows.filter((r) => r.allowed).map((r) => r.permission_key));
      if (preset && !hasAnyViewPermission(perms)) {
        perms = preset;
        persistProfileMatrix(name, preset).catch((err) =>
          console.warn("[permissions] Heal preset failed:", err.message)
        );
      }
    }
  } catch (err) {
    console.error("[permissions] Profile resolution failed:", err.message);
    perms = new Set();
  }

  cache.set(name, { perms, expires: Date.now() + CACHE_TTL_MS });
  return perms;
}

/** Resolves a user's profile name (DB first — JWT may be stale after profile change). */
async function resolveUserProfileName(user) {
  if (user?.id) {
    try {
      const { rows } = await pool.query(`SELECT profile FROM v_b_users WHERE id = $1`, [user.id]);
      if (rows[0]?.profile) return String(rows[0].profile);
    } catch {
      /* fall through to JWT claim */
    }
  }
  return user?.profile ? String(user.profile) : null;
}

/**
 * Set of a user's effective permissions.
 * Admin bypasses everything (non-configurable super-admin).
 */
export async function getUserPermissions(user) {
  if (!user) return new Set();
  if (String(user.role || "").toLowerCase() === "admin") {
    return ALL_PERMISSIONS_SET;
  }
  const profileName = await resolveUserProfileName(user);
  if (!profileName) return new Set();
  return getProfilePermissions(profileName);
}

/** Checks that a user has ALL requested keys. */
export async function userHasAllPermissions(user, keys) {
  if (String(user?.role || "").toLowerCase() === "admin") return true;
  const perms = await getUserPermissions(user);
  return keys.every((k) => perms.has(k));
}

/** Checks that a user has AT LEAST ONE of the requested keys. */
export async function userHasAnyPermission(user, keys) {
  if (String(user?.role || "").toLowerCase() === "admin") return true;
  const perms = await getUserPermissions(user);
  return keys.some((k) => perms.has(k));
}

/**
 * After toggling an `*_enabled` flag (Access tab): aligns the RBAC matrix.
 * - flag ON  → grant *.view only for linked groups (does not escalate to CRUD)
 * - flag OFF → revoke all actions for linked groups
 * Fine-grained create/edit/delete/manage stay on Administration → Permissions.
 */
export async function syncPermissionsFromModuleFlag(profileName, flagKey, enabled) {
  const name = String(profileName || "").trim();
  const groups = MODULE_FLAG_TO_GROUPS[flagKey];
  if (!name || !groups?.length) return;

  const allKeys = [];
  const viewKeys = [];
  for (const groupName of groups) {
    const group = PERMISSION_CATALOG.find((g) => g.group === groupName);
    if (!group || group.adminOnly) continue;
    for (const action of group.actions) {
      const key = permissionKey(group.group, action);
      allKeys.push(key);
      if (action === "view") viewKeys.push(key);
    }
  }
  if (allKeys.length === 0) return;

  const keysToUpsert = enabled ? viewKeys : allKeys;
  if (keysToUpsert.length === 0) return;

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM v_b_profile_permissions WHERE profile_name = $1 LIMIT 1`,
      [name]
    );

    if (rows.length === 0) {
      const preset = getPresetForProfile(name);
      const effective = await resolveEffectiveProfile(name);
      const granted = preset
        ? new Set(preset)
        : effective
          ? defaultPermissionsForProfile(effective)
          : new Set();
      if (enabled) {
        for (const key of viewKeys) granted.add(key);
      } else {
        for (const key of allKeys) granted.delete(key);
      }
      const values = [];
      const params = [];
      let i = 1;
      for (const key of ALL_PERMISSION_KEYS) {
        values.push(`($${i++}, $${i++}, $${i++})`);
        params.push(name, key, granted.has(key));
      }
      await client.query(
        `INSERT INTO v_b_profile_permissions (profile_name, permission_key, allowed)
         VALUES ${values.join(", ")}`,
        params
      );
    } else {
      for (const key of keysToUpsert) {
        await client.query(
          `INSERT INTO v_b_profile_permissions (profile_name, permission_key, allowed)
           VALUES ($1, $2, $3)
           ON CONFLICT (profile_name, permission_key)
           DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = NOW()`,
          [name, key, Boolean(enabled)]
        );
      }
    }

    invalidateProfilePermissions(name);
  } finally {
    client.release();
  }
}
