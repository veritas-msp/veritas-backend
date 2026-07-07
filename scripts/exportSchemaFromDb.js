/**
 * Exporte le schéma public PostgreSQL au format schema_export.csv.
 *
 * Usage:
 *   PGHOST=... PGPORT=5432 PGUSER=postgres PGPASSWORD=... PGDATABASE=veritas_db \
 *     node scripts/exportSchemaFromDb.js
 *
 * Ou: node scripts/exportSchemaFromDb.js --host ... --port ... --user ... --password ... --database ...
 */
import fs from "fs";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BOOTSTRAP_TABLES = new Set([
  "v_b_schema_migrations",
  "v_b_reference_schema_progress",
]);

function parseArgs(argv) {
  const args = {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
    database: process.env.PGDATABASE || "veritas_db",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--host") args.host = value;
    if (key === "--port") args.port = Number(value);
    if (key === "--user") args.user = value;
    if (key === "--password") args.password = value;
    if (key === "--database") args.database = value;
  }

  if (!args.password) {
    throw new Error(
      "Mot de passe PostgreSQL requis (PGPASSWORD ou --password)."
    );
  }

  return args;
}

function csvCell(value) {
  if (value == null || value === "") return '""';
  const text = String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function csvLine(values) {
  return values.map(csvCell).join(",");
}

const pool = new pg.Pool({
  ...parseArgs(process.argv),
  connectionTimeoutMillis: 20000,
});

async function main() {
  const { rows } = await pool.query(
    `
    SELECT
      c.table_schema,
      c.table_name,
      c.ordinal_position,
      c.column_name,
      c.data_type,
      c.character_maximum_length,
      c.numeric_precision,
      c.numeric_scale,
      c.is_nullable,
      c.column_default
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name <> ALL($1::text[])
    ORDER BY c.table_name, c.ordinal_position
  `,
    [[...BOOTSTRAP_TABLES]]
  );

  const header = csvLine([
    "schema",
    "table_name",
    "pos",
    "column_name",
    "data_type",
    "character_maximum_length",
    "numeric_precision",
    "numeric_scale",
    "is_nullable",
    "column_default",
  ]);

  const lines = rows.map((row) =>
    csvLine([
      row.table_schema,
      row.table_name,
      row.ordinal_position,
      row.column_name,
      row.data_type,
      row.character_maximum_length,
      row.numeric_precision,
      row.numeric_scale,
      row.is_nullable,
      row.column_default,
    ])
  );

  const outPath = path.join(__dirname, "..", "schema", "schema_export.csv");
  fs.writeFileSync(outPath, [header, ...lines].join("\n") + "\n", "utf8");

  const tableCount = new Set(rows.map((r) => r.table_name)).size;
  console.log(`Exported ${tableCount} tables (${rows.length} columns) -> ${outPath}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
