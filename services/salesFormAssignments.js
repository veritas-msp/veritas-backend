import { pool } from "../database/db.js";
import { getUserTeamIds, hasAssignmentTargets, mapViewAssignments, userCanAccessAssignedView } from "./ticketViewAssignments.js";
export { getUserTeamIds, hasAssignmentTargets, userCanAccessAssignedView };
function emptyAssignments() {
  return {
    profileNames: [],
    userIds: [],
    teamIds: []
  };
}
export async function loadAssignmentsByFormIds(formIds = []) {
  if (!formIds.length) return {};
  const [profiles, users, teams] = await Promise.all([pool.query(`SELECT form_id, profile_name
       FROM v_b_sales_form_profiles
       WHERE form_id = ANY($1::text[])
       ORDER BY profile_name ASC`, [formIds]), pool.query(`SELECT fu.form_id, fu.user_id, u.email, u.username
       FROM v_b_sales_form_users fu
       JOIN v_b_users u ON u.id = fu.user_id
       WHERE fu.form_id = ANY($1::text[])
       ORDER BY u.email ASC`, [formIds]), pool.query(`SELECT ft.form_id, ft.team_id, t.name AS team_name
       FROM v_b_sales_form_teams ft
       JOIN v_b_teams t ON t.id = ft.team_id
       WHERE ft.form_id = ANY($1::text[])
       ORDER BY t.name ASC`, [formIds])]);
  const map = {};
  for (const id of formIds) {
    map[String(id)] = emptyAssignments();
  }
  for (const row of profiles.rows || []) {
    const key = String(row.form_id);
    map[key].profileNames.push(row.profile_name);
  }
  for (const row of users.rows || []) {
    const key = String(row.form_id);
    map[key].userIds.push(String(row.user_id));
    map[key].users = map[key].users || [];
    map[key].users.push({
      id: row.user_id,
      email: row.email || "",
      username: row.username || ""
    });
  }
  for (const row of teams.rows || []) {
    const key = String(row.form_id);
    map[key].teamIds.push(String(row.team_id));
    map[key].teams = map[key].teams || [];
    map[key].teams.push({
      id: row.team_id,
      name: row.team_name || ""
    });
  }
  return map;
}
export async function syncFormAssignments(formId, assignments = {}) {
  const profileNames = [...new Set((assignments.profileNames || []).map(n => String(n || "").trim()).filter(Boolean))];
  const userIds = [...new Set((assignments.userIds || []).map(n => String(n || "").trim()).filter(Boolean))];
  const teamIds = [...new Set((assignments.teamIds || []).map(n => String(n || "").trim()).filter(Boolean))];
  await pool.query(`DELETE FROM v_b_sales_form_profiles WHERE form_id = $1`, [formId]);
  await pool.query(`DELETE FROM v_b_sales_form_users WHERE form_id = $1`, [formId]);
  await pool.query(`DELETE FROM v_b_sales_form_teams WHERE form_id = $1`, [formId]);
  for (const profileName of profileNames) {
    await pool.query(`INSERT INTO v_b_sales_form_profiles (form_id, profile_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [formId, profileName]);
  }
  for (const userId of userIds) {
    await pool.query(`INSERT INTO v_b_sales_form_users (form_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [formId, userId]);
  }
  for (const teamId of teamIds) {
    await pool.query(`INSERT INTO v_b_sales_form_teams (form_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [formId, teamId]);
  }
  return {
    profileNames,
    userIds,
    teamIds
  };
}
export function mapFormAssignments(assignments = emptyAssignments()) {
  return mapViewAssignments(assignments);
}
export function userCanAccessForm(form, assignments, userId, profileName, userTeamIds = []) {
  if (!form) return false;
  if (form.visibility !== "assigned") return true;
  return userCanAccessAssignedView(assignments, userId, profileName, userTeamIds);
}
