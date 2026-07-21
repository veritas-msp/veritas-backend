import dotenv from "dotenv";
import { pool } from "../database/db.js";
import { INCREMENTAL_TABLE_CHECKS, runIncrementalAvrilMigrations, verifyIncrementalTables } from "../utils/incrementalAvrilMigrations.js";
import { runPostSetupSchemaMigrations } from "../services/runPostSetupSchemaMigrations.js";
dotenv.config();
async function tableExists(name) {
  const {
    rows
  } = await pool.query(`SELECT to_regclass($1) AS reg`, [`public.${name}`]);
  return Boolean(rows[0]?.reg);
}
try {
  await runPostSetupSchemaMigrations();
  const missing = await verifyIncrementalTables();
  console.log("\nFinal status:");
  for (const table of INCREMENTAL_TABLE_CHECKS) {
    const ok = await tableExists(table);
    console.log(`  ${ok ? "✓" : "✗"} ${table}`);
  }
  if (missing.length > 0) {
    console.error("\nMissing tables:", missing.join(", "));
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nFailed:", err.message);
  if (err.detail) console.error("Detail:", err.detail);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
