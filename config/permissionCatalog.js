export const PERMISSION_ACTION_LABELS = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
  export: "Export",
  manage: "Manage"
};
export const PERMISSION_CATALOG = [{
  group: "dashboard",
  label: "Dashboard",
  section: "operations",
  moduleFlag: "dashboard_enabled",
  actions: ["view"]
}, {
  group: "planning",
  label: "Planning",
  section: "operations",
  moduleFlag: "planning_enabled",
  actions: ["view", "edit"]
}, {
  group: "clients",
  label: "Company records",
  section: "crm",
  moduleFlag: null,
  coreDefault: true,
  actions: ["view", "create", "edit", "delete", "export"]
}, {
  group: "contacts",
  label: "Contacts",
  section: "crm",
  moduleFlag: "contact_enabled",
  coreDefault: true,
  actions: ["view", "create", "edit", "delete", "manage"],
  actionLabels: {
    manage: "Manage portal access"
  }
}, {
  group: "contracts",
  label: "Contracts",
  section: "crm",
  moduleFlag: "contrat_enabled",
  coreDefault: true,
  actions: ["view", "create", "edit", "delete"]
}, {
  group: "services",
  label: "Services",
  section: "crm",
  moduleFlag: "service_enabled",
  actions: ["view", "create", "edit", "delete"]
}, {
  group: "tickets",
  label: "Tickets",
  section: "support",
  moduleFlag: "tickets_enabled",
  actions: ["view", "create", "edit", "delete", "export", "manage"],
  actionLabels: {
    manage: "Administration (moderation, purge, automations)"
  }
}, {
  group: "sales",
  label: "Services & installations",
  section: "support",
  moduleFlag: "tickets_enabled",
  actions: ["view", "create", "edit", "delete"]
}, {
  group: "infrastructure",
  label: "Infrastructure",
  section: "supervision",
  moduleFlag: "infrastructure_enabled",
  actions: ["view", "edit"]
}, {
  group: "supervision",
  label: "Supervision center",
  section: "supervision",
  moduleFlag: "infrastructure_enabled",
  actions: ["view", "manage"],
  actionLabels: {
    manage: "Manage alert rules"
  }
}, {
  group: "monitoring",
  label: "Monitoring",
  section: "supervision",
  moduleFlag: "monitoring_enabled",
  actions: ["view"]
}, {
  group: "cybersecurite",
  label: "Cybersecurity",
  section: "supervision",
  moduleFlag: "cybersecurite_enabled",
  actions: ["view", "edit"]
}, {
  group: "documents",
  label: "Documents",
  section: "documents",
  moduleFlag: "documents_enabled",
  actions: ["view", "create", "edit", "delete"]
}, {
  group: "vault",
  label: "Secrets (Vault)",
  section: "documents",
  moduleFlag: "documents_enabled",
  actions: ["view", "manage"],
  actionLabels: {
    view: "View secrets",
    manage: "Create / edit / delete"
  }
}, {
  group: "configurateur",
  label: "Configurator",
  section: "tools",
  moduleFlag: "configurateur_enabled",
  actions: ["view", "edit"]
}, {
  group: "rmm",
  label: "RMM",
  section: "administration",
  moduleFlag: null,
  adminOnly: true,
  actions: ["view", "manage"]
}, {
  group: "integrations",
  label: "Integrations",
  section: "administration",
  moduleFlag: null,
  adminOnly: true,
  actions: ["view", "manage"]
}, {
  group: "config",
  label: "Configuration",
  section: "administration",
  moduleFlag: null,
  adminOnly: true,
  actions: ["view", "manage"],
  actionLabels: {
    view: "Access administration",
    manage: "Edit settings"
  }
}, {
  group: "users",
  label: "Users & profiles",
  section: "administration",
  moduleFlag: null,
  adminOnly: true,
  actions: ["view", "manage"],
  actionLabels: {
    manage: "Create / edit / delete, manage permissions"
  }
}, {
  group: "maintenance",
  label: "Maintenance / Backups",
  section: "administration",
  moduleFlag: null,
  adminOnly: true,
  actions: ["manage"]
}, {
  group: "license",
  label: "License",
  section: "administration",
  moduleFlag: null,
  adminOnly: true,
  actions: ["manage"]
}];
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
  "configurateur.view": "configurateur_enabled"
};
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
  DocumentsHub: ["documents.view"]
};
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
  configurateur_enabled: ["configurateur"]
};
export function permissionKey(group, action) {
  return `${group}.${action}`;
}
export const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.flatMap(g => g.actions.map(a => permissionKey(g.group, a)));
const ALL_PERMISSION_KEYS_SET = new Set(ALL_PERMISSION_KEYS);
export function isValidPermissionKey(key) {
  return ALL_PERMISSION_KEYS_SET.has(key);
}
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
      enabled = false;
    }
    if (!enabled) continue;
    if (group.actions.includes("view")) {
      granted.add(permissionKey(group.group, "view"));
    }
  }
  return granted;
}
