/**
 * Installs the Veritas schema for the /setup wizard.
 * Single source: schema/schema_export.csv.
 * SQL patches (schema/patches/) are NOT run during initial installation.
 */
export {
  getMigrationProgress,
  runNextPendingMigration,
  runPendingMigrations,
} from "./referenceSchemaInstall.js";
