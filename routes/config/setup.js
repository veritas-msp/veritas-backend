import express from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { body, validationResult } from "express-validator";
import { Pool } from "pg";

import { getSetupStatus, markSetupComplete } from "../../utils/setupState.js";
import { writeEnvFile, writeFrontendEnvFile } from "../../utils/envFile.js";
import { getEdition } from "../../utils/edition.js";
import { getMigrationProgress, runNextPendingMigration, runPendingMigrations } from "../../utils/runMigrations.js";
import { requireSetupIncomplete } from "../../middleware/setupGuard.js";
import { setupRateLimit, setupMigrateRateLimit } from "../../middleware/rateLimit.js";
import { reconfigureBootstrapPool } from "../../database/db.js";
import { pool } from "../../database/db.js";
import { runPostSetupSchemaMigrations } from "../../services/runPostSetupSchemaMigrations.js";
import {
  buildDatabaseUrl,
  saveDatabaseSettings,
} from "../../utils/databaseConfigStore.js";
import { validateStrongPassword } from "../../utils/passwordPolicy.js";
import {
  generateMfaSecret,
  buildOtpAuthUrl,
  generateQrDataUrl,
  verifyTotp,
} from "../../utils/mfa.js";

const router = express.Router();

router.use((req, res, next) => {
  const isMigrate =
    req.path === "/migrate" || req.path.startsWith("/migrations/");
  const limiter = isMigrate ? setupMigrateRateLimit : setupRateLimit;
  return limiter(req, res, next);
});

function generateSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function derivePortFromApiUrl(apiBaseUrl, fallback = 3001) {
  try {
    const url = new URL(String(apiBaseUrl || "").trim());
    if (url.port) return parseInt(url.port, 10);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return fallback;
  }
}

// GET /api/setup/status — État de l'installation (public)
router.get("/status", async (_req, res) => {
  try {
    const status = await getSetupStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: "Unable to read installation status.",
      code: "SETUP_STATUS_READ_FAILED",
    });
  }
});

// GET /api/setup/generate-secrets — Génère des secrets aléatoires
router.get("/generate-secrets", requireSetupIncomplete, (_req, res) => {
  res.json({
    jwtSecret: generateSecret(32),
    encryptionKey: generateSecret(32),
  });
});

// POST /api/setup/env — Écrit les variables d'environnement essentielles
router.post(
  "/env",
  requireSetupIncomplete,
  [
    body("jwtSecret").optional().isString().isLength({ min: 16 }),
    body("encryptionKey").optional().isString().isLength({ min: 16 }),
    body("allowedOrigins").optional().isString(),
    body("frontendBaseUrl").optional().isString(),
    body("apiBaseUrl").optional().isString(),
    body("port").optional().isInt({ min: 1, max: 65535 }),
    body("edition").optional().isIn(["community", "pro"]),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        code: "SETUP_VALIDATION_FAILED",
        error: "Invalid request.",
        errors: errors.array(),
      });
    }

    const jwtSecret = req.body.jwtSecret || generateSecret(32);
    const encryptionKey = req.body.encryptionKey || generateSecret(32);
    const allowedOrigins = req.body.allowedOrigins || "http://localhost:3000";
    const frontendBaseUrl = req.body.frontendBaseUrl || "http://localhost:3000";
    const apiBaseUrl =
      req.body.apiBaseUrl ||
      (req.body.port ? `http://localhost:${req.body.port}` : "http://localhost:3001");
    const port = req.body.port || derivePortFromApiUrl(apiBaseUrl);
    const edition = req.body.edition || getEdition() || "community";

    try {
      writeEnvFile({
        JWT_SECRET: jwtSecret,
        ENCRYPTION_KEY: encryptionKey,
        ALLOWED_ORIGINS: allowedOrigins,
        FRONTEND_BASE_URL: frontendBaseUrl,
        PORT: String(port),
        NODE_ENV: process.env.NODE_ENV || "development",
        VERITAS_EDITION: edition,
      });

      writeFrontendEnvFile({
        REACT_APP_API_BASE_URL: apiBaseUrl.replace(/\/+$/, "").replace(/\/api$/, ""),
        REACT_APP_VERITAS_EDITION: edition,
      });

      const status = await getSetupStatus();
      res.json({
        success: true,
        message: "Variables d'environnement enregistrées.",
        steps: status.steps,
        frontendEnvUpdated: true,
      });
    } catch (err) {
      console.error("POST /setup/env", err);
      res.status(500).json({
        error: "Unable to write the environment file.",
        code: "SETUP_ENV_WRITE_FAILED",
      });
    }
  }
);

