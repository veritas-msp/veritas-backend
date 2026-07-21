import { pool } from "../database/db.js";
function emptyAssignments() {
  return {
    profileNames: [],
    userIds: [],
    teamIds: []
  };
}
export async function loadAssignmentsByViewIds(viewIds = []) {
  if (!viewIds.length) return {};
  const [profiles, users, teams] = await Promise.all([pool.query(`SELECT view_id, profile_name
       FROM v_b_ticket_view_profiles
       WHERE view_id = ANY($1::uuid[])
       ORDER BY profile_name ASC`, [viewIds]), pool.query(`SELECT vu.view_id, vu.user_id, u.email, u.username
       FROM v_b_ticket_view_users vu
       JOIN v_b_users u ON u.id = vu.user_id
       WHERE vu.view_id = ANY($1::uuid[])
       ORDER BY u.email ASC`, [viewIds]), pool.query(`SELECT vt.view_id, vt.team_id, t.name AS team_name
       FROM v_b_ticket_view_teams vt
       JOIN v_b_teams t ON t.id = vt.team_id
       WHERE vt.view_id = ANY($1::uuid[])
       ORDER BY t.name ASC`, [viewIds])]);
  const map = {};
  for (const id of viewIds) {
    map[String(id)] = emptyAssignments();
  }
  for (const row of profiles.rows || []) {
    const key = String(row.view_id);
    map[key].profileNames.push(row.profile_name);
  }
  for (const row of users.rows || []) {
    const key = String(row.view_id);
    map[key].userIds.push(String(row.user_id));
    map[key].users = map[key].users || [];
    map[key].users.push({
      id: row.user_id,
      email: row.email || "",
      username: row.username || ""
    });
  }
  for (const row of teams.rows || []) {
    const key = String(row.view_id);
    map[key].teamIds.push(String(row.team_id));
    map[key].teams = map[key].teams || [];
    map[key].teams.push({
      id: row.team_id,
      name: row.team_name || ""
    });
  }
  return map;
}
export async function syncViewAssignments(viewId, assignments = {}) {
  const profileNames = [...new Set((assignments.profileNames || []).map(n => String(n || "").trim()).filter(Boolean))];
  const userIds = [...new Set((assignments.userIds || []).map(n => String(n || "").trim()).filter(Boolean))];
  const teamIds = [...new Set((assignments.teamIds || []).map(n => String(n || "").trim()).filter(Boolean))];
  await pool.query(`DELETE FROM v_b_ticket_view_profiles WHERE view_id = $1`, [viewId]);
  await pool.query(`DELETE FROM v_b_ticket_view_users WHERE view_id = $1`, [viewId]);
  await pool.query(`DELETE FROM v_b_ticket_view_teams WHERE view_id = $1`, [viewId]);
  for (const profileName of profileNames) {
    await pool.query(`INSERT INTO v_b_ticket_view_profiles (view_id, profile_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [viewId, profileName]);
  }
  for (const userId of userIds) {
    await pool.query(`INSERT INTO v_b_ticket_view_users (view_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [viewId, userId]);
  }
  for (const teamId of teamIds) {
    await pool.query(`INSERT INTO v_b_ticket_view_teams (view_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [viewId, teamId]);
  }
  return {
    profileNames,
    userIds,
    teamIds
  };
}
export async function getUserTeamIds(userId) {
  if (!userId) return [];
  const result = await pool.query(`SELECT team_id FROM v_b_team_members WHERE user_id = $1`, [userId]);
  return (result.rows || []).map(r => String(r.team_id));
}
export function isAssignedVisibility(visibility) {
  return visibility === "assigned" || visibility === "profile";
}
export function hasAssignmentTargets(assignments = {}) {
  return (assignments.profileNames || []).length > 0 || (assignments.userIds || []).length > 0 || (assignments.teamIds || []).length > 0;
}
export function userCanAccessAssignedView(assignments, userId, profileName, userTeamIds = []) {
  if (!assignments) return false;
  if ((assignments.userIds || []).some(id => String(id) === String(userId))) return true;
  if (profileName && (assignments.profileNames || []).includes(profileName)) return true;
  if ((assignments.teamIds || []).some(tid => userTeamIds.includes(String(tid)))) return true;
  return false;
}
export function mapViewAssignments(assignments = emptyAssignments()) {
  return {
    profileNames: assignments.profileNames || [],
    userIds: assignments.userIds || [],
    teamIds: assignments.teamIds || [],
    users: assignments.users || [],
    teams: assignments.teams || []
  };
}
