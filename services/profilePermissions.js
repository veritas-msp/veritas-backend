import { pool } from "../database/db.js";

export const PROFILE_PERMISSION_FLAGS = [
  "monitoring_enabled",
  "infrastructure_enabled",
  "cybersecurite_enabled",
  "planning_enabled",
  "service_enabled",
  "contrat_enabled",
  "contact_enabled",
  "configurateur_enabled",
  "tickets_enabled",
  "dashboard_enabled",
  "documents_enabled",
];

export async function getProfileRow(name) {
  const result = await pool.query(
    `SELECT name, label, parent_profile,
            monitoring_enabled, infrastructure_enabled, cybersecurite_enabled,
            planning_enabled, service_enabled, contrat_enabled, contact_enabled,
            configurateur_enabled, tickets_enabled, dashboard_enabled, documents_enabled, display_order
     FROM v_b_users_profiles
     WHERE name = $1`,
    [name]
  );
  return result.rows[0] || null;
}

export async function resolveEffectiveProfile(name, visited = new Set()) {
  const key = String(name || "").trim();
  if (!key) return null;
  if (visited.has(key)) {
    throw new Error(`Cycle d'héritage détecté pour le profil « ${key} »`);
  }
  visited.add(key);

  const row = await getProfileRow(key);
  if (!row) return null;
  if (!row.parent_profile) return row;

  const parent = await resolveEffectiveProfile(row.parent_profile, visited);
  if (!parent) return row;

  const merged = { ...parent, ...row, name: row.name, label: row.label, parent_profile: row.parent_profile };
  for (const flag of PROFILE_PERMISSION_FLAGS) {
    merged[flag] = Boolean(row[flag] ?? parent[flag]);
  }
  merged.contrat_enabled = true;
  merged.contact_enabled = true;
  return merged;
}

export async function profileHasChildren(name) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM v_b_users_profiles WHERE parent_profile = $1`,
    [name]
  );
  return (result.rows[0]?.total || 0) > 0;
}
