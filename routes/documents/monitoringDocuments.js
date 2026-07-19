import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { dispatchNotificationEvent } from "../../services/notificationDispatcher.js";

const router = express.Router();

// ───────────────────────────────────────────────
// 📚 GET /api/monitoring-documents — List monitoring documents
// For admins: all documents
// For users: only their own documents
// ───────────────────────────────────────────────
router.get("/", verifyJWT, requirePermission("documents.view"), async (req, res) => {
  const userId = req.user.id;
  const isAdmin = req.user.role === 'admin';

  try {
    let result;
    if (isAdmin) {
      // 📚 GET /api/monitoring-documents — List monitoring documents
      result = await pool.query(
        `SELECT md.id, md.name, md.report_period, md.config, md.data, 
                md.created_at, md.updated_at, md.is_trashed, md.user_id,
                md.client_name,
                u.email AS user_email, u.username
         FROM v_b_d_monitoring md
         LEFT JOIN v_b_users u ON u.id = md.user_id
         ORDER BY md.created_at DESC`
      );
    } else {
      // User: only their own documents (including those in trash)
      result = await pool.query(
        `SELECT md.id, md.name, md.report_period, md.config, md.data, 
                md.created_at, md.updated_at, md.is_trashed, md.user_id,
                md.client_name,
                u.email AS user_email, u.username
         FROM v_b_d_monitoring md
         LEFT JOIN v_b_users u ON u.id = md.user_id
         WHERE md.user_id = $1
         ORDER BY md.created_at DESC`,
        [userId]
      );
    }

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la récupération des documents." });
  }
});

