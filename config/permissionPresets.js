import { PERMISSION_CATALOG, permissionKey } from "./permissionCatalog.js";

function keysWhere(predicate) {
  const set = new Set();
  for (const group of PERMISSION_CATALOG) {
    for (const action of group.actions) {
      if (predicate(group, action)) set.add(permissionKey(group.group, action));
    }
  }
  return set;
}

function allKeys() {
  return keysWhere(() => true);
}

function readerKeys() {
  return keysWhere((g, a) => !g.adminOnly && a === "view" && g.group !== "vault");
}

function collaboratorKeys() {
  const set = keysWhere((g, a) => !g.adminOnly && g.group !== "vault" && ["view", "create", "edit"].includes(a));
  set.add("vault.view");
  return set;
}

function agentKeys() {
  const set = keysWhere((g, a) => !g.adminOnly && a !== "manage");
  set.add("contacts.manage");
  set.add("supervision.manage");
  set.add("vault.manage");
  return set;
}

function supervisorKeys() {
  const set = agentKeys();
  set.add("tickets.manage");
  return set;
}

/** Canonical profile name stored in DB / shown in UI. */
export const SUPER_ADMIN_PROFILE_NAME = "Super Admin";

const PRESET_BUILDERS = {
  "super admin": allKeys,
  "super-admin": allKeys,
  super_admin: allKeys,
  superadmin: allKeys,
  superadministrateur: allKeys,
  "super-administrateur": allKeys,
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
  "read only": readerKeys,
  readonly: readerKeys
};

export function normalizeProfileName(name) {
  return String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function getPresetForProfile(profileName) {
  const builder = PRESET_BUILDERS[normalizeProfileName(profileName)];
  return builder ? builder() : null;
}

/** Only Super Admin is immutable (permissions / profile meta). Administrator remains editable. */
export function isSuperAdminPresetProfile(profileName) {
  const key = normalizeProfileName(profileName);
  return key === "super admin" || key === "superadmin" || key === "super administrateur";
}

/** @deprecated Use isSuperAdminPresetProfile — kept for call sites that locked "admin" before. */
export function isAdminPresetProfile(profileName) {
  return isSuperAdminPresetProfile(profileName);
}
