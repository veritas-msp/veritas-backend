import express from 'express';
import { pool } from '../../database/db.js';
import { decryptSetting, encryptSettingValue } from '../../utils/settingsHelper.js';
import verifyJWT from '../../middleware/auth.js';
import { requireRole } from '../../middleware/roles.js';
const router = express.Router();
router.use(verifyJWT, requireRole('admin'));
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value, value_encrypted, value_iv, value_auth_tag, section FROM v_b_settings');
    const decrypted = result.rows.map(row => ({
      ...row,
      value: decryptSetting(row),
      value_encrypted: undefined,
      value_iv: undefined,
      value_auth_tag: undefined
    }));
    res.json(decrypted);
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)"
    });
  }
});
router.post('/', async (req, res) => {
  try {
    const {
      key,
      value,
      label,
      section
    } = req.body;
    const enc = encryptSettingValue(value);
    await pool.query(`INSERT INTO v_b_settings (key, value, label, section, value_encrypted, value_iv, value_auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         label = EXCLUDED.label,
         section = EXCLUDED.section,
         value_encrypted = EXCLUDED.value_encrypted,
         value_iv = EXCLUDED.value_iv,
         value_auth_tag = EXCLUDED.value_auth_tag`, [key, enc.value, label, section, enc.value_encrypted, enc.value_iv, enc.value_auth_tag]);
    res.status(200).json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)"
    });
  }
});
export default router;