// POST /api/setup/database — Teste et enregistre la connexion PostgreSQL
router.post(
  "/database",
  requireSetupIncomplete,
  [
    body("db_host").isString().trim().notEmpty(),
    body("db_port").isInt({ min: 1, max: 65535 }),
    body("db_user").isString().trim().notEmpty(),
    body("db_password").isString(),
    body("db_name").isString().trim().notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        code: "SETUP_VALIDATION_FAILED",
        error: "Invalid request.",
        errors: errors.array(),
      });
    }

    const { db_host, db_port, db_user, db_password, db_name } = req.body;

    const testPool = new Pool({
      host: db_host,
      port: parseInt(db_port, 10),
      user: db_user,
      password: db_password,
      database: db_name,
      connectionTimeoutMillis: 8000,
    });

    try {
      const client = await testPool.connect();
      await client.query("SELECT 1");
      client.release();
      await testPool.end();

      const databaseUrl = buildDatabaseUrl({ db_host, db_port, db_user, db_password, db_name });
      writeEnvFile({ DATABASE_URL: databaseUrl });
      await reconfigureBootstrapPool(databaseUrl);

      try {
        await saveDatabaseSettings({ db_host, db_port: String(db_port), db_user, db_password, db_name });
      } catch {
        // La table v_b_settings n'existe pas encore — normal avant les migrations
      }

      const status = await getSetupStatus();
      res.json({
        success: true,
        message: "Connexion à la base de données validée.",
        steps: status.steps,
      });
    } catch (err) {
      await testPool.end().catch(() => {});
      res.status(500).json({
        success: false,
        error: "Unable to connect to the database.",
        code: "SETUP_DB_CONNECTION_FAILED",
        details: err.message,
      });
    }
  }
);

async function finalizeMigrationsAfterRun() {
  const envUrl = process.env.DATABASE_URL;
  if (envUrl) {
    try {
      const url = new URL(envUrl);
      await saveDatabaseSettings({
        db_host: url.hostname,
        db_port: url.port || "5432",
        db_user: decodeURIComponent(url.username),
        db_password: decodeURIComponent(url.password),
        db_name: url.pathname.replace(/^\//, ""),
      });
      await reconfigureBootstrapPool(envUrl);
    } catch {
      // Non bloquant
    }
  }
}

// GET /api/setup/migrations/pending — Progression des migrations (installation)
router.get("/migrations/pending", requireSetupIncomplete, async (_req, res) => {
  try {
    const progress = await getMigrationProgress();
    res.json(progress);
  } catch (err) {
    console.error("GET /setup/migrations/pending", err);
    res.status(500).json({
      error: err.message || "Unable to read pending migrations.",
      code: "SETUP_MIGRATIONS_LIST_FAILED",
    });
  }
});

// POST /api/setup/migrate — Applique les migrations (toutes ou une par une)
router.post("/migrate", requireSetupIncomplete, async (req, res) => {
  try {
    const stepByStep =
      req.body?.stepByStep === true ||
      req.query.step === "1" ||
      req.query.stepByStep === "1";

    if (stepByStep) {
      const result = await runNextPendingMigration();

      if (result.done) {
        await finalizeMigrationsAfterRun();
        const status = await getSetupStatus();
        return res.json({
          success: true,
          done: true,
          executed: null,
          progress: result.progress,
          steps: status.steps,
        });
      }

      return res.json({
        success: true,
        done: false,
        executed: result.executed,
        progress: result.progress,
      });
    }

    const result = await runPendingMigrations();
    await finalizeMigrationsAfterRun();

    const status = await getSetupStatus();
    res.json({
      success: true,
      done: true,
      executed: result.executed,
      totalMigrations: result.total,
      progress: {
        total: result.total,
        completed: result.total,
        remaining: 0,
      },
      steps: status.steps,
    });
  } catch (err) {
    console.error("POST /setup/migrate", err);
    res.status(500).json({
      error: err.message || "Database preparation failed.",
      code: "SETUP_MIGRATION_FAILED",
    });
  }
});

async function getSetupAdminUser() {
  const { rows } = await pool.query(
    `SELECT id, email, COALESCE(mfa_enabled, false) AS mfa_enabled, mfa_secret
     FROM v_b_users
     WHERE role = 'admin' AND is_active = TRUE
     LIMIT 1`
  );
  return rows[0] || null;
}

// POST /api/setup/admin — Crée le compte administrateur initial
router.post(
  "/admin",
  requireSetupIncomplete,
  [
    body("email").isEmail(),
    body("password").isString(),
    body("username").optional().isString().trim().isLength({ min: 2, max: 50 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        code: "SETUP_VALIDATION_FAILED",
        error: "Invalid request.",
        errors: errors.array(),
      });
    }

    const { email, password, username } = req.body;
    const normalizedEmail = String(email).trim().toLowerCase();
    const passwordCheck = validateStrongPassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({
        code: "SETUP_PASSWORD_WEAK",
        error: "Password does not meet security requirements.",
        requirements: passwordCheck.codes,
      });
    }

    try {
      const existing = await pool.query(
        `SELECT 1 FROM v_b_users WHERE role = 'admin' LIMIT 1`
      );
      if (existing.rows.length > 0) {
        const admin = await getSetupAdminUser();
        if (admin && !admin.mfa_enabled) {
          return res.json({
            success: true,
            alreadyExists: true,
            message: "Administrator account already exists. Continue with MFA setup.",
            adminId: admin.id,
            mfaRequired: true,
          });
        }
        return res.status(409).json({
          error: "An administrator account already exists.",
          code: "SETUP_ADMIN_ALREADY_EXISTS",
        });
      }

      const hash = await bcrypt.hash(password, 10);
      const id = randomUUID();

      await pool.query(
        `INSERT INTO v_b_users (id, email, username, password_hash, role, profile, is_active)
         VALUES ($1, $2, $3, $4, 'admin', 'Administrateur', TRUE)`,
        [id, normalizedEmail, username || normalizedEmail.split("@")[0], hash]
      );

      res.json({
        success: true,
        message: "Administrator account created. Configure MFA to finish setup.",
        adminId: id,
        mfaRequired: true,
      });
    } catch (err) {
      console.error("POST /setup/admin", err);
      res.status(500).json({
        error: "Unable to create the administrator account.",
        code: "SETUP_ADMIN_CREATE_FAILED",
      });
    }
  }
);

