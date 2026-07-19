// ───────────────────────────────────────────────
// 📦 Imports
// ───────────────────────────────────────────────
import pkg from "pg";                     // Import PostgreSQL module
import dotenv from "dotenv";              // Load environment variables
import { decrypt } from "../utils/encryption.js";
dotenv.config();                          // Load .env

const { Pool } = pkg;

let pool;
let bootstrapPool = null;

function createUnavailablePool() {
  const unavailable = () =>
    Promise.reject(Object.assign(new Error("DATABASE_NOT_CONFIGURED"), { code: "DATABASE_NOT_CONFIGURED" }));
  return { query: unavailable, connect: unavailable, end: () => Promise.resolve() };
}

function createBootstrapPool(connectionString) {
  if (!connectionString || !String(connectionString).trim()) return null;
  return new Pool({
    connectionString: String(connectionString).trim(),
    // Keep PostgreSQL error messages in English regardless of server locale.
    options: "-c lc_messages=C",
  });
}

bootstrapPool = createBootstrapPool(process.env.DATABASE_URL);
pool = bootstrapPool ?? createUnavailablePool();

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

// ───────────────────────────────────────────────
// 🔁 Dynamic initialization function
// Replaces static config with a read from the `settings`
// ───────────────────────────────────────────────
export async function initDBConnection() {
  if (!bootstrapPool) {
    pool = createUnavailablePool();
    return;
  }

  try {
    // Replaces static config with a read from the `settings` table
    const result = await bootstrapPool.query(
      "SELECT key, value, value_encrypted, value_iv, value_auth_tag FROM v_b_settings WHERE section IN ('db', 'database')"
    );

    // Turn result rows into a key/value object (decrypted when needed)
    const config = Object.fromEntries(result.rows.map((r) => {
      let val = r.value;
      if (r.value_encrypted && r.value_iv && r.value_auth_tag) {
        try {
          val = decrypt(r.value_encrypted, r.value_iv, r.value_auth_tag);
        } catch (e) {
          // Silent decryption error
        }
      }
      return [r.key, val];
    }));

    const hasValidConfig =
      config.db_host &&
      config.db_name &&
      config.db_user &&
      config.db_port;

    if (!hasValidConfig) {
      throw new Error("Configuration DB incomplète dans v_b_settings");
    }

    // 🎯 Build the final pool from retrieved settings
    const dynamicPool = new Pool({
      host: config.db_host,
      port: parseInt(config.db_port, 10),
      database: config.db_name,
      user: config.db_user,
      password: String(config.db_password ?? ""),
      options: "-c lc_messages=C",
    });

    // ✅ Verify the connection works
    await dynamicPool.query("SELECT 1");

    // Reassign the global pool to this one
    pool = dynamicPool;
  } catch (err) {
    // Silent fallback to .env
    pool = bootstrapPool ?? createUnavailablePool();
  }
}

// 🔄 Reconfigure the bootstrap pool (used by the setup wizard)
export async function reconfigureBootstrapPool(connectionString) {
  if (bootstrapPool) {
    await bootstrapPool.end().catch(() => {});
  }
  bootstrapPool = createBootstrapPool(connectionString);
  pool = bootstrapPool ?? createUnavailablePool();
  if (bootstrapPool) {
    await initDBConnection();
  }
}

// ✨ Export the pool for the rest of the app
export { pool };
