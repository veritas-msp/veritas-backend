import { pool } from "../database/db.js";

export const DEFAULT_CONTRACT_MODULES = [
  { module_key: "Support", label: "Support", icon: "mdi:headset", sort_order: 10 },
  { module_key: "Curatif", label: "Curatif", icon: "tabler:truck-filled", sort_order: 20 },
  { module_key: "Preventif", label: "Préventif", icon: "fluent-mdl2:documentation", sort_order: 30 },
  { module_key: "Monitoring", label: "Monitoring", icon: "eos-icons:monitoring", sort_order: 40 },
  { module_key: "Hebergement", label: "Hébergement", icon: "carbon:data-center", sort_order: 50 },
];

let tableReady = false;

function slugifyModuleKey(value) {
  return String(value || "module")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 48) || "module";
}

function mapRow(row, { includeUsage = false } = {}) {
  const mapped = {
    id: row.id,
    moduleKey: row.module_key,
    label: row.label,
    icon: row.icon || "mdi:puzzle-outline",
    enabled: Boolean(row.enabled),
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeUsage) {
    mapped.clientUsageCount = Number(row.client_usage_count) || 0;
  }
  return mapped;
}

export async function countClientsUsingModuleKey(moduleKey) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM v_b_clients
     WHERE options @> jsonb_build_object($1, true)`,
    [moduleKey]
  );
  return Number(result.rows[0]?.count) || 0;
}

export async function ensureContractModuleOptionsTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS v_b_contract_module_options (
      id SERIAL PRIMARY KEY,
      module_key VARCHAR(64) NOT NULL UNIQUE,
      label VARCHAR(120) NOT NULL,
      icon VARCHAR(120) NOT NULL DEFAULT 'mdi:puzzle-outline',
      enabled BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_contract_module_options_enabled_sort
      ON v_b_contract_module_options(enabled, sort_order);
    CREATE UNIQUE INDEX IF NOT EXISTS v_b_contract_module_options_module_key_uniq
      ON v_b_contract_module_options (module_key);
  `);
  tableReady = true;
}

async function seedDefaultsIfEmpty() {
  const count = await pool.query(`SELECT COUNT(*)::int AS count FROM v_b_contract_module_options`);
  if (Number(count.rows[0]?.count) > 0) return;

  for (const mod of DEFAULT_CONTRACT_MODULES) {
    await pool.query(
      `INSERT INTO v_b_contract_module_options (module_key, label, icon, enabled, sort_order)
       VALUES ($1, $2, $3, true, $4)`,
      [mod.module_key, mod.label, mod.icon, mod.sort_order]
    );
  }
}

export async function listContractModuleOptions({ includeDisabled = true, includeUsage = false } = {}) {
  await ensureContractModuleOptionsTable();
  await seedDefaultsIfEmpty();

  const conditions = [];
  if (!includeDisabled) conditions.push("o.enabled = true");

  const usageSelect = includeUsage
    ? `, (
         SELECT COUNT(*)::int
         FROM v_b_clients c
         WHERE c.options @> jsonb_build_object(o.module_key, true)
       ) AS client_usage_count`
    : "";

  const result = await pool.query(
    `SELECT o.id, o.module_key, o.label, o.icon, o.enabled, o.sort_order, o.created_at, o.updated_at${usageSelect}
     FROM v_b_contract_module_options o
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY o.sort_order ASC, o.id ASC`
  );

  return result.rows.map((row) => mapRow(row, { includeUsage }));
}

export function buildDefaultOptionsObject(modules) {
  const obj = {};
  for (const mod of modules) {
    obj[mod.moduleKey] = false;
  }
  return obj;
}

export async function createContractModuleOption(payload) {
  await ensureContractModuleOptionsTable();

  const label = String(payload.label || "").trim();
  if (!label) {
    const err = new Error("Libellé requis.");
    err.status = 400;
    throw err;
  }

  let moduleKey = slugifyModuleKey(payload.moduleKey || label);
  const exists = await pool.query(
    `SELECT id FROM v_b_contract_module_options WHERE module_key = $1`,
    [moduleKey]
  );
  if (exists.rows.length > 0) {
    moduleKey = `${moduleKey}_${Date.now().toString(36)}`;
  }

  const icon = String(payload.icon || "mdi:puzzle-outline").trim() || "mdi:puzzle-outline";
  const sortOrder = Number.isFinite(Number(payload.sortOrder))
    ? Number(payload.sortOrder)
    : (await pool.query(`SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM v_b_contract_module_options`))
        .rows[0].next;

  const result = await pool.query(
    `INSERT INTO v_b_contract_module_options (module_key, label, icon, enabled, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, module_key, label, icon, enabled, sort_order, created_at, updated_at`,
    [moduleKey, label, icon, payload.enabled !== false, sortOrder]
  );

  return mapRow(result.rows[0]);
}

export async function updateContractModuleOption(id, payload) {
  await ensureContractModuleOptionsTable();
  const optionId = Number(id);
  if (!Number.isInteger(optionId) || optionId <= 0) {
    const err = new Error("Option introuvable.");
    err.status = 404;
    throw err;
  }

  const existing = await pool.query(`SELECT * FROM v_b_contract_module_options WHERE id = $1`, [optionId]);
  if (!existing.rows[0]) {
    const err = new Error("Option introuvable.");
    err.status = 404;
    throw err;
  }

  const row = existing.rows[0];
  const label = payload.label !== undefined ? String(payload.label).trim() : row.label;
  if (!label) {
    const err = new Error("Libellé requis.");
    err.status = 400;
    throw err;
  }

  const result = await pool.query(
    `UPDATE v_b_contract_module_options
     SET label = $1,
         icon = $2,
         enabled = $3,
         sort_order = $4,
         updated_at = NOW()
     WHERE id = $5
     RETURNING id, module_key, label, icon, enabled, sort_order, created_at, updated_at`,
    [
      label,
      payload.icon !== undefined ? String(payload.icon).trim() || "mdi:puzzle-outline" : row.icon,
      payload.enabled !== undefined ? Boolean(payload.enabled) : row.enabled,
      payload.sortOrder !== undefined ? Number(payload.sortOrder) : row.sort_order,
      optionId,
    ]
  );

  return mapRow(result.rows[0]);
}

export async function deleteContractModuleOption(id) {
  await ensureContractModuleOptionsTable();
  const optionId = Number(id);

  const existing = await pool.query(
    `SELECT id, module_key FROM v_b_contract_module_options WHERE id = $1`,
    [optionId]
  );
  if (!existing.rows[0]) {
    const err = new Error("Option introuvable.");
    err.status = 404;
    throw err;
  }

  const usageCount = await countClientsUsingModuleKey(existing.rows[0].module_key);
  if (usageCount > 0) {
    const err = new Error(
      usageCount === 1
        ? "Cette option est utilisée par 1 entreprise et ne peut pas être supprimée."
        : `Cette option est utilisée par ${usageCount} entreprises et ne peut pas être supprimée.`
    );
    err.status = 409;
    err.usageCount = usageCount;
    throw err;
  }

  const result = await pool.query(
    `DELETE FROM v_b_contract_module_options WHERE id = $1 RETURNING id`,
    [optionId]
  );
  if (!result.rows[0]) {
    const err = new Error("Option introuvable.");
    err.status = 404;
    throw err;
  }
  return { success: true };
}

export async function resetContractModuleOptions() {
  await ensureContractModuleOptionsTable();
  await pool.query(`DELETE FROM v_b_contract_module_options`);
  await seedDefaultsIfEmpty();
  return listContractModuleOptions();
}
