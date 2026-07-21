import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { resolveFileUploadedBy } from "../../utils/fileUploadedBy.js";
import { ensureVisibleToClientColumn, hasVisibleToClientColumn, parseVisibleToClient, visibilitySelectSql } from "../../utils/clientFilesVisibility.js";
const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "..", "..", "uploads", "client-files");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, {
    recursive: true
  });
}
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/plain", "text/csv", "application/zip"]);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${timestamp}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  }
});
async function resolveVisibilitySelect() {
  await ensureVisibleToClientColumn();
  const hasVisibility = await hasVisibleToClientColumn();
  return visibilitySelectSql(hasVisibility);
}
router.get("/", verifyJWT, requirePermission("documents.view"), async (req, res) => {
  try {
    const {
      clientId,
      category
    } = req.query;
    const conditions = ["is_deleted = FALSE"];
    const values = [];
    if (clientId) {
      conditions.push(`client_id = $${values.length + 1}`);
      values.push(Number(clientId));
    }
    if (category && category !== "all") {
      conditions.push(`category = $${values.length + 1}`);
      values.push(category);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const visibilitySelect = await resolveVisibilitySelect();
    const result = await pool.query(`SELECT id, client_id, client_name, file_name, mime_type, size_bytes,
              category, description, uploaded_by, created_at, ${visibilitySelect}
       FROM v_b_client_files
       ${where}
       ORDER BY created_at DESC`, values);
    res.json(result.rows);
  } catch (err) {
    console.error("[GET /client-files]", err.message);
    res.status(500).json({
      error: "Error retrieving files"
    });
  }
});
router.post("/", verifyJWT, requirePermission("documents.create"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({
      error: "No file received."
    });
    const {
      clientId,
      clientName,
      category = "Autre",
      description = "",
      visibleToClient
    } = req.body;
    if (!clientId) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: "clientId required."
      });
    }
    await ensureVisibleToClientColumn();
    const hasVisibility = await hasVisibleToClientColumn();
    const shareWithClient = hasVisibility ? parseVisibleToClient(visibleToClient) : false;
    const columns = ["client_id", "client_name", "file_name", "file_path", "mime_type", "size_bytes", "category", "description", "uploaded_by"];
    const values = [Number(clientId), clientName || null, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, category, description, resolveFileUploadedBy(req.user)];
    if (hasVisibility) {
      columns.push("visible_to_client");
      values.push(shareWithClient);
    }
    const placeholders = values.map((_, index) => `$${index + 1}`);
    const returningVisibility = hasVisibility ? ", visible_to_client" : ", FALSE AS visible_to_client";
    const result = await pool.query(`INSERT INTO v_b_client_files (${columns.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING id, client_id, client_name, file_name, mime_type, size_bytes, category, description, created_at${returningVisibility}`, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error("[POST /client-files]", err.message);
    res.status(500).json({
      error: err.message || "Error during upload."
    });
  }
});
router.get("/:id/download", verifyJWT, requirePermission("documents.view"), async (req, res) => {
  try {
    const result = await pool.query(`SELECT file_path, file_name, mime_type FROM v_b_client_files WHERE id = $1 AND is_deleted = FALSE`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({
      error: "File not found."
    });
    const {
      file_path,
      file_name,
      mime_type
    } = result.rows[0];
    const fullPath = path.join(UPLOADS_DIR, file_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({
      error: "File missing on disk."
    });
    res.setHeader("Content-Type", mime_type);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file_name)}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    console.error("[GET /client-files/:id/download]", err.message);
    res.status(500).json({
      error: "Error during download."
    });
  }
});
router.get("/:id/preview", verifyJWT, requirePermission("documents.view"), async (req, res) => {
  try {
    const result = await pool.query(`SELECT file_path, file_name, mime_type FROM v_b_client_files WHERE id = $1 AND is_deleted = FALSE`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({
      error: "File not found."
    });
    const {
      file_path,
      file_name,
      mime_type
    } = result.rows[0];
    const fullPath = path.join(UPLOADS_DIR, file_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({
      error: "File missing on disk."
    });
    res.setHeader("Content-Type", mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file_name)}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    console.error("[GET /client-files/:id/preview]", err.message);
    res.status(500).json({
      error: "Error during preview."
    });
  }
});
router.patch("/:id", verifyJWT, requirePermission("documents.edit"), async (req, res) => {
  try {
    const role = String(req.user?.role || "").toLowerCase();
    if (role === "client") {
      return res.status(403).json({
        error: "Access restricted to agents."
      });
    }
    const hasDescription = req.body?.description !== undefined;
    const hasVisibility = req.body?.visibleToClient !== undefined || req.body?.visible_to_client !== undefined;
    if (!hasDescription && !hasVisibility) {
      return res.status(400).json({
        error: "No data to update."
      });
    }
    const sets = [];
    const values = [];
    if (hasDescription) {
      const description = String(req.body.description || "").trim();
      if (description.length > 2000) {
        return res.status(400).json({
          error: "Description too long (2000 characters max)."
        });
      }
      values.push(description);
      sets.push(`description = $${values.length}`);
    }
    if (hasVisibility) {
      await ensureVisibleToClientColumn();
      if (!(await hasVisibleToClientColumn())) {
        return res.status(503).json({
          error: "Portal visibility unavailable (migration in progress)."
        });
      }
      const visibleToClient = parseVisibleToClient(req.body.visibleToClient ?? req.body.visible_to_client);
      values.push(visibleToClient);
      sets.push(`visible_to_client = $${values.length}`);
    }
    values.push(req.params.id);
    const visibilitySelect = await resolveVisibilitySelect();
    const result = await pool.query(`UPDATE v_b_client_files
       SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length} AND is_deleted = FALSE
       RETURNING id, client_id, client_name, file_name, mime_type, size_bytes,
                 category, description, uploaded_by, created_at, ${visibilitySelect}`, values);
    if (!result.rows.length) {
      return res.status(404).json({
        error: "File not found."
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[PATCH /client-files/:id]", err.message);
    res.status(500).json({
      error: "Error updating document"
    });
  }
});
router.delete("/:id", verifyJWT, requirePermission("documents.delete"), async (req, res) => {
  try {
    const result = await pool.query(`UPDATE v_b_client_files SET is_deleted = TRUE, updated_at = NOW()
       WHERE id = $1 AND is_deleted = FALSE RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({
      error: "File not found or already deleted."
    });
    res.json({
      success: true
    });
  } catch (err) {
    console.error("[DELETE /client-files/:id]", err.message);
    res.status(500).json({
      error: "Error during deletion."
    });
  }
});
export default router;
