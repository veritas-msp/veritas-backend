import pkg from "pg";
import dotenv from "dotenv";
import { decrypt } from "../utils/encryption.js";
dotenv.config();
const {
  Pool
} = pkg;
let pool;
let bootstrapPool = null;
function createUnavailablePool() {
  const unavailable = () => Promise.reject(Object.assign(new Error("DATABASE_NOT_CONFIGURED"), {
    code: "DATABASE_NOT_CONFIGURED"
  }));
  return {
    query: unavailable,
    connect: unavailable,
    end: () => Promise.resolve()
  };
}
function createBootstrapPool(connectionString) {
  if (!connectionString || !String(connectionString).trim()) return null;
  return new Pool({
    connectionString: String(connectionString).trim(),
    options: "-c lc_messages=C"
  });
}
bootstrapPool = createBootstrapPool(process.env.DATABASE_URL);
pool = bootstrapPool ?? createUnavailablePool();
export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}
export async function initDBConnection() {
  if (!bootstrapPool) {
    pool = createUnavailablePool();
    return;
  }
  try {
    const result = await bootstrapPool.query("SELECT key, value, value_encrypted, value_iv, value_auth_tag FROM v_b_settings WHERE section IN ('db', 'database')");
    const config = Object.fromEntries(result.rows.map(r => {
      let val = r.value;
      if (r.value_encrypted && r.value_iv && r.value_auth_tag) {
        try {
          val = decrypt(r.value_encrypted, r.value_iv, r.value_auth_tag);
        } catch (e) {}
      }
      return [r.key, val];
    }));
    const hasValidConfig = config.db_host && config.db_name && config.db_user && config.db_port;
    if (!hasValidConfig) {
      throw new Error("Incomplete DB configuration in v_b_settings");
    }
    const dynamicPool = new Pool({
      host: config.db_host,
      port: parseInt(config.db_port, 10),
      database: config.db_name,
      user: config.db_user,
      password: String(config.db_password ?? ""),
      options: "-c lc_messages=C"
    });
    await dynamicPool.query("SELECT 1");
    pool = dynamicPool;
  } catch (err) {
    pool = bootstrapPool ?? createUnavailablePool();
  }
}
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
export { pool };
