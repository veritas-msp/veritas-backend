// ─────────────────────────────────────────────────────────────
// 🎚️ Standard profile permission presets
// ─────────────────────────────────────────────────────────────
// Sensible default rights applied to standard profiles, replacing
// raw derivation from *_enabled flags (which produced inconsistent
// results, e.g. a "Read" profile with full CRUD).
//
// Gradient: read ⊂ collaborator ⊂ agent ⊂ supervisor ⊂ administrator.

import { PERMISSION_CATALOG, permissionKey } from "./permissionCatalog.js";

/** Builds a Set of keys matching a predicate (group, action) => bool. */
function keysWhere(predicate) {
  const set = new Set();
  for (const group of PERMISSION_CATALOG) {
    for (const action of group.actions) {
      if (predicate(group, action)) set.add(permissionKey(group.group, action));
    }
  }
  return set;
}

/** All catalog keys (administrator). */
function allKeys() {
  return keysWhere(() => true);
}

/** Read-only: view only, excluding admin zones and secrets. */
function readerKeys() {
  return keysWhere(
    (g, a) => !g.adminOnly && a === "view" && g.group !== "vault"
  );
}

/** Collaborator: view/create/edit on business modules, no delete or admin. */
function collaboratorKeys() {
  const set = keysWhere(
    (g, a) =>
      !g.adminOnly &&
      g.group !== "vault" &&
      ["view", "create", "edit"].includes(a)
  );
  set.add("vault.view");
  return set;
}

/** Agent: full CRUD on business modules + contacts/supervision/vault management, no admin. */
function agentKeys() {
  const set = keysWhere((g, a) => !g.adminOnly && a !== "manage");
  set.add("contacts.manage");
  set.add("supervision.manage");
  set.add("vault.manage");
  return set;
}

/** Supervisor: everything agent has + ticket administration. */
function supervisorKeys() {
  const set = agentKeys();
  set.add("tickets.manage");
  return set;
}

/** Preset builders keyed by normalized profile name. */
const PRESET_BUILDERS = {
  administrateur: allKeys,
  administrator: allKeys,
  admin: allKeys,
  superviseur: supervisorKeys,
  supervisor: supervisorKeys,
  agent: agentKeys,
  collaborateur: collaboratorKeys,
  collaborator: collaboratorKeys,
  lecture: readerKeys,
  lecteur: readerKeys,
  reader: readerKeys,
};

function normalizeName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Returns the preset permission Set for a standard profile, or null
 * if the profile is not recognized (→ fallback to *_enabled flags).
 */
export function getPresetForProfile(profileName) {
  const builder = PRESET_BUILDERS[normalizeName(profileName)];
  return builder ? builder() : null;
}

/** True if the profile matches an admin preset (full access). */
export function isAdminPresetProfile(profileName) {
  const key = normalizeName(profileName);
  return key === "administrateur" || key === "administrator" || key === "admin";
}
