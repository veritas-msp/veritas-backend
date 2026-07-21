import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
const TAG_COLORS = ["#2b5fab", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#0891b2"];
function parseContactId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
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
export async function fetchTagsForContactId(contactId) {
  try {
    const result = await pool.query(`SELECT t.id, t.label, t.color, l.created_at AS linked_at
       FROM v_b_contact_tag_links l
       JOIN v_b_client_tags t ON t.id = l.tag_id
       WHERE l.contact_id = $1
       ORDER BY t.label ASC`, [contactId]);
    return result.rows;
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}
export async function fetchTagsByContactIdMap() {
  const byContactId = {};
  try {
    const result = await pool.query(`
      SELECT l.contact_id::text AS contact_id,
             t.id,
             t.label,
             t.color
      FROM v_b_contact_tag_links l
      JOIN v_b_client_tags t ON t.id = l.tag_id
      ORDER BY t.label ASC
    `);
    for (const row of result.rows) {
      const contactId = String(row.contact_id);
      if (!byContactId[contactId]) {
        byContactId[contactId] = [];
      }
      byContactId[contactId].push({
        id: row.id,
        label: row.label,
        color: row.color
      });
    }
  } catch (err) {
    if (isMissingTableError(err)) {
      console.warn("[contact-tags] tables missing, tags skipped");
      return byContactId;
    }
    throw err;
  }
  return byContactId;
}
export function attachContactTags(contacts, tagsByContactId = {}) {
  return contacts.map(contact => ({
    ...contact,
    tags: tagsByContactId[String(contact.id)] || []
  }));
}
export function registerContactMetaRoutes(router, {
  invalidateContactsListCache
} = {}) {
  router.get("/:id/tags", verifyJWT, async (req, res) => {
    try {
      const contactId = parseContactId(req.params.id);
      if (!contactId) return res.status(400).json({
        error: "Invalid ID contact"
      });
      const existing = await pool.query("SELECT id FROM v_b_contacts WHERE id = $1 LIMIT 1", [contactId]);
      if (existing.rows.length === 0) {
        return res.status(404).json({
          error: "Contact not found"
        });
      }
      const tags = await fetchTagsForContactId(contactId);
      res.json(tags);
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.json([]);
      }
      console.error("[GET /contacts/:id/tags]", err);
      res.status(500).json({
        error: "Error loading contact tags"
      });
    }
  });
  router.post("/:id/tags", verifyJWT, async (req, res) => {
    try {
      const contactId = parseContactId(req.params.id);
      if (!contactId) return res.status(400).json({
        error: "Invalid ID contact"
      });
      const existing = await pool.query("SELECT id, client_id FROM v_b_contacts WHERE id = $1 LIMIT 1", [contactId]);
      if (existing.rows.length === 0) {
        return res.status(404).json({
          error: "Contact not found"
        });
      }
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
      await pool.query(`INSERT INTO v_b_contact_tag_links (contact_id, tag_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (contact_id, tag_id) DO NOTHING`, [contactId, tagResult.rows[0].id]);
      invalidateContactsListCache?.(existing.rows[0].client_id);
      invalidateContactsListCache?.(null);
      res.status(201).json(tagResult.rows[0]);
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.status(503).json({
          error: "Contact tags are not installed yet (migration required)"
        });
      }
      console.error("[POST /contacts/:id/tags]", err);
      res.status(500).json({
        error: "Error adding tag"
      });
    }
  });
  router.delete("/:id/tags/:tagId", verifyJWT, async (req, res) => {
    try {
      const contactId = parseContactId(req.params.id);
      if (!contactId) return res.status(400).json({
        error: "Invalid ID contact"
      });
      const existing = await pool.query("SELECT id, client_id FROM v_b_contacts WHERE id = $1 LIMIT 1", [contactId]);
      if (existing.rows.length === 0) {
        return res.status(404).json({
          error: "Contact not found"
        });
      }
      await pool.query("DELETE FROM v_b_contact_tag_links WHERE contact_id = $1 AND tag_id = $2", [contactId, req.params.tagId]);
      invalidateContactsListCache?.(existing.rows[0].client_id);
      invalidateContactsListCache?.(null);
      res.json({
        success: true
      });
    } catch (err) {
      if (isMissingTableError(err)) {
        return res.status(503).json({
          error: "Contact tags are not installed yet (migration required)"
        });
      }
      console.error("[DELETE /contacts/:id/tags/:tagId]", err);
      res.status(500).json({
        error: "Error deleting tag"
      });
    }
  });
}
