import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { deletePortalUserForContact, resetPortalPassword } from "../../utils/contactPortal.js";
import { assertCommunityClientPortalLimit, sendCommunityLimitError } from "../../utils/communityLimits.js";
const router = express.Router();
router.get("/", verifyJWT, requireRole("admin"), async (_req, res) => {
  try {
    const {
      rows
    } = await pool.query(`SELECT u.id,
              u.email,
              u.username,
              u.is_active,
              u.client_id,
              u.contact_id,
              u.last_login_at,
              u.created_at,
              c.nom AS contact_nom,
              c.prenom AS contact_prenom,
              c.statut AS contact_statut,
              cli.name AS client_name
       FROM v_b_users u
       LEFT JOIN v_b_contacts c ON c.id = u.contact_id
       LEFT JOIN v_b_clients cli ON cli.id = u.client_id
       WHERE u.role = 'client'
       ORDER BY cli.name NULLS LAST, c.nom NULLS LAST, u.email`);
    res.json(rows);
  } catch (err) {
    console.error("GET /client-portal-users", err);
    res.status(500).json({
      error: "Error retrieving portal users"
    });
  }
});
router.patch("/:id", verifyJWT, requireRole("admin"), async (req, res) => {
  const {
    id
  } = req.params;
  if (req.body?.is_active === undefined) {
    return res.status(400).json({
      error: "Champ is_active required."
    });
  }
  try {
    if (req.body?.is_active === true) {
      const {
        rows: currentRows
      } = await pool.query(`SELECT is_active FROM v_b_users WHERE id = $1 AND role = 'client'`, [id]);
      if (!currentRows[0]) return res.status(404).json({
        error: "User not found."
      });
      if (!currentRows[0].is_active) {
        await assertCommunityClientPortalLimit(1);
      }
    }
    const {
      rows
    } = await pool.query(`UPDATE v_b_users SET is_active = $1
       WHERE id = $2 AND role = 'client'
       RETURNING id, email, is_active, contact_id, client_id`, [Boolean(req.body.is_active), id]);
    if (!rows[0]) return res.status(404).json({
      error: "User not found."
    });
    res.json(rows[0]);
  } catch (err) {
    if (err?.code?.startsWith("COMMUNITY_")) {
      return sendCommunityLimitError(res, err);
    }
    res.status(500).json({
      error: err.message || "Update not possible."
    });
  }
});
router.patch("/:id/password", verifyJWT, requireRole("admin"), async (req, res) => {
  const {
    id
  } = req.params;
  const newPassword = String(req.body?.newPassword || "");
  if (newPassword.length < 6) {
    return res.status(400).json({
      error: "Password required (minimum 6 characters)."
    });
  }
  try {
    const {
      rows
    } = await pool.query(`SELECT contact_id FROM v_b_users WHERE id = $1 AND role = 'client'`, [id]);
    if (!rows[0]?.contact_id) {
      return res.status(404).json({
        error: "User not found."
      });
    }
    await resetPortalPassword(rows[0].contact_id, newPassword);
    res.json({
      success: true
    });
  } catch (err) {
    res.status(400).json({
      error: err.message || "Reset not possible."
    });
  }
});
router.delete("/:id", verifyJWT, requireRole("admin"), async (req, res) => {
  const {
    id
  } = req.params;
  try {
    const {
      rows
    } = await pool.query(`SELECT contact_id FROM v_b_users WHERE id = $1 AND role = 'client'`, [id]);
    if (!rows[0]) return res.status(404).json({
      error: "User not found."
    });
    if (rows[0].contact_id) {
      await deletePortalUserForContact(rows[0].contact_id);
    } else {
      await pool.query(`DELETE FROM v_b_users WHERE id = $1 AND role = 'client'`, [id]);
    }
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || "Deletion not possible."
    });
  }
});
export default router;