// ───────────────────────────────────────────────
// ───────────────────────────────────────────────
// ───────────────────────────────────────────────
router.get("/:id", verifyJWT, requirePermission("documents.view"), async (req, res) => {
  const docId = req.params.id;
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT id, name, client_name, report_period, config, data, created_at, updated_at, is_trashed
       FROM v_b_d_monitoring
       WHERE id = $1 AND user_id = $2`,
      [docId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Document introuvable ou accès refusé." });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la récupération du document." });
  }
});

// ───────────────────────────────────────────────
// 💾 POST /api/monitoring-documents — Create or update a document
// ───────────────────────────────────────────────
router.post("/", verifyJWT, requirePermission("documents.create"), async (req, res) => {
  const { name, client_name, report_period, config, data, overwrite } = req.body;
  const userId = req.user.id;
  if (!name || !client_name || !config || !data) {
    return res.status(400).json({ error: "Champs requis manquants." });
  }

  try {
    // Check whether a document with the same name already exists for the candidate user
    const check = await pool.query(
      `SELECT id FROM v_b_d_monitoring
       WHERE user_id = $1 AND name = $2`,
      [userId, name]
    );

    let documentId;
    if (check.rows.length > 0) {
      if (overwrite) {
        documentId = check.rows[0].id;
        
        // Update existing document
        await pool.query(
          `UPDATE v_b_d_monitoring
           SET client_name = $1, 
               report_period = $2, 
               config = $3, 
               data = $4,
               updated_at = NOW()
           WHERE id = $5 AND user_id = $6`,
          [client_name, report_period, config, data, documentId, userId]
        );
        await dispatchNotificationEvent({
          source: "rapport",
          element: "updated",
          user: req.user,
          context: {
            report: { id: documentId, name, client_name, report_period },
          },
        }).catch(() => {});
        return res.json({ success: true, id: documentId, message: "Document mis à jour avec succès." });
      } else {
        return res.status(200).json({ success: false, message: "Document déjà enregistré avec ce nom." });
      }
    } else {
      // Otherwise, insertion
      const result = await pool.query(
        `INSERT INTO v_b_d_monitoring (name, user_id, client_name, report_period, config, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW(), NOW())
         RETURNING id`,
        [name, userId, client_name, report_period, config, data]
      );
      documentId = result.rows[0].id;
      await dispatchNotificationEvent({
        source: "rapport",
        element: "generated",
        user: req.user,
        context: {
          report: { id: documentId, name, client_name, report_period },
        },
      }).catch(() => {});
      return res.json({ success: true, id: documentId, message: "Document créé avec succès." });
    }
  } catch (err) {
    console.error("[POST /monitoring-documents]", err.message, err.stack);
    res.status(500).json({ error: err.message || "Erreur lors de la sauvegarde du document." });
  }
});

// ───────────────────────────────────────────────
// 🗑️ DELETE /api/monitoring-documents/:id — Move a document to trash
// Admin can delete any document; users only their own
// ───────────────────────────────────────────────
router.delete("/:id", verifyJWT, requirePermission("documents.delete"), async (req, res) => {
  const docId = req.params.id;
  const userId = req.user.id;
  const isAdmin = req.user.role === 'admin';

  try {
    const result = await pool.query(
      isAdmin
        ? `UPDATE v_b_d_monitoring
           SET is_trashed = TRUE, updated_at = NOW()
           WHERE id = $1
           RETURNING id`
        : `UPDATE v_b_d_monitoring
           SET is_trashed = TRUE, updated_at = NOW()
           WHERE id = $1 AND user_id = $2
           RETURNING id`,
      isAdmin ? [docId] : [docId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Document introuvable ou accès refusé." });
    }

    res.json({ success: true, message: "Document mis à la corbeille." });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la suppression du document." });
  }
});

// ───────────────────────────────────────────────
// 🔄 PUT /api/monitoring-documents/:id — Update an existing document
// ───────────────────────────────────────────────
router.put("/:id", verifyJWT, requirePermission("documents.edit"), async (req, res) => {
  const docId = req.params.id;
  const userId = req.user.id;
  const { name, client_name, report_period, config, data } = req.body;

  if (!name || !client_name || !config || !data) {
    return res.status(400).json({ error: "Champs requis manquants." });
  }

  try {
    const result = await pool.query(
      `UPDATE v_b_d_monitoring
       SET name = $1,
           client_name = $2,
           report_period = $3,
           config = $4::jsonb,
           data = $5::jsonb,
           updated_at = NOW()
       WHERE id = $6 AND user_id = $7
       RETURNING id`,
      [name, client_name, report_period, config, data, docId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Document introuvable ou accès refusé." });
    }

    await dispatchNotificationEvent({
      source: "rapport",
      element: "updated",
      user: req.user,
      context: {
        report: { id: docId, name, client_name, report_period },
      },
    }).catch(() => {});

    res.json({ success: true, message: "Document mis à jour avec succès." });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la mise à jour du document." });
  }
});

// ───────────────────────────────────────────────
// 📝 PATCH /api/monitoring-documents/:id — Modifier only nom a document
// ───────────────────────────────────────────────
router.patch("/:id", verifyJWT, requirePermission("documents.edit"), async (req, res) => {
  const docId = req.params.id;
  const userId = req.user.id;
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Nom requis." });
  }

  try {
    const result = await pool.query(
      `UPDATE v_b_d_monitoring
       SET name = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING id`,
      [name, docId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Document introuvable ou accès refusé." });
    }

    res.json({ success: true, message: "Nom du document mis à jour." });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la mise à jour du nom." });
  }
});

// ───────────────────────────────────────────────
// 🔄 POST /api/monitoring-documents/:id/restore — Restore a document from trash
// Admin can restore any document; users only their own
// ───────────────────────────────────────────────
router.post("/:id/restore", verifyJWT, requirePermission("documents.edit"), async (req, res) => {
  const docId = req.params.id;
  const userId = req.user.id;
  const isAdmin = req.user.role === 'admin';

  try {
    const result = await pool.query(
      isAdmin
        ? `UPDATE v_b_d_monitoring
           SET is_trashed = FALSE, updated_at = NOW()
           WHERE id = $1
           RETURNING id`
        : `UPDATE v_b_d_monitoring
           SET is_trashed = FALSE, updated_at = NOW()
           WHERE id = $1 AND user_id = $2
           RETURNING id`,
      isAdmin ? [docId] : [docId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Document introuvable ou accès refusé." });
    }

    res.json({ success: true, message: "Document restauré." });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la restauration du document." });
  }
});

// ───────────────────────────────────────────────
// ───────────────────────────────────────────────
// ───────────────────────────────────────────────
router.delete("/:id/purge", verifyJWT, requirePermission("documents.delete"), async (req, res) => {
  const docId = req.params.id;
  const userId = req.user.id;
  const isAdmin = req.user.role === 'admin';

  try {
    const result = await pool.query(
      isAdmin
        ? `DELETE FROM v_b_d_monitoring WHERE id = $1 RETURNING id`
        : `DELETE FROM v_b_d_monitoring WHERE id = $1 AND user_id = $2 RETURNING id`,
      isAdmin ? [docId] : [docId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Document introuvable ou accès refusé." });
    }

    res.json({ success: true, message: "Document définitivement supprimé." });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la suppression définitive." });
  }
});

export default router;

