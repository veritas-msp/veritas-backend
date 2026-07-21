import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { requirePro } from "../../middleware/edition.js";
import { pool, isDatabaseConfigured } from "../../database/db.js";
import { decryptSetting } from "../../utils/settingsHelper.js";
import { isPro } from "../../utils/edition.js";
import { DEFAULT_LOGIN_BRANDING, LOGIN_BRANDING_LABELS, LOGIN_BRANDING_SECTION, LOGIN_SIDES, buildPublicLoginBranding, normalizeLoginBrandingFlat } from "../../utils/loginBranding.js";
const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOGIN_BRANDING_UPLOAD_ROOT = path.join(__dirname, "..", "..", "uploads", "login-branding");
fs.mkdirSync(LOGIN_BRANDING_UPLOAD_ROOT, {
  recursive: true
});
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, LOGIN_BRANDING_UPLOAD_ROOT),
    filename: (req, file, cb) => {
      const side = LOGIN_SIDES.includes(req.params.side) ? req.params.side : "agent";
      const kind = req.params.kind === "background" ? "bg" : "logo";
      const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
      const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
      cb(null, `${side}-${kind}-${Date.now()}${safeExt}`);
    }
  }),
  limits: {
    fileSize: 2 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(new Error("Unsupported image format."));
    }
    return cb(null, true);
  }
});
async function readLoginBrandingFromDb() {
  if (!isDatabaseConfigured()) {
    return normalizeLoginBrandingFlat(DEFAULT_LOGIN_BRANDING);
  }
  try {
    const tableCheck = await pool.query("SELECT to_regclass('public.v_b_settings') AS settings_table");
    if (!tableCheck.rows[0]?.settings_table) {
      return normalizeLoginBrandingFlat(DEFAULT_LOGIN_BRANDING);
    }
    const result = await pool.query(`SELECT key, value, value_encrypted, value_iv, value_auth_tag
       FROM v_b_settings
       WHERE section = $1`, [LOGIN_BRANDING_SECTION]);
    const fromDb = {};
    for (const row of result.rows) {
      fromDb[row.key] = decryptSetting(row) ?? "";
    }
    return normalizeLoginBrandingFlat({
      ...DEFAULT_LOGIN_BRANDING,
      ...fromDb
    });
  } catch (err) {
    if (err?.code === "DATABASE_NOT_CONFIGURED" || err?.code === "42P01") {
      return normalizeLoginBrandingFlat(DEFAULT_LOGIN_BRANDING);
    }
    throw err;
  }
}
async function upsertLoginBrandingSetting(client, key, value) {
  await client.query(`INSERT INTO v_b_settings (key, value, label, section)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       label = EXCLUDED.label,
       section = EXCLUDED.section`, [key, String(value ?? ""), LOGIN_BRANDING_LABELS[key] || key, LOGIN_BRANDING_SECTION]);
}
router.get("/", async (_req, res) => {
  try {
    const flat = await readLoginBrandingFromDb();
    res.json(buildPublicLoginBranding(flat, {
      pro: isPro()
    }));
  } catch (err) {
    console.error("GET /login-branding", err);
    res.status(500).json({
      error: "Unable to load login customization."
    });
  }
});
router.get("/admin", verifyJWT, requireRole("admin"), requirePro, async (_req, res) => {
  try {
    const settings = await readLoginBrandingFromDb();
    res.json({
      settings
    });
  } catch (err) {
    console.error("GET /login-branding/admin", err);
    res.status(500).json({
      error: "Unable to load login customization."
    });
  }
});
router.patch("/", verifyJWT, requireRole("admin"), requirePro, async (req, res) => {
  const existing = await readLoginBrandingFromDb();
  const normalized = normalizeLoginBrandingFlat({
    ...existing,
    ...req.body
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of Object.entries(normalized)) {
      await upsertLoginBrandingSetting(client, key, value);
    }
    await client.query("COMMIT");
    res.json({
      success: true,
      settings: normalized
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /login-branding", err);
    res.status(500).json({
      error: "Unable to save login customization."
    });
  } finally {
    client.release();
  }
});
router.post("/:side/:kind", verifyJWT, requireRole("admin"), requirePro, (req, res) => {
  upload.single("file")(req, res, async err => {
    if (err) {
      const message = err.message || "Error during upload.";
      return res.status(400).json({
        error: message
      });
    }
    if (!req.file) {
      return res.status(400).json({
        error: "File required."
      });
    }
    const side = String(req.params.side || "");
    const kind = String(req.params.kind || "");
    if (!LOGIN_SIDES.includes(side) || !["logo", "background"].includes(kind)) {
      return res.status(400).json({
        error: "Invalid parameters."
      });
    }
    const relativePath = `/uploads/login-branding/${req.file.filename}`;
    const key = kind === "background" ? `app_login_${side}_bg_image_path` : `app_login_${side}_logo_path`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await upsertLoginBrandingSetting(client, key, relativePath);
      await client.query("COMMIT");
      res.json({
        success: true,
        path: relativePath,
        key
      });
    } catch (uploadErr) {
      await client.query("ROLLBACK");
      console.error("POST /login-branding upload", uploadErr);
      res.status(500).json({
        error: "Error saving file"
      });
    } finally {
      client.release();
    }
  });
});
router.delete("/:side/:kind", verifyJWT, requireRole("admin"), requirePro, async (req, res) => {
  const side = String(req.params.side || "");
  const kind = String(req.params.kind || "");
  if (!LOGIN_SIDES.includes(side) || !["logo", "background"].includes(kind)) {
    return res.status(400).json({
      error: "Invalid parameters."
    });
  }
  const key = kind === "background" ? `app_login_${side}_bg_image_path` : `app_login_${side}_logo_path`;
  const existing = await readLoginBrandingFromDb();
  const currentPath = existing[key];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await upsertLoginBrandingSetting(client, key, "");
    await client.query("COMMIT");
    if (currentPath && currentPath.startsWith("/uploads/login-branding/")) {
      const diskPath = path.join(LOGIN_BRANDING_UPLOAD_ROOT, path.basename(currentPath));
      fs.unlink(diskPath, () => {});
    }
    res.json({
      success: true
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DELETE /login-branding asset", err);
    res.status(500).json({
      error: "Unable to delete file."
    });
  } finally {
    client.release();
  }
});
export default router;
