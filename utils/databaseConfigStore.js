import { pool } from "../database/db.js";
import { decryptSetting, encryptSettingValue } from "./settingsHelper.js";
import { writeEnvFile } from "./envFile.js";
import { reconfigureBootstrapPool } from "../database/db.js";

const DB_KEYS = ["db_host", "db_port", "db_name", "db_user", "db_password"];

const DB_SETTING_META = [
  { key: "db_host", label: "Hôte PostgreSQL", section: "db" },
  { key: "db_port", label: "Port PostgreSQL", section: "db" },
  { key: "db_name", label: "Base de données", section: "db" },
  { key: "db_user", label: "Utilisateur PostgreSQL", section: "db" },
  { key: "db_password", label: "Mot de passe PostgreSQL", section: "db" },
];

export function buildDatabaseUrl({ db_host, db_port, db_user, db_password, db_name }) {
  const user = encodeURIComponent(db_user);
  const pass = encodeURIComponent(db_password ?? "");
  return `postgres://${user}:${pass}@${db_host}:${db_port}/${db_name}`;
}

export function normalizeDatabaseConfig(raw = {}) {
  return {
    db_host: String(raw.db_host || "").trim(),
    db_port: String(raw.db_port || "5432").trim(),
    db_name: String(raw.db_name || "").trim(),
    db_user: String(raw.db_user || "").trim(),
    db_password: String(raw.db_password ?? ""),
  };
}

export async function loadCurrentDatabaseSettings() {
  const result = await pool.query(
    `SELECT key, value, value_encrypted, value_iv, value_auth_tag
     FROM v_b_settings
     WHERE key = ANY($1::text[])`,
    [DB_KEYS]
  );

  const config = normalizeDatabaseConfig();
  result.rows.forEach((row) => {
    config[row.key] = decryptSetting(row);
  });
  return config;
}

export function resolveDatabaseCredentials(incoming = {}, current = {}) {
  const next = normalizeDatabaseConfig({ ...current, ...incoming });
  if (!String(incoming.db_password ?? "").trim() && String(current.db_password ?? "").trim()) {
    next.db_password = current.db_password;
  }
  return next;
}

export async function saveDatabaseSettings(config) {
  const normalized = normalizeDatabaseConfig(config);

  for (const meta of DB_SETTING_META) {
    const value = normalized[meta.key];
    const enc = encryptSettingValue(value);
    await pool.query(
      `INSERT INTO v_b_settings (key, value, label, section, value_encrypted, value_iv, value_auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         label = EXCLUDED.label,
         section = EXCLUDED.section,
         value_encrypted = EXCLUDED.value_encrypted,
         value_iv = EXCLUDED.value_iv,
         value_auth_tag = EXCLUDED.value_auth_tag`,
      [meta.key, enc.value, meta.label, meta.section, enc.value_encrypted, enc.value_iv, enc.value_auth_tag]
    );
  }

  return normalized;
}

export async function applyDatabaseConfiguration(config) {
  const normalized = normalizeDatabaseConfig(config);
  const databaseUrl = buildDatabaseUrl(normalized);

  await saveDatabaseSettings(normalized);
  writeEnvFile({ DATABASE_URL: databaseUrl });
  await reconfigureBootstrapPool(databaseUrl);

  return { databaseUrl, config: normalized };
}

export async function createDatabaseTestPool(config) {
  const { Pool } = await import("pg");
  const normalized = normalizeDatabaseConfig(config);

  return new Pool({
    host: normalized.db_host,
    port: parseInt(normalized.db_port, 10),
    user: normalized.db_user,
    password: normalized.db_password,
    database: normalized.db_name,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 5000,
  });
}
