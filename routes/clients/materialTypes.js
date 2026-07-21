import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import { requireRole } from '../../middleware/roles.js';
const router = express.Router();
router.use(verifyJWT);
router.get('/', async (req, res) => {
  try {
    const {
      category
    } = req.query;
    let query = 'SELECT * FROM v_b_p_custom_types';
    let params = [];
    if (category) {
      query += ' WHERE category = $1';
      params.push(category);
    }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({
      error: "Error loading custom types."
    });
  }
});
router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const {
      id,
      label,
      category
    } = req.body;
    await pool.query(`INSERT INTO v_b_p_custom_types (id, label, category, created_at)
       VALUES ($1, $2, $3, NOW())`, [id, label, category]);
    res.status(201).json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: "Error adding type"
    });
  }
});
router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const {
      label,
      category
    } = req.body;
    await pool.query(`UPDATE v_b_p_custom_types
       SET label = $1, category = $2
       WHERE id = $3`, [label, category, id]);
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: "Error updating type"
    });
  }
});
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const {
      id
    } = req.params;
    await pool.query(`DELETE FROM v_b_p_custom_types WHERE id = $1`, [id]);
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: "Error deleting type"
    });
  }
});
export default router;
