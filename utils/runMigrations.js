/**
 * Installation du schéma Veritas pour le wizard /setup.
 * Source unique : schema/schema_export.csv.
 * Les patches SQL (schema/patches/) ne sont PAS exécutés à l'installation initiale.
 */
export {
  getMigrationProgress,
  runNextPendingMigration,
  runPendingMigrations,
} from "./referenceSchemaInstall.js";
