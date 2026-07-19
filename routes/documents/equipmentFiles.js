import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { isUuid, resolveFileUploadedBy } from "../../utils/fileUploadedBy.js";

const router = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "..", "..", "uploads", "equipment-files");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${timestamp}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Type de fichier non autorisé : ${file.mimetype}`));
    }
  },
});

router.get("/", verifyJWT, requirePermission("documents.view"), async (req, res) => {
  try {
    const { equipmentId, clientId } = req.query;
    const conditions = ["is_deleted = FALSE"];
    const values = [];

    if (equipmentId) {
      conditions.push(`equipment_id = $${values.length + 1}`);
      values.push(String(equipmentId));
    }
    if (clientId) {
      conditions.push(`client_id = $${values.length + 1}`);
      values.push(Number(clientId));
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT id, client_id, equipment_id, equipment_type, equipment_name,
              file_name, mime_type, size_bytes, category, description, uploaded_by, created_at
       FROM v_b_equipment_files
       ${where}
       ORDER BY created_at DESC`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[GET /equipment-files]", err.message);
    res.status(500).json({ error: "Erreur lors de la récupération des fichiers." });
  }
});

router.post("/", verifyJWT, requirePermission("documents.create"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });

    const {
      clientId,
      equipmentId,
      equipmentType = "",
      equipmentName = "",
      category = "Autre",
      description = "",
    } = req.body;

    if (!clientId || !equipmentId) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "clientId et equipmentId requis." });
    }

    if (!isUuid(equipmentId)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Identifiant matériel invalide." });
    }

    const result = await pool.query(
      `INSERT INTO v_b_equipment_files
         (client_id, equipment_id, equipment_type, equipment_name, file_name, file_path,
          mime_type, size_bytes, category, description, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, client_id, equipment_id, equipment_type, equipment_name, file_name,
                 mime_type, size_bytes, category, description, created_at`,
      [
        Number(clientId),
        String(equipmentId),
        equipmentType || null,
        equipmentName || null,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        category,
        description,
        resolveFileUploadedBy(req.user),
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error("[POST /equipment-files]", err.message);
    const message =
      err.message?.includes("bigint") && err.message?.includes("uuid")
        ? "Erreur de schéma base de données (uploaded_by). Relancez le serveur pour appliquer les migrations."
        : err.message || "Erreur lors de l'upload.";
    res.status(500).json({ error: message });
  }
});

router.get("/:id/download", verifyJWT, requirePermission("documents.view"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT file_path, file_name, mime_type FROM v_b_equipment_files WHERE id = $1 AND is_deleted = FALSE`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Fichier introuvable." });

    const { file_path, file_name, mime_type } = result.rows[0];
    const fullPath = path.join(UPLOADS_DIR, file_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "Fichier manquant sur le disque." });

    res.setHeader("Content-Type", mime_type);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file_name)}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    console.error("[GET /equipment-files/:id/download]", err.message);
    res.status(500).json({ error: "Erreur lors du téléchargement." });
  }
});

router.get("/:id/preview", verifyJWT, requirePermission("documents.view"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT file_path, file_name, mime_type FROM v_b_equipment_files WHERE id = $1 AND is_deleted = FALSE`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Fichier introuvable." });

    const { file_path, file_name, mime_type } = result.rows[0];
    const fullPath = path.join(UPLOADS_DIR, file_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "Fichier manquant sur le disque." });

    res.setHeader("Content-Type", mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file_name)}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    console.error("[GET /equipment-files/:id/preview]", err.message);
    res.status(500).json({ error: "Erreur lors de la prévisualisation." });
  }
});

router.delete("/:id", verifyJWT, requirePermission("documents.delete"), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE v_b_equipment_files SET is_deleted = TRUE, updated_at = NOW()
       WHERE id = $1 AND is_deleted = FALSE RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Fichier introuvable ou déjà supprimé." });
    res.json({ success: true });
  } catch (err) {
    console.error("[DELETE /equipment-files/:id]", err.message);
    res.status(500).json({ error: "Erreur lors de la suppression." });
  }
});

export default router;