// POST /api/setup/admin/mfa/setup — Génère le secret MFA pour l'admin initial
router.post("/admin/mfa/setup", requireSetupIncomplete, async (_req, res) => {
  try {
    const user = await getSetupAdminUser();
    if (!user) {
      return res.status(400).json({
        error: "Create the administrator account first.",
        code: "SETUP_ADMIN_MISSING",
      });
    }
    if (user.mfa_enabled) {
      return res.status(400).json({
        error: "MFA is already enabled for the administrator.",
        code: "SETUP_MFA_ALREADY_ENABLED",
      });
    }

    const secret = generateMfaSecret();
    await pool.query("UPDATE v_b_users SET mfa_secret = $1 WHERE id = $2", [secret, user.id]);

    const otpauthUrl = buildOtpAuthUrl(user.email, secret);
    const qrCodeDataUrl = await generateQrDataUrl(otpauthUrl);

    res.json({ secret, otpauthUrl, qrCodeDataUrl });
  } catch (err) {
    console.error("POST /setup/admin/mfa/setup", err);
    res.status(500).json({
      error: "Unable to start MFA setup.",
      code: "SETUP_MFA_SETUP_FAILED",
    });
  }
});

// POST /api/setup/admin/mfa/verify — Active le MFA et termine l'installation
router.post(
  "/admin/mfa/verify",
  requireSetupIncomplete,
  [body("code").isString().trim().isLength({ min: 6, max: 8 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        code: "SETUP_VALIDATION_FAILED",
        error: "Invalid request.",
        errors: errors.array(),
      });
    }

    const { code } = req.body;

    try {
      const user = await getSetupAdminUser();
      if (!user) {
        return res.status(400).json({
          error: "Create the administrator account first.",
          code: "SETUP_ADMIN_MISSING",
        });
      }
      if (user.mfa_enabled) {
        return res.status(400).json({
          error: "MFA is already enabled for the administrator.",
          code: "SETUP_MFA_ALREADY_ENABLED",
        });
      }
      if (!user.mfa_secret) {
        return res.status(400).json({
          error: "MFA setup has not been started.",
          code: "SETUP_MFA_NOT_STARTED",
        });
      }

      if (!verifyTotp(code, user.mfa_secret)) {
        return res.status(400).json({
          error: "Invalid code. Try again.",
          code: "SETUP_MFA_INVALID_CODE",
        });
      }

      await pool.query("UPDATE v_b_users SET mfa_enabled = true WHERE id = $1", [user.id]);

      markSetupComplete();
      await runPostSetupSchemaMigrations();

      res.json({
        success: true,
        message: "MFA enabled. Installation complete.",
        mfa_enabled: true,
      });
    } catch (err) {
      console.error("POST /setup/admin/mfa/verify", err);
      res.status(500).json({
        error: "Unable to verify MFA code.",
        code: "SETUP_MFA_VERIFY_FAILED",
      });
    }
  }
);

export default router;
