// ─────────────────────────────────────────────────────────────
// 🔐 Central permissions catalog (fine-grained RBAC per profile)
// ─────────────────────────────────────────────────────────────
// Each permission has a stable `group.action` key.
// The frontend and backend share EXACTLY this catalog:
// - backend uses it to validate keys and seed defaults
// - frontend uses it to render the profile × permissions matrix
//
// ⚠️ Any change (add/remove key) must remain backward-compatible:
// a removed key is no longer checked; an added key is denied by default
// (except for admin role which bypasses everything) until an admin grants it.

/**
 * Reusable generic actions.
 * `view`   : access / list
 * `create` : create
 * `edit`   : modify
 * `delete` : delete
 * `export` : export / bulk download
 * `manage` : admin / sensitive module actions
 */
export const PERMISSION_ACTION_LABELS = {
  view: "Voir",
  create: "Créer",
  edit: "Modifier",
  delete: "Supprimer",
  export: "Exporter",
  manage: "Administrer",
};

/**
 * Catalog by group (≈ page). `moduleFlag` is used for initial SEED:
 * default profile rights are derived from existing `*_enabled` flags,
 * to reproduce current access without breaking on upgrade.
 * `adminOnly: true` = reserved group (seeded to false for all; admin bypass).
 */
export const PERMISSION_CATALOG = [
  {
    group: "dashboard",
    label: "Tableau de bord",
    section: "pilotage",
    moduleFlag: "dashboard_enabled",
    actions: ["view"],
  },
  {
    group: "planning",
    label: "Planning",
    section: "pilotage",
    moduleFlag: "planning_enabled",
    actions: ["view", "edit"],
  },
  {
    group: "clients",
    label: "Fiches entreprise",
    section: "crm",
    moduleFlag: null, // core module, enabled by default
    coreDefault: true,
    actions: ["view", "create", "edit", "delete", "export"],
  },
  {
    group: "contacts",
    label: "Contacts",
    section: "crm",
    moduleFlag: "contact_enabled",
    coreDefault: true,
    actions: ["view", "create", "edit", "delete", "manage"],
    actionLabels: { manage: "Gérer les accès portail" },
  },
  {
    group: "contracts",
    label: "Contrats",
    section: "crm",
    moduleFlag: "contrat_enabled",
    coreDefault: true,
    actions: ["view", "create", "edit", "delete"],
  },
  {
    group: "services",
    label: "Services",
    section: "crm",
    moduleFlag: "service_enabled",
    actions: ["view", "create", "edit", "delete"],
  },
  {
    group: "tickets",
    label: "Tickets",
    section: "support",
    moduleFlag: "tickets_enabled",
    actions: ["view", "create", "edit", "delete", "export", "manage"],
    actionLabels: { manage: "Administration (modération, purge, automatisations)" },
  },
  {
    group: "sales",
    label: "Prestations & installations",
    section: "support",
    moduleFlag: "tickets_enabled",
    actions: ["view", "create", "edit", "delete"],
  },
  {
    group: "infrastructure",
    label: "Infrastructure",
    section: "supervision",
    moduleFlag: "infrastructure_enabled",
    actions: ["view", "edit"],
  },
  {
    group: "supervision",
    label: "Centre de supervision",
    section: "supervision",
    moduleFlag: "infrastructure_enabled",
    actions: ["view", "manage"],
    actionLabels: { manage: "Gérer les règles d'alerte" },
  },
  {
    group: "monitoring",
    label: "Monitoring",
    section: "supervision",
    moduleFlag: "monitoring_enabled",
    actions: ["view"],
  },
  {
    group: "cybersecurite",
    label: "Cybersécurité",
    section: "supervision",
    moduleFlag: "cybersecurite_enabled",
    actions: ["view", "edit"],
  },
  {
    group: "documents",
    label: "Documents",
    section: "documents",
    moduleFlag: "documents_enabled",
    actions: ["view", "create", "edit", "delete"],
  },
  {
    group: "vault",
    label: "Secrets (Vault)",
    section: "documents",
    moduleFlag: "documents_enabled",
    actions: ["view", "manage"],
    actionLabels: { view: "Consulter les secrets", manage: "Créer / modifier / supprimer" },
  },
  {
    group: "configurateur",
    label: "Configurateur",
    section: "outils",
    moduleFlag: "configurateur_enabled",
    actions: ["view", "edit"],
  },
  {
    group: "rmm",
    label: "RMM",
    section: "administration",
    moduleFlag: null,
    adminOnly: true,
    actions: ["view", "manage"],
  },
  {
    group: "integrations",
    label: "Intégrations",
    section: "administration",
    moduleFlag: null,
    adminOnly: true,
    actions: ["view", "manage"],
  },
  {
    group: "config",
    label: "Configuration",
    section: "administration",
    moduleFlag: null,
    adminOnly: true,
    actions: ["view", "manage"],
    actionLabels: { view: "Accéder à l'administration", manage: "Modifier les paramètres" },
  },
  {
    group: "users",
    label: "Utilisateurs & profils",
    section: "administration",
    moduleFlag: null,
    adminOnly: true,
    actions: ["view", "manage"],
    actionLabels: { manage: "Créer / modifier / supprimer, gérer les permissions" },
  },
  {
    group: "maintenance",
    label: "Maintenance / Sauvegardes",
    section: "administration",
    moduleFlag: null,
    adminOnly: true,
    actions: ["manage"],
  },
  {
    group: "license",
    label: "Licence",
    section: "administration",
    moduleFlag: null,
    adminOnly: true,
    actions: ["manage"],
  },
];

