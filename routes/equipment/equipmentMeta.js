import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { loadEquipmentActivity } from "../../services/equipmentActivityService.js";
const router = express.Router();
const TAG_COLORS = ["#2b5fab", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#0891b2"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseEquipmentId(raw) {
  const value = String(raw || "").trim();
  return UUID_RE.test(value) ? value : null;
}
async function resolveClientId(rawId) {
  const result = await pool.query("SELECT id FROM v_b_clients WHERE id::text = $1 LIMIT 1", [String(rawId)]);
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
router.use(verifyJWT);
function parseClientIds(raw) {
  const parts = String(raw || "").split(",").map(value => value.trim()).filter(Boolean);
  const ids = [];
  for (const part of parts) {
    if (/^\d+$/.test(part)) ids.push(part);
  }
  return [...new Set(ids)];
}
router.get("/tags/batch", requirePermission("infrastructure.view"), async (req, res) => {
  try {
    const clientIds = parseClientIds(req.query.clientIds);
    if (!clientIds.length) return res.json([]);
    const result = await pool.query(`SELECT l.equipment_id::text AS equipment_id,
              l.client_id::text AS client_id,
              t.id,
              t.label,
              t.color
       FROM v_b_equipment_tag_links l
       JOIN v_b_client_tags t ON t.id = l.tag_id
       WHERE l.client_id::text = ANY($1::text[])
       ORDER BY l.equipment_id, t.label ASC`, [clientIds]);
    res.json(result.rows);
  } catch (err) {
    if (isMissingTableError(err)) return res.json([]);
    console.error("[GET /equipment/tags/batch]", err);
    res.status(500).json({
      error: "Error loading device tags"
    });
  }
});
router.get("/:equipmentId/activity", requirePermission("infrastructure.view"), async (req, res) => {
  try {
    const equipmentId = parseEquipmentId(req.params.equipmentId);
    if (!equipmentId) return res.status(400).json({
      error: "Invalid device ID"
    });
    const clientId = await resolveClientId(req.query.clientId);
    if (!clientId) return res.status(400).json({
      error: "clientId required"
    });
    const payload = await loadEquipmentActivity({
      equipmentId,
      clientId,
      startDate: req.query.startDate,
      endDate: req.query.endDate
    });
    res.json(payload);
  } catch (err) {
    if (err?.statusCode === 400) {
      return res.status(400).json({
        error: err.message
      });
    }
    console.error("[GET /equipment/:equipmentId/activity]", err);
    res.status(500).json({
      error: "Error loading device activity"
    });
  }
});
router.get("/:equipmentId/tags", requirePermission("infrastructure.view"), async (req, res) => {
  try {
    const equipmentId = parseEquipmentId(req.params.equipmentId);
    if (!equipmentId) return res.status(400).json({
      error: "Invalid device ID"
    });
    const clientId = await resolveClientId(req.query.clientId);
    if (!clientId) return res.status(400).json({
      error: "clientId required"
    });
    const result = await pool.query(`SELECT t.id, t.label, t.color, l.created_at AS linked_at
       FROM v_b_equipment_tag_links l
       JOIN v_b_client_tags t ON t.id = l.tag_id
       WHERE l.equipment_id = $1 AND l.client_id = $2
       ORDER BY t.label ASC`, [equipmentId, clientId]);
    res.json(result.rows);
  } catch (err) {
    if (isMissingTableError(err)) return res.json([]);
    console.error("[GET /equipment/:equipmentId/tags]", err);
    res.status(500).json({
      error: "Error loading device tags"
    });
  }
});
router.post("/:equipmentId/tags", requirePermission("infrastructure.edit"), async (req, res) => {
  try {
    const equipmentId = parseEquipmentId(req.params.equipmentId);
    if (!equipmentId) return res.status(400).json({
      error: "Invalid device ID"
    });
    const clientId = await resolveClientId(req.body?.clientId);
    if (!clientId) return res.status(400).json({
      error: "clientId required"
    });
    const label = String(req.body?.label || "").trim();
    if (!label) return res.status(400).json({
      error: "Tag label is required"
    });
    if (label.length > 64) {
      return res.status(400).json({
        error: "Label cannot exceed 64 characters"
      });
    }
    const color = req.body?.color || pickTagColor(label);
    const tagResult = await pool.query(`INSERT INTO v_b_client_tags (label, color, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (label)
       DO UPDATE SET color = COALESCE(EXCLUDED.color, v_b_client_tags.color)
       RETURNING *`, [label, color]);
    await pool.query(`INSERT INTO v_b_equipment_tag_links (equipment_id, client_id, tag_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (equipment_id, tag_id) DO NOTHING`, [equipmentId, clientId, tagResult.rows[0].id]);
    res.status(201).json(tagResult.rows[0]);
  } catch (err) {
    if (isMissingTableError(err)) {
      return res.status(503).json({
        error: "Device tags are not installed yet (migration required)"
      });
    }
    console.error("[POST /equipment/:equipmentId/tags]", err);
    res.status(500).json({
      error: "Error adding tag"
    });
  }
});
router.delete("/:equipmentId/tags/:tagId", requirePermission("infrastructure.edit"), async (req, res) => {
  try {
    const equipmentId = parseEquipmentId(req.params.equipmentId);
    if (!equipmentId) return res.status(400).json({
      error: "Invalid device ID"
    });
    const clientId = await resolveClientId(req.query.clientId);
    if (!clientId) return res.status(400).json({
      error: "clientId required"
    });
    await pool.query("DELETE FROM v_b_equipment_tag_links WHERE equipment_id = $1 AND client_id = $2 AND tag_id = $3", [equipmentId, clientId, req.params.tagId]);
    res.json({
      success: true
    });
  } catch (err) {
    if (isMissingTableError(err)) {
      return res.status(503).json({
        error: "Device tags are not installed yet (migration required)"
      });
    }
    console.error("[DELETE /equipment/:equipmentId/tags/:tagId]", err);
    res.status(500).json({
      error: "Error deleting tag"
    });
  }
});
export default router;
