import { REFERENCE_SCHEMA_MARKER } from "./schemaFromCsv.js";
export const VERITAS_CORE_TABLES = [{
  key: "users",
  table: "v_b_users"
}, {
  key: "settings",
  table: "v_b_settings"
}, {
  key: "clients",
  table: "v_b_clients"
}, {
  key: "tickets",
  table: "v_b_tickets"
}, {
  key: "migrations",
  table: "v_b_schema_migrations"
}];
export async function verifyVeritasConformance(runQuery) {
  const checks = [];
  const missingTables = [];
  for (const item of VERITAS_CORE_TABLES) {
    const result = await runQuery(`SELECT to_regclass('public.${item.table}') AS regclass`);
    const ok = Boolean(result.rows[0]?.regclass);
    checks.push({
      key: item.key,
      table: item.table,
      ok
    });
    if (!ok) missingTables.push(item.table);
  }
  let referenceSchemaInstalled = false;
  if (!missingTables.includes("v_b_schema_migrations")) {
    try {
      const markerResult = await runQuery("SELECT 1 FROM v_b_schema_migrations WHERE filename = $1 LIMIT 1", [REFERENCE_SCHEMA_MARKER]);
      referenceSchemaInstalled = markerResult.rows.length > 0;
    } catch {
      referenceSchemaInstalled = false;
    }
  }
  const conformant = missingTables.length === 0 && referenceSchemaInstalled;
  return {
    conformant,
    checks,
    missingTables,
    referenceSchemaInstalled,
    schemaMarker: REFERENCE_SCHEMA_MARKER
  };
}
