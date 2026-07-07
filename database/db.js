// ───────────────────────────────────────────────
// 📦 Imports
// ───────────────────────────────────────────────
import pkg from "pg";                     // Import du module PostgreSQL
import dotenv from "dotenv";              // Charge les variables d'environnement
import { decrypt } from "../utils/encryption.js";
dotenv.config();                          // Active .env

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
  return new Pool({ connectionString: String(connectionString).trim() });
}

bootstrapPool = createBootstrapPool(process.env.DATABASE_URL);
pool = bootstrapPool ?? createUnavailablePool();

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

// ───────────────────────────────────────────────
// 🔁 Fonction d'initialisation dynamique
// Elle remplace la config statique par une lecture depuis la table `settings`
// ───────────────────────────────────────────────
export async function initDBConnection() {
  if (!bootstrapPool) {
    pool = createUnavailablePool();
    return;
  }

  try {
    // 🔍 Lecture des paramètres DB dans la section `db` de la table `settings`
    const result = await bootstrapPool.query(
      "SELECT key, value, value_encrypted, value_iv, value_auth_tag FROM v_b_settings WHERE section IN ('db', 'database')"
    );

    // Transforme le tableau de résultats en objet clé/valeur (décrypté si nécessaire)
    const config = Object.fromEntries(result.rows.map((r) => {
      let val = r.value;
      if (r.value_encrypted && r.value_iv && r.value_auth_tag) {
        try {
          val = decrypt(r.value_encrypted, r.value_iv, r.value_auth_tag);
        } catch (e) {
          // Erreur de déchiffrement silencieuse
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

    // 🎯 Création du pool final à partir des paramètres récupérés
    const dynamicPool = new Pool({
      host: config.db_host,
      port: parseInt(config.db_port, 10),
      database: config.db_name,
      user: config.db_user,
      password: String(config.db_password ?? ""),
    });

    // ✅ Vérifie que la connexion fonctionne
    await dynamicPool.query("SELECT 1");

    // Réaffecte le pool global à celui-ci
    pool = dynamicPool;
  } catch (err) {
    // Fallback silencieux vers .env
    pool = bootstrapPool ?? createUnavailablePool();
  }
}

// 🔄 Reconfigure le pool bootstrap (utilisé par l'assistant d'installation)
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

// ✨ Exporte le pool utilisable dans le reste de l'app
export { pool };
