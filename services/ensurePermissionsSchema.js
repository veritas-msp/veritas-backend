import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { canRunAutoSchemaMigrations } from "../utils/setupState.js";
import {
  ALL_PERMISSION_KEYS,
  defaultPermissionsForProfile,
} from "../config/permissionCatalog.js";
import { getPresetForProfile } from "../config/permissionPresets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MIGRATION_FILE = "schema/patches/20260707_profile_permissions.sql";

let ensuredCatalogSize = -1;

async function tableExists(client, table) {
  const { rows } = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
  return Boolean(rows[0]?.reg);
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function hasAnyViewPermission(perms) {
  for (const key of perms) {
    if (String(key).endsWith(".view")) return true;
  }
  return false;
}

/** Writes a profile's full matrix (replaces everything). */
async function writeProfileMatrix(client, name, grantedSet) {
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
}

/**
 * Seeds / updates permissions for a profile:
 *  - standard profile → PRESET if never configured, equal to flag defaults, or with no *.view
 *  - custom profile → flag defaults if no rows
 *  - missing catalog keys → added without touching the rest
 */
export async function seedProfilePermissions(client, profileRow) {
  const name = profileRow?.name;
  if (!name) return;

  const { rows } = await client.query(
    `SELECT permission_key, allowed FROM v_b_profile_permissions WHERE profile_name = $1`,
    [name]
  );
  const hasRows = rows.length > 0;
  const preset = getPresetForProfile(name);
  const flagDefault = defaultPermissionsForProfile(profileRow);

  if (!hasRows) {
    await writeProfileMatrix(client, name, preset || flagDefault);
    return;
  }

  if (preset) {
    const current = new Set(rows.filter((r) => r.allowed).map((r) => r.permission_key));
    if (!hasAnyViewPermission(current) || setsEqual(current, flagDefault)) {
      await writeProfileMatrix(client, name, preset);
      return;
    }
  }

  const knownKeys = new Set(rows.map((r) => r.permission_key));
  const missingKeys = ALL_PERMISSION_KEYS.filter((k) => !knownKeys.has(k));
  if (missingKeys.length === 0) return;

  const source = preset || flagDefault;
  const values = [];
  const params = [];
  let i = 1;
  for (const key of missingKeys) {
    values.push(`($${i++}, $${i++}, $${i++})`);
    params.push(name, key, source.has(key));
  }
  await client.query(
    `INSERT INTO v_b_profile_permissions (profile_name, permission_key, allowed)
     VALUES ${values.join(", ")}
     ON CONFLICT (profile_name, permission_key) DO NOTHING`,
    params
  );
}

/** Creates the permissions table and seeds defaults for existing profiles. */
export async function ensurePermissionsSchema() {
  if (ensuredCatalogSize === ALL_PERMISSION_KEYS.length) return;
  if (!(await canRunAutoSchemaMigrations())) return;

  const client = await pool.connect();
  try {
    if (!(await tableExists(client, "v_b_users_profiles"))) {
      return;
    }

    if (!(await tableExists(client, "v_b_profile_permissions"))) {
      const filePath = path.join(root, MIGRATION_FILE);
      if (!fs.existsSync(filePath)) {
        console.warn("[permissions] Migration introuvable:", MIGRATION_FILE);
        return;
      }
      console.log("[permissions] Création de la table de permissions…");
      await client.query(fs.readFileSync(filePath, "utf8"));
    }

    const profiles = await client.query(
      `SELECT name, label,
              monitoring_enabled, infrastructure_enabled, cybersecurite_enabled,
              planning_enabled, service_enabled, contrat_enabled, contact_enabled,
              configurateur_enabled, tickets_enabled, dashboard_enabled, documents_enabled
       FROM v_b_users_profiles`
    );
    for (const profile of profiles.rows) {
      await seedProfilePermissions(client, profile);
    }

    ensuredCatalogSize = ALL_PERMISSION_KEYS.length;
    console.log(`[permissions] Schéma prêt (${ALL_PERMISSION_KEYS.length} permissions au catalogue).`);
  } catch (err) {
    console.error("[permissions] Échec migration automatique:", err.message);
  } finally {
    client.release();
  }
}
