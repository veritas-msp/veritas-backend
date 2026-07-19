// ───────────────────────────────────────────────
// 📦 Main imports
// ───────────────────────────────────────────────
import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import {
  USER_AVATAR_SETTING_KEY,
  validatePresetAvatarId,
  upsertUserAvatarSetting,
} from '../../utils/userAvatar.js';
import { upsertUserSetting } from '../../utils/userSettingsStore.js';

const router = express.Router();

// ───────────────────────────────────────────────
// 📥 GET /api/user-settings/:key — Fetch a user setting
// ───────────────────────────────────────────────
router.get('/:key', verifyJWT, async (req, res) => {
  try {
    const { key } = req.params;
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT setting_value 
       FROM v_b_users_settings 
       WHERE user_id = $1 AND setting_key = $2`,
      [userId, key]
    );

    if (result.rows.length === 0) {
      return res.json({ value: null });
    }

    res.json({ value: result.rows[0].setting_value });
  } catch (err) {
    console.error('Error fetching setting:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ───────────────────────────────────────────────
// 💾 POST /api/user-settings/:key — Save a user setting
// ───────────────────────────────────────────────
router.post('/:key', verifyJWT, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    const userId = req.user.id;

    if (value === undefined) {
      return res.status(400).json({ error: 'Valeur requise' });
    }

    if (key === USER_AVATAR_SETTING_KEY) {
      if (value == null) {
        await upsertUserAvatarSetting(userId, null);
        return res.json({ success: true });
      }
      const presetId = String(value?.presetId || value?.preset || "").toLowerCase();
      if (value?.type === "preset" || presetId) {
        if (!validatePresetAvatarId(presetId)) {
          return res.status(400).json({ error: "Avatar prédéfini invalide." });
        }
        await upsertUserAvatarSetting(userId, { type: "preset", presetId });
        return res.json({ success: true });
      }
      return res.status(400).json({ error: "Utilisez /api/users/me/avatar pour un upload." });
    }

    await upsertUserSetting(userId, key, value);

    res.json({ success: true });
  } catch (err) {
    console.error('Error saving setting:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ───────────────────────────────────────────────
// 📋 GET /api/user-settings — Fetch all user settings
// ───────────────────────────────────────────────
router.get('/', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT setting_key, setting_value 
       FROM v_b_users_settings 
       WHERE user_id = $1`,
      [userId]
    );

    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });

    res.json(settings);
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;

