import { pool } from "../database/db.js";

export async function upsertUserSetting(userId, settingKey, value) {
  if (!userId || !settingKey) return;

  const jsonValue = typeof value === "string" ? value : JSON.stringify(value);

  const updated = await pool.query(
    `UPDATE v_b_users_settings
     SET setting_value = $3::jsonb, updated_at = NOW()
     WHERE user_id = $1 AND setting_key = $2
     RETURNING id`,
    [userId, settingKey, jsonValue]
  );

  if (updated.rowCount > 0) return;

  try {
    await pool.query(
      `INSERT INTO v_b_users_settings (user_id, setting_key, setting_value, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())`,
      [userId, settingKey, jsonValue]
    );
  } catch (err) {
    if (err.code !== "23505") throw err;
    await pool.query(
      `UPDATE v_b_users_settings
       SET setting_value = $3::jsonb, updated_at = NOW()
       WHERE user_id = $1 AND setting_key = $2`,
      [userId, settingKey, jsonValue]
    );
  }
}
