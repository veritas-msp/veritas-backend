import { pool } from "../database/db.js";
import { isDatabaseConfigured } from "../database/db.js";
import { REFERENCE_SCHEMA_BOOTSTRAP_SQL, REFERENCE_SCHEMA_MARKER, REFERENCE_SCHEMA_SEEDS_SQL, REFERENCE_SEEDS_MARKER, buildCreateTableSql, loadReferenceSchemaTables } from "./schemaFromCsv.js";
const INSTALL_STEPS = [{
  kind: "seeds",
  name: REFERENCE_SEEDS_MARKER,
  label: "initial data"
}];
function getInstallPlan() {
  const tables = loadReferenceSchemaTables();
  const tableSteps = tables.map(table => ({
    kind: "table",
    name: table.tableName,
    label: table.tableName,
    sql: buildCreateTableSql(table.tableName, table.columns)
  }));
  return [...tableSteps, ...INSTALL_STEPS];
}
async function ensureBootstrap(client) {
  await client.query(REFERENCE_SCHEMA_BOOTSTRAP_SQL);
}
async function getAppliedTables(client) {
  const result = await client.query("SELECT table_name FROM v_b_reference_schema_progress");
  return new Set(result.rows.map(row => row.table_name));
}
async function isReferenceSchemaComplete(client) {
  const migrations = await client.query("SELECT 1 FROM v_b_schema_migrations WHERE filename = $1 LIMIT 1", [REFERENCE_SCHEMA_MARKER]);
  return migrations.rows.length > 0;
}
function buildProgress(plan, applied) {
  const total = plan.length;
  const completed = plan.filter(step => applied.has(step.name)).length;
  return {
    total,
    completed,
    remaining: total - completed
  };
}
export async function getMigrationProgress() {
  if (!isDatabaseConfigured()) {
    throw new Error("Database is not configured — complete the previous wizard step.");
  }
  const client = await pool.connect();
  try {
    await ensureBootstrap(client);
    const plan = getInstallPlan();
    const applied = await getAppliedTables(client);
    if (await isReferenceSchemaComplete(client)) {
      return {
        ...buildProgress(plan, new Set(plan.map(s => s.name))),
        pending: [],
        mode: "reference_schema"
      };
    }
    return {
      ...buildProgress(plan, applied),
      pending: plan.filter(step => !applied.has(step.name)).map(s => s.name),
      mode: "reference_schema"
    };
  } finally {
    client.release();
  }
}
export async function runNextPendingMigration() {
  if (!isDatabaseConfigured()) {
    throw new Error("Database is not configured — complete the previous wizard step.");
  }
  const client = await pool.connect();
  try {
    await ensureBootstrap(client);
    if (await isReferenceSchemaComplete(client)) {
      const plan = getInstallPlan();
      return {
        done: true,
        executed: null,
        progress: buildProgress(plan, new Set(plan.map(s => s.name)))
      };
    }
    const plan = getInstallPlan();
    const applied = await getAppliedTables(client);
    const next = plan.find(step => !applied.has(step.name));
    if (!next) {
      await client.query("INSERT INTO v_b_schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING", [REFERENCE_SCHEMA_MARKER]);
      return {
        done: true,
        executed: null,
        progress: buildProgress(plan, new Set(plan.map(s => s.name)))
      };
    }
    await client.query("BEGIN");
    try {
      if (next.kind === "table") {
        await client.query(next.sql);
      } else {
        await client.query(REFERENCE_SCHEMA_SEEDS_SQL);
      }
      await client.query("INSERT INTO v_b_reference_schema_progress (table_name) VALUES ($1) ON CONFLICT (table_name) DO NOTHING", [next.name]);
      if (next.kind === "seeds") {
        await client.query("INSERT INTO v_b_schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING", [REFERENCE_SCHEMA_MARKER]);
      }
      await client.query("COMMIT");
      applied.add(next.name);
      const remaining = plan.filter(step => !applied.has(step.name)).length;
      return {
        done: remaining === 0,
        executed: {
          filename: next.name,
          kind: next.kind,
          tables: next.kind === "table" ? [next.name] : [],
          label: next.label
        },
        progress: buildProgress(plan, applied)
      };
    } catch (err) {
      await client.query("ROLLBACK");
      const target = next.kind === "table" ? `Table "${next.name}"` : "Initial data";
      throw new Error(`${target} : ${err.message}`);
    }
  } finally {
    client.release();
  }
}
export async function runPendingMigrations() {
  const executed = [];
  let result;
  do {
    result = await runNextPendingMigration();
    if (result.executed) executed.push(result.executed);
  } while (!result.done);
  const progress = await getMigrationProgress();
  return {
    executed,
    total: progress.total
  };
}
