import express from "express";
import { body, param, validationResult } from "express-validator";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { ensureTeamsSchema } from "../../services/ensureTeamsSchema.js";
const router = express.Router();
const AGENTS_WHERE = `COALESCE(u.role, '') <> 'client'`;
function validationErrorOrNull(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      errors: errors.array()
    });
    return true;
  }
  return false;
}
function mapTeamRow(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    color: row.color || null,
    icon: row.icon || "mdi:account-group-outline",
    isActive: row.is_active !== false,
    displayOrder: row.display_order ?? 0,
    memberCount: Number(extra.memberCount ?? row.member_count ?? 0),
    leaderCount: Number(extra.leaderCount ?? row.leader_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function mapMemberRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    userId: row.user_id,
    isLeader: row.is_leader === true,
    email: row.email || "",
    username: row.username || "",
    profile: row.profile || "",
    profileLabel: row.profile_label || row.profile || "",
    isActive: row.is_active !== false,
    createdAt: row.created_at
  };
}
async function getTeamRow(teamId) {
  const result = await pool.query(`SELECT t.*,
            COUNT(m.id)::int AS member_count,
            COUNT(m.id) FILTER (WHERE m.is_leader)::int AS leader_count
     FROM v_b_teams t
     LEFT JOIN v_b_team_members m ON m.team_id = t.id
     WHERE t.id = $1
     GROUP BY t.id`, [teamId]);
  return result.rows[0] || null;
}
async function userIsAgent(userId) {
  const result = await pool.query(`SELECT id FROM v_b_users u WHERE u.id = $1 AND ${AGENTS_WHERE}`, [userId]);
  return result.rows.length > 0;
}
router.use(verifyJWT);
router.get("/planning", async (_req, res) => {
  try {
    await ensureTeamsSchema();
    const result = await pool.query(`SELECT t.id,
              t.name,
              t.description,
              t.color,
              t.icon,
              t.display_order,
              (
                SELECT COALESCE(
                  json_agg(m.user_id ORDER BY u.email),
                  '[]'::json
                )
                FROM v_b_team_members m
                JOIN v_b_users u ON u.id = m.user_id
                WHERE m.team_id = t.id AND ${AGENTS_WHERE}
              ) AS member_user_ids
       FROM v_b_teams t
       WHERE COALESCE(t.is_active, TRUE) = TRUE
       ORDER BY t.display_order ASC, t.name ASC`);
    const teams = (result.rows || []).map(row => {
      const memberUserIds = Array.isArray(row.member_user_ids) ? row.member_user_ids.map(String) : [];
      return {
        id: row.id,
        name: row.name,
        description: row.description || "",
        color: row.color || null,
        icon: row.icon || "mdi:account-group-outline",
        memberCount: memberUserIds.length,
        memberUserIds
      };
    });
    return res.json(teams);
  } catch (err) {
    console.error("GET /teams/planning", err);
    return res.status(500).json({
      error: "Error loading teams"
    });
  }
});
const adminOnly = requireRole("admin");
router.get("/", adminOnly, async (_req, res) => {
  try {
    await ensureTeamsSchema();
    const result = await pool.query(`SELECT t.*,
              COUNT(m.id)::int AS member_count,
              COUNT(m.id) FILTER (WHERE m.is_leader)::int AS leader_count
       FROM v_b_teams t
       LEFT JOIN v_b_team_members m ON m.team_id = t.id
       GROUP BY t.id
       ORDER BY t.display_order ASC, t.name ASC`);
    return res.json((result.rows || []).map(row => mapTeamRow(row)));
  } catch (err) {
    console.error("GET /teams", err);
    return res.status(500).json({
      error: "Error loading teams"
    });
  }
});
router.get("/:teamId", adminOnly, [param("teamId").isUUID()], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    await ensureTeamsSchema();
    const team = await getTeamRow(req.params.teamId);
    if (!team) return res.status(404).json({
      error: "Team not found"
    });
    const members = await pool.query(`SELECT m.*, u.email, u.username, u.profile, u.is_active, p.label AS profile_label
       FROM v_b_team_members m
       JOIN v_b_users u ON u.id = m.user_id
       LEFT JOIN v_b_users_profiles p ON p.name = u.profile
       WHERE m.team_id = $1 AND COALESCE(u.role, '') <> 'client'
       ORDER BY m.is_leader DESC, u.email ASC`, [req.params.teamId]);
    return res.json({
      ...mapTeamRow(team),
      members: (members.rows || []).map(mapMemberRow)
    });
  } catch (err) {
    console.error("GET /teams/:id", err);
    return res.status(500).json({
      error: "Error loading team"
    });
  }
});
router.post("/", adminOnly, [body("name").isString().trim().isLength({
  min: 1,
  max: 120
}), body("description").optional({
  nullable: true
}).isString(), body("color").optional({
  nullable: true
}).isString(), body("icon").optional().isString(), body("isActive").optional().isBoolean(), body("displayOrder").optional().isInt()], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    await ensureTeamsSchema();
    const result = await pool.query(`INSERT INTO v_b_teams (name, description, color, icon, is_active, display_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         RETURNING *`, [String(req.body.name).trim(), req.body.description ? String(req.body.description).trim() : null, req.body.color ? String(req.body.color).trim() : null, String(req.body.icon || "mdi:account-group-outline").trim(), req.body.isActive !== false, Number(req.body.displayOrder) || 0]);
    return res.status(201).json(mapTeamRow(result.rows[0], {
      memberCount: 0,
      leaderCount: 0
    }));
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({
        error: "A team with this name already exists"
      });
    }
    console.error("POST /teams", err);
    return res.status(500).json({
      error: "Error creating team"
    });
  }
});
router.put("/:teamId", adminOnly, [param("teamId").isUUID(), body("name").optional().isString().trim().isLength({
  min: 1,
  max: 120
}), body("description").optional({
  nullable: true
}).isString(), body("color").optional({
  nullable: true
}).isString(), body("icon").optional().isString(), body("isActive").optional().isBoolean(), body("displayOrder").optional().isInt()], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    await ensureTeamsSchema();
    const result = await pool.query(`UPDATE v_b_teams SET
          name = COALESCE($2, name),
          description = COALESCE($3, description),
          color = COALESCE($4, color),
          icon = COALESCE($5, icon),
          is_active = COALESCE($6, is_active),
          display_order = COALESCE($7, display_order),
          updated_at = NOW()
         WHERE id = $1
         RETURNING *`, [req.params.teamId, req.body.name !== undefined ? String(req.body.name).trim() : null, req.body.description !== undefined ? req.body.description ? String(req.body.description).trim() : null : null, req.body.color !== undefined ? req.body.color ? String(req.body.color).trim() : null : null, req.body.icon !== undefined ? String(req.body.icon).trim() : null, req.body.isActive !== undefined ? Boolean(req.body.isActive) : null, req.body.displayOrder !== undefined ? Number(req.body.displayOrder) : null]);
    if (result.rowCount === 0) return res.status(404).json({
      error: "Team not found"
    });
    const team = await getTeamRow(req.params.teamId);
    return res.json(mapTeamRow(team));
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({
        error: "A team with this name already exists"
      });
    }
    console.error("PUT /teams/:id", err);
    return res.status(500).json({
      error: "Error updating team"
    });
  }
});
router.delete("/:teamId", adminOnly, [param("teamId").isUUID()], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    await ensureTeamsSchema();
    const result = await pool.query(`DELETE FROM v_b_teams WHERE id = $1`, [req.params.teamId]);
    if (result.rowCount === 0) return res.status(404).json({
      error: "Team not found"
    });
    return res.status(204).send();
  } catch (err) {
    console.error("DELETE /teams/:id", err);
    return res.status(500).json({
      error: "Error deleting team"
    });
  }
});
router.post("/:teamId/members", adminOnly, [param("teamId").isUUID(), body("userId").isUUID(), body("isLeader").optional().isBoolean()], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    await ensureTeamsSchema();
    const team = await getTeamRow(req.params.teamId);
    if (!team) return res.status(404).json({
      error: "Team not found"
    });
    const userId = req.body.userId;
    if (!(await userIsAgent(userId))) {
      return res.status(400).json({
        error: "Only agent accounts can join a team"
      });
    }
    const result = await pool.query(`INSERT INTO v_b_team_members (team_id, user_id, is_leader)
         VALUES ($1, $2, $3)
         RETURNING *`, [req.params.teamId, userId, req.body.isLeader === true]);
    const member = await pool.query(`SELECT m.*, u.email, u.username, u.profile, u.is_active, p.label AS profile_label
         FROM v_b_team_members m
         JOIN v_b_users u ON u.id = m.user_id
         LEFT JOIN v_b_users_profiles p ON p.name = u.profile
         WHERE m.id = $1`, [result.rows[0].id]);
    return res.status(201).json(mapMemberRow(member.rows[0]));
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({
        error: "This agent is already a team member"
      });
    }
    console.error("POST /teams/:id/members", err);
    return res.status(500).json({
      error: "Error adding member"
    });
  }
});
router.patch("/:teamId/members/:userId", adminOnly, [param("teamId").isUUID(), param("userId").isUUID(), body("isLeader").isBoolean()], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    await ensureTeamsSchema();
    const result = await pool.query(`UPDATE v_b_team_members
         SET is_leader = $3
         WHERE team_id = $1 AND user_id = $2
         RETURNING *`, [req.params.teamId, req.params.userId, req.body.isLeader === true]);
    if (result.rowCount === 0) return res.status(404).json({
      error: "Member not found"
    });
    const member = await pool.query(`SELECT m.*, u.email, u.username, u.profile, u.is_active, p.label AS profile_label
         FROM v_b_team_members m
         JOIN v_b_users u ON u.id = m.user_id
         LEFT JOIN v_b_users_profiles p ON p.name = u.profile
         WHERE m.id = $1`, [result.rows[0].id]);
    return res.json(mapMemberRow(member.rows[0]));
  } catch (err) {
    console.error("PATCH /teams/:id/members/:userId", err);
    return res.status(500).json({
      error: "Error updating member"
    });
  }
});
router.delete("/:teamId/members/:userId", adminOnly, [param("teamId").isUUID(), param("userId").isUUID()], async (req, res) => {
  if (validationErrorOrNull(req, res)) return;
  try {
    await ensureTeamsSchema();
    const result = await pool.query(`DELETE FROM v_b_team_members WHERE team_id = $1 AND user_id = $2`, [req.params.teamId, req.params.userId]);
    if (result.rowCount === 0) return res.status(404).json({
      error: "Member not found"
    });
    return res.status(204).send();
  } catch (err) {
    console.error("DELETE /teams/:id/members/:userId", err);
    return res.status(500).json({
      error: "Error removing member"
    });
  }
});
export default router;