/**
 * Mapping of `*.view` keys → profile `*_enabled` columns.
 * Used to sync legacy flags when saving the matrix.
 * Multiple groups may share the same flag (OR on write).
 */
export const VIEW_PERMISSION_TO_MODULE_FLAG = {
  "dashboard.view": "dashboard_enabled",
  "planning.view": "planning_enabled",
  "contacts.view": "contact_enabled",
  "contracts.view": "contrat_enabled",
  "services.view": "service_enabled",
  "tickets.view": "tickets_enabled",
  "sales.view": "tickets_enabled",
  "infrastructure.view": "infrastructure_enabled",
  "supervision.view": "infrastructure_enabled",
  "monitoring.view": "monitoring_enabled",
  "cybersecurite.view": "cybersecurite_enabled",
  "documents.view": "documents_enabled",
  "vault.view": "documents_enabled",
  "configurateur.view": "configurateur_enabled",
};

/**
 * Mapping of UI access keys (Sidebar / agentRoutes) → `*.view` permissions.
 * A page is accessible if at least one of the listed keys is granted.
 */
export const ACCESS_KEY_TO_VIEW_PERMISSIONS = {
  Dashboard: ["dashboard.view"],
  Planning: ["planning.view"],
  Ticket: ["tickets.view"],
  TicketSales: ["sales.view"],
  Service: ["services.view"],
  Contrat: ["contracts.view"],
  Contact: ["contacts.view"],
  Hardware: ["infrastructure.view", "supervision.view"],
  Cybersecurite: ["cybersecurite.view"],
  Mon: ["monitoring.view"],
  DocumentsHub: ["documents.view"],
};

/**
 * Module flag → affected catalog groups.
 * Used when the Access tab toggles `*_enabled` (grant *.view / revoke all actions).
 */
export const MODULE_FLAG_TO_GROUPS = {
  dashboard_enabled: ["dashboard"],
  planning_enabled: ["planning"],
  contact_enabled: ["contacts"],
  contrat_enabled: ["contracts"],
  service_enabled: ["services"],
  tickets_enabled: ["tickets", "sales"],
  infrastructure_enabled: ["infrastructure", "supervision"],
  monitoring_enabled: ["monitoring"],
  cybersecurite_enabled: ["cybersecurite"],
  documents_enabled: ["documents", "vault"],
  configurateur_enabled: ["configurateur"],
};

/** Builds a stable permission key. */
export function permissionKey(group, action) {
  return `${group}.${action}`;
}

/** Set of ALL valid catalog keys. */
export const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.flatMap((g) =>
  g.actions.map((a) => permissionKey(g.group, a))
);

const ALL_PERMISSION_KEYS_SET = new Set(ALL_PERMISSION_KEYS);

/** True if the key exists in the catalog. */
export function isValidPermissionKey(key) {
  return ALL_PERMISSION_KEYS_SET.has(key);
}

/**
 * Computes default permissions for a profile from its `*_enabled` flags.
 * Enabled modules get `*.view` only — CRUD/manage must be granted via the
 * fine-grained matrix (or a standard preset). `adminOnly` groups stay closed
 * (admin role bypasses anyway).
 *
 * @param {object} profileRow v_b_users_profiles row (with *_enabled flags)
 * @returns {Set<string>} granted keys
 */
export function defaultPermissionsForProfile(profileRow = {}) {
  const granted = new Set();
  for (const group of PERMISSION_CATALOG) {
    if (group.adminOnly) continue;
    let enabled;
    if (group.moduleFlag) {
      enabled = Boolean(profileRow[group.moduleFlag]);
    } else if (group.coreDefault) {
      enabled = true;
    } else {
      // Non-admin groups without flag or core default (e.g. vault): closed by default
      enabled = false;
    }
    if (!enabled) continue;
    if (group.actions.includes("view")) {
      granted.add(permissionKey(group.group, "view"));
    }
  }
  return granted;
}
