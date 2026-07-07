import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import {
  archiveCreditPack,
  creditClientSupportTickets,
  getSupportCreditSummary,
  listAllSupportCreditPacks,
  updateCreditPack,
} from "../../services/supportCredits.js";

const TAG_COLORS = ["#2b5fab", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#0891b2"];

async function resolveClientId(rawId) {
  const result = await pool.query(
    "SELECT id FROM v_b_clients WHERE id::text = $1 LIMIT 1",
    [String(rawId)]
  );
  return result.rows[0]?.id ?? null;
}

function pickTagColor(label) {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash + label.charCodeAt(i) * (i + 1)) % TAG_COLORS.length;
  }
  return TAG_COLORS[hash];
}

function isMissingTableError(err) {
  return err?.code === "42P01";
}

function isAdminUser(req) {
  return String(req.user?.role || "").toLowerCase() === "admin";
}

export function registerClientMetaRoutes(router) {
  router.get("/support-credits/packs", verifyJWT, async (req, res) => {
    try {
      if (!isAdminUser(req)) {
        return res.status(403).json({ error: "Accès réservé aux administrateurs" });
      }
      const packs = await listAllSupportCreditPacks();
      res.json(packs);
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.json([]);
      }
      console.error("[GET /clients/support-credits/packs]", err);
      res.status(500).json({ error: "Erreur lors du chargement des carnets support" });
    }
  });

  router.get("/tags/catalog", verifyJWT, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, label, color, created_at
         FROM v_b_client_tags
         ORDER BY label ASC`
      );
      res.json(result.rows);
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.json([]);
      }
      console.error("[GET /clients/tags/catalog]", err);
      res.status(500).json({ error: "Erreur lors du chargement des étiquettes" });
    }
  });

  router.get("/:id/tags", verifyJWT, async (req, res) => {
    try {
      const clientId = await resolveClientId(req.params.id);
      if (!clientId) return res.status(404).json({ error: "Client introuvable" });

      const result = await pool.query(
        `SELECT t.id, t.label, t.color, l.created_at AS linked_at
         FROM v_b_client_tag_links l
         JOIN v_b_client_tags t ON t.id = l.tag_id
         WHERE l.client_id = $1
         ORDER BY t.label ASC`,
        [clientId]
      );
      res.json(result.rows);
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.json([]);
      }
      console.error("[GET /clients/:id/tags]", err);
      res.status(500).json({ error: "Erreur lors du chargement des étiquettes du client" });
    }
  });

  router.post("/:id/tags", verifyJWT, async (req, res) => {
    try {
      const clientId = await resolveClientId(req.params.id);
      if (!clientId) return res.status(404).json({ error: "Client introuvable" });

      const label = String(req.body?.label || "").trim();
      if (!label) return res.status(400).json({ error: "Le libellé de l'étiquette est requis" });
      if (label.length > 64) {
        return res.status(400).json({ error: "Le libellé ne peut pas dépasser 64 caractères" });
      }

      const color = req.body?.color || pickTagColor(label);

      const tagResult = await pool.query(
        `INSERT INTO v_b_client_tags (label, color, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (label)
         DO UPDATE SET color = COALESCE(EXCLUDED.color, v_b_client_tags.color)
         RETURNING *`,
        [label, color]
      );

      await pool.query(
        `INSERT INTO v_b_client_tag_links (client_id, tag_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (client_id, tag_id) DO NOTHING`,
        [clientId, tagResult.rows[0].id]
      );

      res.status(201).json(tagResult.rows[0]);
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.status(503).json({
          error: "Les étiquettes client ne sont pas encore installées (migration requise)",
        });
      }
      console.error("[POST /clients/:id/tags]", err);
      res.status(500).json({ error: "Erreur lors de l'ajout de l'étiquette" });
    }
  });

  router.delete("/:id/tags/:tagId", verifyJWT, async (req, res) => {
    try {
      const clientId = await resolveClientId(req.params.id);
      if (!clientId) return res.status(404).json({ error: "Client introuvable" });

      await pool.query(
        "DELETE FROM v_b_client_tag_links WHERE client_id = $1 AND tag_id = $2",
        [clientId, req.params.tagId]
      );
      res.json({ success: true });
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.status(503).json({
          error: "Les étiquettes client ne sont pas encore installées (migration requise)",
        });
      }
      console.error("[DELETE /clients/:id/tags/:tagId]", err);
      res.status(500).json({ error: "Erreur lors de la suppression de l'étiquette" });
    }
  });

  router.get("/:id/notes", verifyJWT, async (req, res) => {
    try {
      const clientId = await resolveClientId(req.params.id);
      if (!clientId) return res.status(404).json({ error: "Client introuvable" });

      const result = await pool.query(
        `SELECT n.id, n.client_id, n.user_id, n.content, n.created_at, n.updated_at,
                u.username, u.email
         FROM v_b_client_notes n
         LEFT JOIN v_b_users u ON u.id = n.user_id
         WHERE n.client_id = $1
         ORDER BY n.created_at DESC`,
        [clientId]
      );
      res.json(result.rows);
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.json([]);
      }
      console.error("[GET /clients/:id/notes]", err);
      res.status(500).json({ error: "Erreur lors du chargement des notes" });
    }
  });

  router.post("/:id/notes", verifyJWT, async (req, res) => {
    try {
      const clientId = await resolveClientId(req.params.id);
      if (!clientId) return res.status(404).json({ error: "Client introuvable" });

      const content = String(req.body?.content || "").trim();
      if (!content) return res.status(400).json({ error: "Le contenu de la note est requis" });

      const result = await pool.query(
        `INSERT INTO v_b_client_notes (client_id, user_id, content, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         RETURNING *`,
        [clientId, req.user?.id || null, content]
      );

      const note = result.rows[0];
      const userResult = await pool.query(
        "SELECT username, email FROM v_b_users WHERE id = $1",
        [req.user?.id]
      );
      const author = userResult.rows[0] || {};

      res.status(201).json({
        ...note,
        username: author.username || null,
        email: author.email || null,
      });
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.status(503).json({
          error: "Les notes client ne sont pas encore installées (migration requise)",
        });
      }
      console.error("[POST /clients/:id/notes]", err);
      res.status(500).json({ error: "Erreur lors de l'ajout de la note" });
    }
  });

  router.put("/:id/notes/:noteId", verifyJWT, async (req, res) => {
    try {
      const clientId = await resolveClientId(req.params.id);
      if (!clientId) return res.status(404).json({ error: "Client introuvable" });

      const existing = await pool.query(
        "SELECT * FROM v_b_client_notes WHERE id = $1 AND client_id = $2",
        [req.params.noteId, clientId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: "Note introuvable" });
      }

      const note = existing.rows[0];
      const isAdmin = String(req.user?.role || "").toLowerCase() === "admin";
      if (note.user_id !== req.user?.id && !isAdmin) {
        return res.status(403).json({ error: "Vous ne pouvez modifier que vos propres notes" });
      }

      const content = String(req.body?.content || "").trim();
      if (!content) return res.status(400).json({ error: "Le contenu de la note est requis" });

      const result = await pool.query(
        `UPDATE v_b_client_notes
         SET content = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [content, req.params.noteId]
      );

      const userResult = await pool.query(
        "SELECT username, email FROM v_b_users WHERE id = $1",
        [result.rows[0].user_id]
      );
      const author = userResult.rows[0] || {};

      res.json({
        ...result.rows[0],
        username: author.username || null,
        email: author.email || null,
      });
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.status(503).json({
          error: "Les notes client ne sont pas encore installées (migration requise)",
        });
      }
      console.error("[PUT /clients/:id/notes/:noteId]", err);
      res.status(500).json({ error: "Erreur lors de la modification de la note" });
    }
  });

  router.delete("/:id/notes/:noteId", verifyJWT, async (req, res) => {
    try {
      const clientId = await resolveClientId(req.params.id);
      if (!clientId) return res.status(404).json({ error: "Client introuvable" });

      const existing = await pool.query(
        "SELECT * FROM v_b_client_notes WHERE id = $1 AND client_id = $2",
        [req.params.noteId, clientId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: "Note introuvable" });
      }

      const note = existing.rows[0];
      const isAdmin = String(req.user?.role || "").toLowerCase() === "admin";
      if (note.user_id !== req.user?.id && !isAdmin) {
        return res.status(403).json({ error: "Vous ne pouvez supprimer que vos propres notes" });
      }

      await pool.query("DELETE FROM v_b_client_notes WHERE id = $1", [req.params.noteId]);
      res.json({ success: true });
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.status(503).json({
          error: "Les notes client ne sont pas encore installées (migration requise)",
        });
      }
      console.error("[DELETE /clients/:id/notes/:noteId]", err);
      res.status(500).json({ error: "Erreur lors de la suppression de la note" });
    }
  });

  router.get("/:id/support-credits", verifyJWT, async (req, res) => {
    try {
      const clientId = await resolveClientId(req.params.id);
      if (!clientId) return res.status(404).json({ error: "Client introuvable" });

      const summary = await getSupportCreditSummary(clientId);
      res.json(summary);
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.json({ balance: 0, ledger: [] });
      }
      console.error("[GET /clients/:id/support-credits]", err);
      res.status(500).json({ error: "Erreur lors du chargement des crédits support" });
    }
  });

  router.post("/:id/support-credits", verifyJWT, async (req, res) => {
    try {
      const isAdmin = String(req.user?.role || "").toLowerCase() === "admin";
      if (!isAdmin) {
        return res.status(403).json({ error: "Seuls les administrateurs peuvent créditer des carnets" });
      }

      const clientId = await resolveClientId(req.params.id);
      if (!clientId) return res.status(404).json({ error: "Client introuvable" });

      const amount = Number(req.body?.amount);
      const note = String(req.body?.note || "").trim() || null;
      const label = String(req.body?.label || "").trim() || null;
      const validFrom = req.body?.validFrom || req.body?.valid_from || null;
      const validUntil = req.body?.validUntil || req.body?.valid_until || null;

      const result = await creditClientSupportTickets(clientId, {
        amount,
        note,
        label,
        validFrom: validFrom || null,
        validUntil: validUntil || null,
        userId: req.user?.id || null,
      });

      res.status(201).json({
        balance: result.balance,
        pack: result.pack,
        entry: result.entry,
      });
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.status(503).json({
          error: "Les crédits support ne sont pas encore installés (migration requise)",
        });
      }
      if (err.status === 400) {
        return res.status(400).json({ error: err.message });
      }
      console.error("[POST /clients/:id/support-credits]", err);
      res.status(500).json({ error: "Erreur lors du crédit des tickets support" });
    }
  });

  router.put("/:id/support-credits/packs/:packId", verifyJWT, async (req, res) => {
    try {
      if (!isAdminUser(req)) {
        return res.status(403).json({ error: "Accès réservé aux administrateurs" });
      }
      const clientId = await resolveClientId(req.params.id);
      if (!clientId) return res.status(404).json({ error: "Client introuvable" });

      const result = await updateCreditPack(clientId, req.params.packId, req.body || {}, req.user?.id || null);
      res.json(result);
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.status(503).json({
          error: "Les crédits support ne sont pas encore installés (migration requise)",
        });
      }
      if (err.status === 400 || err.status === 404) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error("[PUT /clients/:id/support-credits/packs/:packId]", err);
      res.status(500).json({ error: "Erreur lors de la modification du carnet" });
    }
  });

  router.delete("/:id/support-credits/packs/:packId", verifyJWT, async (req, res) => {
    try {
      if (!isAdminUser(req)) {
        return res.status(403).json({ error: "Accès réservé aux administrateurs" });
      }
      const clientId = await resolveClientId(req.params.id);
      if (!clientId) return res.status(404).json({ error: "Client introuvable" });

      const result = await archiveCreditPack(clientId, req.params.packId, req.user?.id || null);
      res.json(result);
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.status(503).json({
          error: "Les crédits support ne sont pas encore installés (migration requise)",
        });
      }
      if (err.status === 404) {
        return res.status(404).json({ error: err.message });
      }
      console.error("[DELETE /clients/:id/support-credits/packs/:packId]", err);
      res.status(500).json({ error: "Erreur lors de la suppression du carnet" });
    }
  });
}
