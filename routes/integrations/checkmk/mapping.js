import express from 'express';
import { pool } from '../../../database/db.js';
import verifyJWT from '../../../middleware/auth.js';
const router = express.Router();
router.get('/mapping/:clientId', verifyJWT, async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    res.json([]);
  } catch (error) {
    console.error('Error loading CheckMK mappings:', error);
    res.status(500).json({
      error: 'Error loading mappings',
      details: error.message
    });
  }
});
router.get('/mapping/:clientId/stats', verifyJWT, async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'v_b_clients_host_mapping'
      );
    `);
    if (!tableCheck.rows[0].exists) {
      return res.json({
        stats: [],
        total: 0
      });
    }
    const totalResult = await pool.query(`SELECT COUNT(*) as total
       FROM v_b_clients_host_mapping
       WHERE client_id::text = $1 AND (is_active = true OR is_active IS NULL) AND checkmk_host_name IS NOT NULL`, [clientId]);
    const total = parseInt(totalResult.rows[0]?.total || 0);
    const stats = total > 0 ? [{
      type: 'CheckMK',
      count: total
    }] : [];
    const response = {
      stats,
      total
    };
    res.json(response);
  } catch (error) {
    console.error('Error loading CheckMK statistics:', error);
    res.status(500).json({
      error: 'Error loading statistics',
      details: error.message
    });
  }
});
router.post('/mapping', verifyJWT, async (req, res) => {
  try {
    const {
      client_id,
      equipment_type,
      equipment_id,
      checkmk_host_name,
      checkmk_service_name,
      checkmk_site,
      is_active
    } = req.body;
    if (!client_id || !equipment_type || !equipment_id || !checkmk_host_name) {
      return res.status(400).json({
        error: 'client_id, equipment_type, equipment_id et checkmk_host_name are required'
      });
    }
    const query = `INSERT INTO v_b_clients_host_mapping 
       (client_id, equipment_type, equipment_id, checkmk_host_name, checkmk_service_name, checkmk_site, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (client_id, equipment_type, equipment_id)
       DO UPDATE SET 
         checkmk_host_name = EXCLUDED.checkmk_host_name,
         checkmk_service_name = EXCLUDED.checkmk_service_name,
         checkmk_site = EXCLUDED.checkmk_site,
         is_active = EXCLUDED.is_active,
         updated_at = NOW()
       RETURNING *`;
    const params = [client_id, equipment_type, equipment_id, checkmk_host_name, checkmk_service_name || null, checkmk_site || null, is_active !== false];
    const result = await pool.query(query, params);
    const mapping = result.rows[0];
    res.json(mapping);
  } catch (error) {
    console.error('Mapping error:', error.message, error.detail);
    res.status(500).json({
      error: 'Error creating/updating mapping',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
router.delete('/mapping/:id', verifyJWT, async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const mappingResult = await pool.query(`SELECT * FROM v_b_clients_host_mapping WHERE id = $1`, [id]);
    if (mappingResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Mapping not found'
      });
    }
    const mapping = mappingResult.rows[0];
    const result = await pool.query(`DELETE FROM v_b_clients_host_mapping WHERE id = $1 RETURNING *`, [id]);
    try {
      const equipmentTypeToTable = {
        'Serveurs': 'v_b_clients_m_servers',
        'Stockage': 'v_b_clients_m_stockage',
        'Firewalls': 'v_b_clients_m_firewall',
        'Switch': 'v_b_clients_m_switch',
        'BorneWifi': 'v_b_clients_m_wifi',
        'Alimentation': 'v_b_clients_m_alimentation',
        'Routeur': 'v_b_clients_m_routeur',
        'TOIP': 'v_b_clients_m_toip',
        'Sauvegarde': 'v_b_clients_m_save'
      };
      const tableName = equipmentTypeToTable[mapping.equipment_type];
      if (!tableName) {
        return;
      }
      const equipmentResult = await pool.query(`SELECT id, data FROM ${tableName} 
         WHERE client_id::text = $1 AND (data->>'nom' = $2 OR name = $2 OR item_key = $2)
         LIMIT 1`, [mapping.client_id, mapping.equipment_name]);
      if (equipmentResult.rows.length > 0) {
        const equipment = equipmentResult.rows[0];
        const currentData = equipment.data || {};
        const {
          checkmk_host_name,
          checkmk_site,
          ...dataWithoutCheckMK
        } = currentData;
        await pool.query(`UPDATE ${tableName} SET data = $1, updated_at = NOW() WHERE id = $2`, [dataWithoutCheckMK, equipment.id]);
      } else {}
    } catch (updateError) {}
    res.json({
      success: true,
      deleted: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error deleting mapping'
    });
  }
});
export default router;
