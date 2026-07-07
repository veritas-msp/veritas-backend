// ───────────────────────────────────────────────
// 📦 Imports principaux
// ───────────────────────────────────────────────
import express from 'express';         // Framework HTTP
import { pool } from '../../database/db.js';       // Connexion PostgreSQL (pool partagé)
import { decryptSetting, encryptSettingValue } from '../../utils/settingsHelper.js';
import verifyJWT from '../../middleware/auth.js';
import { requireRole } from '../../middleware/roles.js';

const router = express.Router();       // Création du routeur Express

router.use(verifyJWT, requireRole('admin'));

// ───────────────────────────────────────────────
// ⚙️ GET / — Récupération de tous les paramètres
// ───────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    // Récupère et déchiffre tous les paramètres
    // Colonnes compatibles avec l'ancien schéma (sans created_at/updated_at éventuels)
    const result = await pool.query('SELECT key, value, value_encrypted, value_iv, value_auth_tag, section FROM v_b_settings');
    const decrypted = result.rows.map((row) => ({
      ...row,
      value: decryptSetting(row),
      value_encrypted: undefined,
      value_iv: undefined,
      value_auth_tag: undefined,
    }));

    res.json(decrypted);
  } catch (err) {
    res.status(500).json({ error: "Erreur interne (SQL)" });
  }
});

// ───────────────────────────────────────────────
// ⚙️ POST / — Création ou mise à jour d’un paramètre
// ───────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    // Récupère les champs nécessaires depuis le body
    const { key, value, label, section } = req.body;

    const enc = encryptSettingValue(value);

    await pool.query(
      `INSERT INTO v_b_settings (key, value, label, section, value_encrypted, value_iv, value_auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         label = EXCLUDED.label,
         section = EXCLUDED.section,
         value_encrypted = EXCLUDED.value_encrypted,
         value_iv = EXCLUDED.value_iv,
         value_auth_tag = EXCLUDED.value_auth_tag`,
      [key, enc.value, label, section, enc.value_encrypted, enc.value_iv, enc.value_auth_tag]
    );

    // Retourne un succès explicite
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur interne (SQL)" });
  }
});

export default router;
