// ───────────────────────────────────────────────
// 📦 Routes Campagnes Cybersécurité
// ───────────────────────────────────────────────
import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import { requirePro } from '../../middleware/edition.js';
import fetch from 'node-fetch';
import { generateCampaignReportPDF } from '../../utils/pdfGenerator.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { dispatchNotificationEvent } from "../../services/notificationDispatcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CAMPAIGN_REPORTS_DIR = path.join(__dirname, "..", "..", "uploads", "campaign-reports");
if (!fs.existsSync(CAMPAIGN_REPORTS_DIR)) {
  fs.mkdirSync(CAMPAIGN_REPORTS_DIR, { recursive: true });
}

const router = express.Router();

/** Ne pas intercepter /list, /general, etc. — ce routeur est monté avant clientsRoutes. */
function isCampaignApiPath(pathname) {
  const path = String(pathname || "").split("?")[0];
  if (path === "/all-campaigns") return true;
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "campaigns") return true;
  return segments.length >= 2 && segments[1] === "campaigns";
}

router.use((req, res, next) => {
  if (!isCampaignApiPath(req.path)) {
    return next("router");
  }
  next();
});
router.use(verifyJWT, requirePro);

/** Âge max de la dernière synchro pour autoriser le lancement (24h) */
const RECENT_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Chaîne vide ou invalide → null pour colonnes numeric (évite 22P02 sur '') */
function normalizeNumericColumn(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Récupère les statistiques MFA du client depuis la base (données déjà synchronisées).
 * Utilisé pour créer les snapshots début/fin sans appeler l'API Microsoft.
 * @returns {Promise<{ adminCount, userCount, adminMfaPercentage, userMfaPercentage, mfaPercentage, mfaEnabledCount, mfaDisabledCount, lastSync } | null>}
 */
async function getClientMfaStatsFromDb(clientId) {
  const result = await pool.query(`
    SELECT
      COUNT(*) as total_users,
      COUNT(CASE WHEN is_admin = true THEN 1 END) as admin_count,
      COUNT(CASE WHEN is_admin = false THEN 1 END) as non_admin_count,
      COUNT(CASE WHEN has_mfa = true THEN 1 END) as users_with_mfa,
      COUNT(CASE WHEN has_mfa = true AND is_admin = true THEN 1 END) as admins_with_mfa,
      COUNT(CASE WHEN has_mfa = true AND is_admin = false THEN 1 END) as non_admins_with_mfa,
      MAX(last_sync) as last_sync
    FROM v_b_clients_c_azure_mfa
    WHERE client_id = $1 AND account_enabled = true
  `, [clientId]);

  if (result.rows.length === 0 || !result.rows[0].total_users || parseInt(result.rows[0].total_users) === 0) {
    return null;
  }

  const row = result.rows[0];
  const totalUsers = parseInt(row.total_users);
  const adminCount = parseInt(row.admin_count);
  const nonAdminCount = parseInt(row.non_admin_count);
  const usersWithMfa = parseInt(row.users_with_mfa);
  const adminsWithMfa = parseInt(row.admins_with_mfa);
  const nonAdminsWithMfa = parseInt(row.non_admins_with_mfa);

  const adminMfaPercentage = adminCount > 0 ? Math.round((adminsWithMfa / adminCount) * 10000) / 100 : 0;
  const nonAdminMfaPercentage = nonAdminCount > 0 ? Math.round((nonAdminsWithMfa / nonAdminCount) * 10000) / 100 : 0;
  const userMfaPercentage = totalUsers > 0 ? Math.round((usersWithMfa / totalUsers) * 10000) / 100 : 0;
  const mfaPercentage = userMfaPercentage;
  const mfaEnabledCount = usersWithMfa;
  const mfaDisabledCount = Math.max(0, totalUsers - usersWithMfa);

  return {
    adminCount,
    nonAdminCount,
    userCount: totalUsers,
    adminMfaPercentage,
    nonAdminMfaPercentage,
    userMfaPercentage,
    mfaPercentage,
    mfaEnabledCount,
    mfaDisabledCount,
    lastSync: row.last_sync
  };
}

// ───────────────────────────────────────────────
// 📋 GET /all-campaigns — Récupération de toutes les campagnes cybersécurité
// ───────────────────────────────────────────────
router.get('/all-campaigns', verifyJWT, async (req, res) => {
  try {
    // Vérifier d'abord la connexion à la base
    await pool.query('SELECT 1');

    // Compter les campagnes
    const countResult = await pool.query('SELECT COUNT(*) as total FROM v_b_clients_c_campaign');

    // Requête pour récupérer toutes les campagnes avec filtres optionnels
    const { status, type, client_id } = req.query;

    let query = `
      SELECT
        c.id, c.client_id, c.name, c.type, c.status, c.start_date, c.end_date,
        c.global_progress, c.description, c.objectif_adoption, c.created_at, c.updated_at, c.created_by,
        c.updated_by,
        cl.name as client_name
      FROM v_b_clients_c_campaign c
      LEFT JOIN v_b_clients cl ON c.client_id::text = cl.id::text
    `;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (status) {
      conditions.push(`c.status = $${paramIndex++}`);
      params.push(status);
    }

    if (type) {
      conditions.push(`c.type = $${paramIndex++}`);
      params.push(type);
    }

    if (client_id) {
      conditions.push(`c.client_id = $${paramIndex++}`);
      params.push(client_id);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` ORDER BY c.created_at DESC`;

    const result = await pool.query(query, params);

    res.json(result.rows);

  } catch (error) {
    console.error('❌ Erreur lors de la récupération des campagnes:', error);

    // Si la table n'existe pas, retourner un tableau vide
    if (error.code === '42P01') {
      console.log('⚠️ Table v_b_clients_c_campaign n\'existe pas, retour d\'un tableau vide');
      return res.json([]);
    }

    res.status(500).json({
      error: 'Erreur lors de la récupération des campagnes',
      details: error.message,
      code: error.code
    });
  }
});

// ───────────────────────────────────────────────
// 📋 GET /:id/campaigns — Récupération des campagnes cybersécurité d'un client
// ───────────────────────────────────────────────
router.get('/:id/campaigns', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, type } = req.query;

    let query = `
      SELECT
        c.*,
        cl.name as client_name
      FROM v_b_clients_c_campaign c
      LEFT JOIN v_b_clients cl ON c.client_id::text = cl.id::text
      WHERE c.client_id = $1
    `;

    const params = [id];
    let paramIndex = 2;

    if (status) {
      query += ` AND c.status = $${paramIndex++}`;
      params.push(status);
    }

    if (type) {
      query += ` AND c.type = $${paramIndex++}`;
      params.push(type);
    }

    query += ` ORDER BY c.created_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);

  } catch (error) {
    console.error('Erreur lors de la récupération des campagnes:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des campagnes' });
  }
});

// ───────────────────────────────────────────────
// ➕ POST /:id/campaigns — Créer une campagne cybersécurité
// ───────────────────────────────────────────────
router.post('/:id/campaigns', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, status, start_date, end_date, global_progress, description, objectif_adoption, referent_id, glpi_ticket_id } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Le nom et le type sont requis' });
    }

    // Récupérer l'utilisateur connecté
    const userId = req.user?.id || req.user?.user_id || null;
    let userName = req.user?.name || req.user?.username || req.user?.email || 'Utilisateur inconnu';

    if (userId && userName === 'Utilisateur inconnu') {
      try {
        const userResult = await pool.query(
          `SELECT username, email, name FROM v_b_users WHERE id::text = $1`,
          [userId]
        );
        if (userResult.rows.length > 0) {
          const user = userResult.rows[0];
          userName = user.name || user.username || user.email || 'Utilisateur inconnu';
        }
      } catch (userError) {
        console.warn('Erreur lors de la récupération du nom utilisateur:', userError);
      }
    }

    // Construire la requête dynamiquement selon les colonnes disponibles
    const columns = ['client_id', 'name', 'type', 'status', 'start_date', 'end_date', 'global_progress', 'description', 'objectif_adoption', 'created_by', 'updated_by'];
    const gp = normalizeNumericColumn(global_progress);
    const oa = normalizeNumericColumn(objectif_adoption);
    const values = [
      id,
      name,
      type,
      status || 'en_preparation',
      start_date,
      end_date,
      gp != null ? gp : 0,
      description,
      oa,
      userName,
      userName,
    ];

    // Note: referent_id et glpi_ticket_id ne sont pas utilisés car les colonnes n'existent pas

    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const result = await pool.query(
      `INSERT INTO v_b_clients_c_campaign (${columns.join(', ')})
       VALUES (${placeholders})
       RETURNING id, ${columns.join(', ')}, created_at, updated_at`,
      values
    );

    const newCampaign = result.rows[0];
    
    // Vérifier que l'ID a bien été récupéré
    if (!newCampaign || !newCampaign.id) {
      throw new Error('Impossible de récupérer l\'ID de la campagne créée');
    }

    // Si c'est une campagne de type microsoft_security, créer les étapes par défaut
    if (type === 'microsoft_security') {
      const defaultSteps = [
        { name: 'Communication orale puis écrite au client', order_index: 1 },
        { name: 'Mise à disposition de la documentation d\'aide utilisateur à l\'inscription MFA', order_index: 2 },
        { name: 'Snapshot de début de campagne', order_index: 3 },
        { name: 'Forcer l\'enrollement des comptes administrateurs et/ou utilisateurs', order_index: 4 },
        { name: 'Snapshot de fin de campagne', order_index: 5 },
        { name: 'Mise à disposition du rapport de campagne au client', order_index: 6 }
      ];

      try {
        for (const step of defaultSteps) {
          await pool.query(
            `INSERT INTO v_b_clients_c_campaign_steps 
             (campaign_id, name, order_index)
             VALUES ($1, $2, $3)`,
            [newCampaign.id, step.name, step.order_index]
          );
        }
        console.log(`✅ ${defaultSteps.length} étapes par défaut créées pour la campagne ${newCampaign.id}`);
      } catch (stepError) {
        console.error('⚠️ Erreur lors de la création des étapes par défaut:', stepError);
        // Ne pas faire échouer la création de la campagne si les étapes échouent
      }
    }

    await dispatchNotificationEvent({
      source: "cyber",
      element: "campaign_updated",
      enterpriseId: String(id || ""),
      user: req.user,
      context: {
        campaign: newCampaign,
        entreprise: { id: String(id || "") },
      },
    }).catch(() => {});

    res.status(201).json(newCampaign);

  } catch (error) {
    console.error('Erreur lors de la création de la campagne:', error);
    res.status(500).json({ error: 'Erreur lors de la création de la campagne', details: error.message });
  }
});

// ───────────────────────────────────────────────
// ✏️ PUT /:id/campaigns/:campaignId — Modifier une campagne cybersécurité
// ───────────────────────────────────────────────
router.put('/:id/campaigns/:campaignId', verifyJWT, async (req, res) => {
  try {
    const { id, campaignId } = req.params;
    const { name, type, status, start_date, end_date, global_progress, description, objectif_adoption, referent_id, glpi_ticket_id } = req.body;

    // Récupérer l'utilisateur connecté
    const userId = req.user?.id || req.user?.user_id || null;
    let userName = req.user?.name || req.user?.username || req.user?.email || 'Utilisateur inconnu';

    if (userId && userName === 'Utilisateur inconnu') {
      try {
        const userResult = await pool.query(
          `SELECT username, email, name FROM v_b_users WHERE id::text = $1`,
          [userId]
        );
        if (userResult.rows.length > 0) {
          const user = userResult.rows[0];
          userName = user.name || user.username || user.email || 'Utilisateur inconnu';
        }
      } catch (userError) {
        console.warn('Erreur lors de la récupération du nom utilisateur:', userError);
      }
    }

    // Construire la requête dynamiquement selon les colonnes disponibles
    // Ne mettre à jour que les champs qui sont fournis (non undefined)
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }

    if (type !== undefined) {
      updates.push(`type = $${paramIndex++}`);
      values.push(type);
    }

    if (status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    if (start_date !== undefined) {
      updates.push(`start_date = $${paramIndex++}`);
      values.push(start_date);
    }

    if (end_date !== undefined) {
      updates.push(`end_date = $${paramIndex++}`);
      values.push(end_date);
    }

    if (global_progress !== undefined) {
      updates.push(`global_progress = $${paramIndex++}`);
      values.push(normalizeNumericColumn(global_progress) ?? 0);
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (objectif_adoption !== undefined) {
      updates.push(`objectif_adoption = $${paramIndex++}`);
      values.push(normalizeNumericColumn(objectif_adoption));
    }

    // Toujours mettre à jour updated_by et updated_at
    updates.push(`updated_by = $${paramIndex++}`);
    values.push(userName);

    updates.push(`updated_at = NOW()`);

    // Note: referent_id et glpi_ticket_id ne sont pas utilisés car les colonnes n'existent pas

    if (updates.length === 2) { // Seulement updated_by et updated_at
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    values.push(campaignId, id);

    const result = await pool.query(
      `UPDATE v_b_clients_c_campaign
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex} AND client_id = $${paramIndex + 1}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    await dispatchNotificationEvent({
      source: "cyber",
      element: "campaign_updated",
      enterpriseId: String(id || ""),
      user: req.user,
      context: {
        campaign: result.rows[0],
        entreprise: { id: String(id || "") },
      },
    }).catch(() => {});

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Erreur lors de la modification de la campagne:', error);
    res.status(500).json({ error: 'Erreur lors de la modification de la campagne' });
  }
});

// ───────────────────────────────────────────────
// 🗑️ DELETE /campaigns/:campaignId — Supprimer une campagne cybersécurité (par ID seul)
// ───────────────────────────────────────────────
router.delete('/campaigns/:campaignId', verifyJWT, async (req, res) => {
  try {
    const { campaignId } = req.params;

    // Récupérer les informations de la campagne avant suppression
    const campaignResult = await pool.query(
      `SELECT * FROM v_b_clients_c_campaign WHERE id = $1`,
      [campaignId]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const campaign = campaignResult.rows[0];
    const clientId = campaign.client_id;

    // Démarrer une transaction pour supprimer toutes les données liées
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      console.log(`🗑️ Suppression en cascade de la campagne ${campaignId} (client: ${clientId})`);

      // 1. Supprimer les données MFA synchronisées pour ce client et cette campagne
      const mfaDeleteResult = await client.query(
        `DELETE FROM v_b_clients_c_azure_mfa WHERE client_id = $1`,
        [clientId]
      );
      console.log(`✅ Supprimé ${mfaDeleteResult.rowCount} entrées MFA`);

      // 2. Supprimer les statistiques Azure pour ce client
      const statsDeleteResult = await client.query(
        `DELETE FROM v_b_clients_c_azure_stats WHERE client_id = $1`,
        [clientId]
      );
      console.log(`✅ Supprimé ${statsDeleteResult.rowCount} entrées statistiques`);

      // 3. Supprimer tous les snapshots de cette campagne
      const snapshotsDeleteResult = await client.query(
        `DELETE FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1`,
        [campaignId]
      );
      console.log(`✅ Supprimé ${snapshotsDeleteResult.rowCount} snapshots`);

      // 4. Supprimer toutes les étapes de cette campagne
      const stepsDeleteResult = await client.query(
        `DELETE FROM v_b_clients_c_campaign_steps WHERE campaign_id = $1`,
        [campaignId]
      );
      console.log(`✅ Supprimé ${stepsDeleteResult.rowCount} étapes`);

      // 5. Enfin, supprimer la campagne elle-même
      const campaignDeleteResult = await client.query(
        `DELETE FROM v_b_clients_c_campaign WHERE id = $1 RETURNING *`,
        [campaignId]
      );

      await client.query('COMMIT');

      console.log(`✅ Campagne ${campaignId} supprimée avec succès`);

      res.json({
        success: true,
        deleted: {
          campaign: campaignDeleteResult.rows[0],
          deletedCounts: {
            mfa: mfaDeleteResult.rowCount,
            stats: statsDeleteResult.rowCount,
            snapshots: snapshotsDeleteResult.rowCount,
            steps: stepsDeleteResult.rowCount
          }
        }
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Erreur lors de la suppression de la campagne:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de la campagne', details: error.message });
  }
});

// ───────────────────────────────────────────────
// 🗑️ DELETE /:id/campaigns/:campaignId — Supprimer une campagne cybersécurité (legacy)
// ───────────────────────────────────────────────
router.delete('/:id/campaigns/:campaignId', verifyJWT, async (req, res) => {
  try {
    const { id, campaignId } = req.params;

    // Vérifier que la campagne existe
    const campaignResult = await pool.query(
      `SELECT * FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`,
      [campaignId, id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const campaign = campaignResult.rows[0];

    // Démarrer une transaction pour supprimer toutes les données liées
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      console.log(`🗑️ Suppression en cascade de la campagne ${campaignId} (client: ${id})`);

      // 1. Supprimer les données MFA synchronisées pour ce client
      const mfaDeleteResult = await client.query(
        `DELETE FROM v_b_clients_c_azure_mfa WHERE client_id = $1`,
        [id]
      );
      console.log(`✅ Supprimé ${mfaDeleteResult.rowCount} entrées MFA`);

      // 2. Supprimer les statistiques Azure pour ce client
      const statsDeleteResult = await client.query(
        `DELETE FROM v_b_clients_c_azure_stats WHERE client_id = $1`,
        [id]
      );
      console.log(`✅ Supprimé ${statsDeleteResult.rowCount} entrées statistiques`);

      // 3. Supprimer tous les snapshots de cette campagne
      const snapshotsDeleteResult = await client.query(
        `DELETE FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1`,
        [campaignId]
      );
      console.log(`✅ Supprimé ${snapshotsDeleteResult.rowCount} snapshots`);

      // 4. Supprimer toutes les étapes de cette campagne
      const stepsDeleteResult = await client.query(
        `DELETE FROM v_b_clients_c_campaign_steps WHERE campaign_id = $1`,
        [campaignId]
      );
      console.log(`✅ Supprimé ${stepsDeleteResult.rowCount} étapes`);

      // 5. Enfin, supprimer la campagne elle-même
      const campaignDeleteResult = await client.query(
        `DELETE FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2 RETURNING *`,
        [campaignId, id]
      );

      await client.query('COMMIT');

      console.log(`✅ Campagne ${campaignId} supprimée avec succès`);

      res.json({
        success: true,
        deleted: {
          campaign: campaignDeleteResult.rows[0],
          deletedCounts: {
            mfa: mfaDeleteResult.rowCount,
            stats: statsDeleteResult.rowCount,
            snapshots: snapshotsDeleteResult.rowCount,
            steps: stepsDeleteResult.rowCount
          }
        }
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Erreur lors de la suppression de la campagne:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de la campagne', details: error.message });
  }
});

// ───────────────────────────────────────────────
// 🚀 POST /:id/campaigns/:campaignId/launch — Lancer une campagne Microsoft Security
// ───────────────────────────────────────────────
router.post('/:id/campaigns/:campaignId/launch', verifyJWT, async (req, res) => {
  try {
    const { id, campaignId } = req.params;

    // Vérifier que la campagne existe et est de type microsoft_security
    const campaignResult = await pool.query(
      `SELECT id, type, status FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`,
      [campaignId, id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const campaign = campaignResult.rows[0];

    if (campaign.type !== 'microsoft_security') {
      return res.status(400).json({ error: 'Cette fonctionnalité est uniquement disponible pour les campagnes de type microsoft_security' });
    }

    // Vérifier si un snapshot start existe déjà
    const existingSnapshot = await pool.query(
      `SELECT id FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'start'`,
      [campaignId]
    );

    let snapshot = null;

    if (existingSnapshot.rows.length === 0) {
      const stats = await getClientMfaStatsFromDb(id);

      if (!stats) {
        return res.status(400).json({
          error: 'Aucune donnée de synchronisation. Effectuez une synchronisation des données Microsoft (bouton Synchroniser) avant de lancer la campagne.'
        });
      }

      if (!stats.lastSync) {
        return res.status(400).json({
          error: 'Aucune date de synchronisation. Effectuez une synchronisation des données Microsoft avant de lancer la campagne.'
        });
      }

      const lastSyncAge = Date.now() - new Date(stats.lastSync).getTime();
      if (lastSyncAge > RECENT_SYNC_MAX_AGE_MS) {
        return res.status(400).json({
          error: 'La dernière synchronisation est trop ancienne. Effectuez une synchronisation récente (moins de 24 h) avant de lancer la campagne.'
        });
      }

      const snapshotData = {
        source: 'db',
        lastSync: stats.lastSync,
        adminCount: stats.adminCount,
        nonAdminCount: stats.nonAdminCount,
        userCount: stats.userCount,
        mfaPercentage: stats.mfaPercentage,
        adminMfaPercentage: stats.adminMfaPercentage,
        nonAdminMfaPercentage: stats.nonAdminMfaPercentage,
        userMfaPercentage: stats.userMfaPercentage,
        mfaEnabledCount: stats.mfaEnabledCount,
        mfaDisabledCount: stats.mfaDisabledCount
      };

      const snapshotResult = await pool.query(
        `INSERT INTO v_b_clients_c_campaign_snapshot 
         (campaign_id, snapshot_type, admin_count, user_count, mfa_percentage, admin_mfa_percentage, user_mfa_percentage, mfa_enabled_count, mfa_disabled_count, snapshot_data)
         VALUES ($1, 'start', $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          campaignId,
          stats.adminCount,
          stats.userCount,
          stats.mfaPercentage,
          stats.adminMfaPercentage,
          stats.userMfaPercentage,
          stats.mfaEnabledCount,
          stats.mfaDisabledCount,
          JSON.stringify(snapshotData)
        ]
      );

      snapshot = snapshotResult.rows[0];
    } else {
      // Récupérer le snapshot existant
      const snapshotResult = await pool.query(
        `SELECT * FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'start' LIMIT 1`,
        [campaignId]
      );
      snapshot = snapshotResult.rows[0];
    }

    // Mettre à jour le statut de la campagne vers "active" (même si un snapshot existe déjà)
    await pool.query(
      `UPDATE v_b_clients_c_campaign SET status = 'active', updated_at = NOW() WHERE id = $1`,
      [campaignId]
    );

    res.json({
      success: true,
      snapshot: snapshot,
      message: existingSnapshot.rows.length > 0 
        ? 'Statut de la campagne mis à jour avec succès' 
        : 'Campagne lancée avec succès'
    });

  } catch (error) {
    console.error('Erreur lors du lancement de la campagne:', error);
    res.status(500).json({ error: 'Erreur lors du lancement de la campagne', details: error.message });
  }
});

// ───────────────────────────────────────────────
// 🏁 POST /:id/campaigns/:campaignId/finish — Terminer une campagne Microsoft Security
// ───────────────────────────────────────────────
router.post('/:id/campaigns/:campaignId/finish', verifyJWT, async (req, res) => {
  try {
    const { id, campaignId } = req.params;

    // Vérifier que la campagne existe et est en cours
    const campaignResult = await pool.query(
      `SELECT id, type, status FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`,
      [campaignId, id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const campaign = campaignResult.rows[0];

    if (campaign.type !== 'microsoft_security') {
      return res.status(400).json({ error: 'Cette fonctionnalité est uniquement disponible pour les campagnes de type microsoft_security' });
    }

    if (campaign.status !== 'active') {
      return res.status(400).json({ error: 'La campagne doit être active ou en cours pour être terminée' });
    }

    // Vérifier qu'un snapshot start existe
    const startSnapshotResult = await pool.query(
      `SELECT * FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'start'`,
      [campaignId]
    );

    if (startSnapshotResult.rows.length === 0) {
      return res.status(400).json({ error: 'Aucun snapshot de début trouvé. Veuillez d\'abord lancer la campagne.' });
    }

    // Vérifier si un snapshot end existe déjà
    const existingEndSnapshot = await pool.query(
      `SELECT id FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1 AND snapshot_type = 'end'`,
      [campaignId]
    );

    if (existingEndSnapshot.rows.length > 0) {
      return res.status(400).json({ error: 'Un snapshot de fin existe déjà pour cette campagne' });
    }

    const stats = await getClientMfaStatsFromDb(id);

    if (!stats) {
      return res.status(400).json({
        error: 'Aucune donnée de synchronisation. Effectuez une synchronisation des données Microsoft (bouton Synchroniser) avant de terminer la campagne.'
      });
    }

    const snapshotData = {
      source: 'db',
      lastSync: stats.lastSync,
      adminCount: stats.adminCount,
      nonAdminCount: stats.nonAdminCount,
      userCount: stats.userCount,
      mfaPercentage: stats.mfaPercentage,
      adminMfaPercentage: stats.adminMfaPercentage,
      nonAdminMfaPercentage: stats.nonAdminMfaPercentage,
      userMfaPercentage: stats.userMfaPercentage,
      mfaEnabledCount: stats.mfaEnabledCount,
      mfaDisabledCount: stats.mfaDisabledCount
    };

    const endSnapshotResult = await pool.query(
      `INSERT INTO v_b_clients_c_campaign_snapshot 
       (campaign_id, snapshot_type, admin_count, user_count, mfa_percentage, admin_mfa_percentage, user_mfa_percentage, mfa_enabled_count, mfa_disabled_count, snapshot_data)
       VALUES ($1, 'end', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        campaignId,
        stats.adminCount,
        stats.userCount,
        stats.mfaPercentage,
        stats.adminMfaPercentage,
        stats.userMfaPercentage,
        stats.mfaEnabledCount,
        stats.mfaDisabledCount,
        JSON.stringify(snapshotData)
      ]
    );

    const startSnapshot = startSnapshotResult.rows[0];
    const endSnapshot = endSnapshotResult.rows[0];

    // Calculer les comparaisons
    const comparison = {
      adminCount: {
        start: startSnapshot.admin_count,
        end: endSnapshot.admin_count,
        change: endSnapshot.admin_count - startSnapshot.admin_count
      },
      userCount: {
        start: startSnapshot.user_count,
        end: endSnapshot.user_count,
        change: endSnapshot.user_count - startSnapshot.user_count
      },
      mfaPercentage: {
        start: parseFloat(startSnapshot.mfa_percentage),
        end: parseFloat(endSnapshot.mfa_percentage),
        change: parseFloat(endSnapshot.mfa_percentage) - parseFloat(startSnapshot.mfa_percentage)
      },
      mfaEnabledCount: {
        start: startSnapshot.mfa_enabled_count,
        end: endSnapshot.mfa_enabled_count,
        change: endSnapshot.mfa_enabled_count - startSnapshot.mfa_enabled_count
      }
    };

    // Récupérer les informations complètes de la campagne
    const fullCampaignResult = await pool.query(
      `SELECT c.*, cl.name as client_name 
       FROM v_b_clients_c_campaign c
       LEFT JOIN v_b_clients cl ON c.client_id::text = cl.id::text
       WHERE c.id = $1`,
      [campaignId]
    );
    const fullCampaign = fullCampaignResult.rows[0];

    // Générer le PDF
    const pdfPath = path.join(CAMPAIGN_REPORTS_DIR, `campaign_${campaignId}_report.pdf`);

    try {
      await generateCampaignReportPDF(fullCampaign, startSnapshot, endSnapshot, comparison, pdfPath);
    } catch (pdfError) {
      console.error('Erreur lors de la génération du PDF:', pdfError);
      // Continuer même si le PDF échoue
    }

    // Mettre à jour le statut de la campagne
    await pool.query(
      `UPDATE v_b_clients_c_campaign SET status = 'inactive', updated_at = NOW() WHERE id = $1`,
      [campaignId]
    );

    const pdfUrl = `/api/clients/${id}/campaigns/${campaignId}/report.pdf`;

    res.json({
      success: true,
      snapshot: endSnapshotResult.rows[0],
      comparison: comparison,
      pdfUrl: pdfUrl,
      message: 'Campagne terminée avec succès'
    });

  } catch (error) {
    console.error('Erreur lors de la fin de la campagne:', error);
    res.status(500).json({ error: 'Erreur lors de la fin de la campagne', details: error.message });
  }
});

// ───────────────────────────────────────────────
// 🔄 POST /:id/campaigns/:campaignId/reset — Remettre la campagne à zéro (supprimer snapshots + permettre relance)
// ───────────────────────────────────────────────
router.post('/:id/campaigns/:campaignId/reset', verifyJWT, async (req, res) => {
  try {
    const { id, campaignId } = req.params;

    const campaignResult = await pool.query(
      `SELECT id, type, status FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`,
      [campaignId, id]
    );
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    await pool.query(
      `DELETE FROM v_b_clients_c_campaign_snapshot WHERE campaign_id = $1`,
      [campaignId]
    );
    await pool.query(
      `UPDATE v_b_clients_c_campaign SET status = 'en_preparation', updated_at = NOW() WHERE id = $1`,
      [campaignId]
    );

    res.json({
      success: true,
      message: 'Campagne remise à zéro. Vous pouvez la lancer à nouveau.'
    });
  } catch (error) {
    console.error('Erreur lors du reset de la campagne:', error);
    res.status(500).json({ error: 'Erreur lors de la remise à zéro de la campagne', details: error.message });
  }
});

// ───────────────────────────────────────────────
// 📊 GET /:id/campaigns/:campaignId/stats — Récupérer les statistiques d'une campagne
// ───────────────────────────────────────────────
router.get('/:id/campaigns/:campaignId/stats', verifyJWT, async (req, res) => {
  try {
    const { id, campaignId } = req.params;

    // Vérifier que la campagne existe
    const campaignResult = await pool.query(
      `SELECT id, type, status FROM v_b_clients_c_campaign WHERE id = $1 AND client_id = $2`,
      [campaignId, id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const campaign = campaignResult.rows[0];

    let lastSync = null;
    if (campaign.type === 'microsoft_security') {
      try {
        const r = await pool.query(`SELECT MAX(last_sync) as last_sync FROM v_b_clients_c_azure_mfa WHERE client_id = $1`, [id]);
        lastSync = r.rows[0]?.last_sync ?? null;
      } catch (_) {}
    }

    // Récupérer les snapshots - requête optimisée avec LIMIT pour éviter de charger tous les snapshots
    const snapshotsResult = await pool.query(
      `SELECT * FROM v_b_clients_c_campaign_snapshot 
       WHERE campaign_id = $1 
       ORDER BY snapshot_type, created_at DESC 
       LIMIT 2`,
      [campaignId]
    );

    const snapshots = snapshotsResult.rows;
    const startSnapshot = snapshots.find(s => s.snapshot_type === 'start');
    const endSnapshot = snapshots.find(s => s.snapshot_type === 'end');

    // Si pas de snapshots, retourner les stats actuelles (seulement si demandé explicitement via query param)
    if (!startSnapshot && !endSnapshot) {
      // Ne charger les stats Office 365 que si explicitement demandé (via ?includeCurrent=true)
      // Sinon retourner directement null pour éviter les appels API lents
      const includeCurrent = req.query.includeCurrent === 'true';
      
      if (includeCurrent && campaign.type === 'microsoft_security') {
        const stats = await getClientMfaStatsFromDb(id);
        if (stats) {
          return res.json({
            current: {
              adminCount: stats.adminCount,
              userCount: stats.userCount,
              adminMfaCount: Math.round((stats.adminCount * stats.adminMfaPercentage) / 100),
              userMfaCount: stats.mfaEnabledCount,
              adminMfaPercentage: stats.adminMfaPercentage,
              userMfaPercentage: stats.userMfaPercentage,
              regularUserCount: stats.userCount - stats.adminCount,
              regularUserMfaCount: stats.mfaEnabledCount - Math.round((stats.adminCount * stats.adminMfaPercentage) / 100)
            },
            lastSync: stats.lastSync,
            hasSnapshots: false
          });
        }
      }

      return res.json({
        current: null,
        lastSync: lastSync ?? undefined,
        hasSnapshots: false
      });
    }

    const parseSnapshotExtra = (snap) => {
      let nonAdminCount = (snap.user_count || 0) - (snap.admin_count || 0);
      let nonAdminMfaPercentage = null;
      try {
        const data = typeof snap.snapshot_data === 'string' ? JSON.parse(snap.snapshot_data) : snap.snapshot_data;
        if (data) {
          if (data.nonAdminCount != null) nonAdminCount = data.nonAdminCount;
          if (data.nonAdminMfaPercentage != null) nonAdminMfaPercentage = parseFloat(data.nonAdminMfaPercentage);
        }
      } catch (_) {}
      if (nonAdminMfaPercentage == null && nonAdminCount > 0 && snap.user_count > 0) {
        const totalMfa = (parseFloat(snap.user_mfa_percentage || snap.mfa_percentage || 0) / 100) * snap.user_count;
        const adminMfa = (parseFloat(snap.admin_mfa_percentage || snap.mfa_percentage || 0) / 100) * (snap.admin_count || 0);
        nonAdminMfaPercentage = Math.round(((totalMfa - adminMfa) / nonAdminCount) * 10000) / 100;
      }
      return { nonAdminCount, nonAdminMfaPercentage: nonAdminMfaPercentage ?? 0 };
    };

    // Si on a les deux snapshots, retourner la comparaison
    if (startSnapshot && endSnapshot) {
      const startExtra = parseSnapshotExtra(startSnapshot);
      const endExtra = parseSnapshotExtra(endSnapshot);
      const startAdminMfa = parseFloat(startSnapshot.admin_mfa_percentage || startSnapshot.mfa_percentage || 0);
      const endAdminMfa = parseFloat(endSnapshot.admin_mfa_percentage || endSnapshot.mfa_percentage || 0);
      const startUserMfa = parseFloat(startSnapshot.user_mfa_percentage || startSnapshot.mfa_percentage || 0);
      const endUserMfa = parseFloat(endSnapshot.user_mfa_percentage || endSnapshot.mfa_percentage || 0);
      
      const comparison = {
        adminCount: {
          start: startSnapshot.admin_count,
          end: endSnapshot.admin_count,
          change: endSnapshot.admin_count - startSnapshot.admin_count
        },
        userCount: {
          start: startSnapshot.user_count,
          end: endSnapshot.user_count,
          change: endSnapshot.user_count - startSnapshot.user_count
        },
        adminMfaPercentage: {
          start: startAdminMfa,
          end: endAdminMfa,
          change: endAdminMfa - startAdminMfa
        },
        userMfaPercentage: {
          start: startUserMfa,
          end: endUserMfa,
          change: endUserMfa - startUserMfa
        },
        mfaPercentage: {
          start: parseFloat(startSnapshot.mfa_percentage || 0),
          end: parseFloat(endSnapshot.mfa_percentage || 0),
          change: parseFloat(endSnapshot.mfa_percentage || 0) - parseFloat(startSnapshot.mfa_percentage || 0)
        },
        mfaEnabledCount: {
          start: startSnapshot.mfa_enabled_count,
          end: endSnapshot.mfa_enabled_count,
          change: endSnapshot.mfa_enabled_count - startSnapshot.mfa_enabled_count
        }
      };

      return res.json({
        start: {
          adminCount: startSnapshot.admin_count,
          nonAdminCount: startExtra.nonAdminCount,
          userCount: startSnapshot.user_count,
          adminMfaPercentage: parseFloat(startSnapshot.admin_mfa_percentage || startSnapshot.mfa_percentage || 0),
          nonAdminMfaPercentage: startExtra.nonAdminMfaPercentage,
          userMfaPercentage: parseFloat(startSnapshot.user_mfa_percentage || startSnapshot.mfa_percentage || 0),
          mfaPercentage: parseFloat(startSnapshot.mfa_percentage || 0),
          mfaEnabledCount: startSnapshot.mfa_enabled_count,
          mfaDisabledCount: startSnapshot.mfa_disabled_count,
          createdAt: startSnapshot.created_at
        },
        end: {
          adminCount: endSnapshot.admin_count,
          nonAdminCount: endExtra.nonAdminCount,
          userCount: endSnapshot.user_count,
          adminMfaPercentage: parseFloat(endSnapshot.admin_mfa_percentage || endSnapshot.mfa_percentage || 0),
          nonAdminMfaPercentage: endExtra.nonAdminMfaPercentage,
          userMfaPercentage: parseFloat(endSnapshot.user_mfa_percentage || endSnapshot.mfa_percentage || 0),
          mfaPercentage: parseFloat(endSnapshot.mfa_percentage || 0),
          mfaEnabledCount: endSnapshot.mfa_enabled_count,
          mfaDisabledCount: endSnapshot.mfa_disabled_count,
          createdAt: endSnapshot.created_at
        },
        comparison: comparison,
        lastSync: lastSync ?? undefined,
        hasSnapshots: true
      });
    }

    // Si seulement le snapshot start existe
    if (startSnapshot) {
      const startExtra = parseSnapshotExtra(startSnapshot);
      return res.json({
        start: {
          adminCount: startSnapshot.admin_count,
          nonAdminCount: startExtra.nonAdminCount,
          userCount: startSnapshot.user_count,
          adminMfaPercentage: parseFloat(startSnapshot.admin_mfa_percentage || startSnapshot.mfa_percentage || 0),
          nonAdminMfaPercentage: startExtra.nonAdminMfaPercentage,
          userMfaPercentage: parseFloat(startSnapshot.user_mfa_percentage || startSnapshot.mfa_percentage || 0),
          mfaPercentage: parseFloat(startSnapshot.mfa_percentage || 0),
          mfaEnabledCount: startSnapshot.mfa_enabled_count,
          mfaDisabledCount: startSnapshot.mfa_disabled_count,
          createdAt: startSnapshot.created_at
        },
        end: null,
        comparison: null,
        lastSync: lastSync ?? undefined,
        hasSnapshots: true
      });
    }

    res.json({
      start: null,
      end: null,
      comparison: null,
      lastSync: lastSync ?? undefined,
      hasSnapshots: false
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des statistiques', details: error.message });
  }
});

// ───────────────────────────────────────────────
// 📄 GET /:id/campaigns/:campaignId/report.pdf — Télécharger le rapport PDF
// ───────────────────────────────────────────────
router.get('/:id/campaigns/:campaignId/report.pdf', verifyJWT, async (req, res) => {
  try {
    const { campaignId } = req.params;

    const pdfPath = path.join(CAMPAIGN_REPORTS_DIR, `campaign_${campaignId}_report.pdf`);

    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ error: 'Rapport PDF non trouvé' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rapport_campagne_${campaignId}.pdf"`);
    
    const fileStream = fs.createReadStream(pdfPath);
    fileStream.pipe(res);

  } catch (error) {
    console.error('Erreur lors du téléchargement du PDF:', error);
    res.status(500).json({ error: 'Erreur lors du téléchargement du PDF', details: error.message });
  }
});

// ───────────────────────────────────────────────
// 📋 Routes pour les Steps (Étapes) des campagnes
// ───────────────────────────────────────────────

// GET /:id/campaigns/:campaignId/steps — Récupérer toutes les étapes d'une campagne
router.get('/:id/campaigns/:campaignId/steps', verifyJWT, async (req, res) => {
  try {
    const { campaignId } = req.params;

    const result = await pool.query(
      `SELECT s.*, u.username, u.email
       FROM v_b_clients_c_campaign_steps s
       LEFT JOIN v_b_users u ON s.assigned_user_id::text = u.id::text
       WHERE s.campaign_id = $1
       ORDER BY s.order_index ASC, s.created_at ASC`,
      [campaignId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des étapes:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des étapes', details: error.message });
  }
});

// POST /:id/campaigns/:campaignId/steps — Créer une nouvelle étape
router.post('/:id/campaigns/:campaignId/steps', verifyJWT, async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { name, assigned_user_id, due_date, duration_hours, order_index } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Le nom de l\'étape est requis' });
    }

    // Récupérer le prochain order_index si non fourni
    let finalOrderIndex = order_index;
    if (finalOrderIndex === undefined || finalOrderIndex === null) {
      const maxOrderResult = await pool.query(
        `SELECT COALESCE(MAX(order_index), 0) as max_order FROM v_b_clients_c_campaign_steps WHERE campaign_id = $1`,
        [campaignId]
      );
      finalOrderIndex = (maxOrderResult.rows[0]?.max_order || 0) + 1;
    }

    const result = await pool.query(
      `INSERT INTO v_b_clients_c_campaign_steps 
       (campaign_id, name, assigned_user_id, due_date, duration_hours, order_index)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [campaignId, name, assigned_user_id || null, due_date || null, duration_hours || null, finalOrderIndex]
    );

    // Récupérer les informations de l'utilisateur assigné
    if (result.rows[0].assigned_user_id) {
      const userResult = await pool.query(
        `SELECT username, email FROM v_b_users WHERE id = $1`,
        [result.rows[0].assigned_user_id]
      );
      result.rows[0].username = userResult.rows[0]?.username;
      result.rows[0].email = userResult.rows[0]?.email;
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur lors de la création de l\'étape:', error);
    res.status(500).json({ error: 'Erreur lors de la création de l\'étape', details: error.message });
  }
});

// PUT /:id/campaigns/:campaignId/steps/reorder — Réorganiser l'ordre des étapes (doit être avant /steps/:stepId)
router.put('/:id/campaigns/:campaignId/steps/reorder', verifyJWT, async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { stepOrders } = req.body; // Array of { id, order_index }

    if (!Array.isArray(stepOrders) || stepOrders.length === 0) {
      return res.status(400).json({ error: 'stepOrders doit être un tableau non vide' });
    }

    for (const stepOrder of stepOrders) {
      if (!stepOrder.id || typeof stepOrder.order_index !== 'number') {
        return res.status(400).json({
          error: 'Chaque stepOrder doit avoir un id et un order_index numérique',
          invalidStep: stepOrder
        });
      }
    }

    const campaignCheck = await pool.query(
      'SELECT campaign_id FROM v_b_clients_c_campaign_steps WHERE campaign_id::text = $1 LIMIT 1',
      [campaignId]
    );
    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Aucune étape trouvée pour cette campagne' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let updateCount = 0;

      for (const { id, order_index } of stepOrders) {
        const checkResult = await client.query(
          `SELECT id FROM v_b_clients_c_campaign_steps
           WHERE id::text = $1::text AND campaign_id::text = $2::text`,
          [id, campaignId]
        );
        if (checkResult.rows.length === 0) continue;

        const result = await client.query(
          `UPDATE v_b_clients_c_campaign_steps
           SET order_index = $1
           WHERE id::text = $2::text AND campaign_id::text = $3::text`,
          [order_index, id, campaignId]
        );
        updateCount += result.rowCount;
      }

      if (updateCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
      }

      await client.query('COMMIT');

      const result = await pool.query(
        `SELECT s.*, u.username, u.email
         FROM v_b_clients_c_campaign_steps s
         LEFT JOIN v_b_users u ON s.assigned_user_id::text = u.id::text
         WHERE s.campaign_id = $1
         ORDER BY s.order_index ASC, s.created_at ASC`,
        [campaignId]
      );
      res.json(result.rows);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Erreur lors de la réorganisation des étapes:', error);
    res.status(500).json({ error: 'Erreur lors de la réorganisation des étapes', details: error.message });
  }
});

// PUT /:id/campaigns/:campaignId/steps/:stepId — Mettre à jour une étape
router.put('/:id/campaigns/:campaignId/steps/:stepId', verifyJWT, async (req, res) => {
  try {
    const { stepId } = req.params;
    const { name, assigned_user_id, due_date, duration_hours, completed, order_index } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (assigned_user_id !== undefined) {
      updates.push(`assigned_user_id = $${paramIndex++}`);
      values.push(assigned_user_id || null);
    }
    if (due_date !== undefined) {
      updates.push(`due_date = $${paramIndex++}`);
      values.push(due_date || null);
    }
    if (duration_hours !== undefined) {
      updates.push(`duration_hours = $${paramIndex++}`);
      values.push(duration_hours || null);
    }
    if (completed !== undefined) {
      updates.push(`completed = $${paramIndex++}`);
      values.push(completed);
    }
    if (order_index !== undefined) {
      updates.push(`order_index = $${paramIndex++}`);
      values.push(order_index);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(stepId);

    const result = await pool.query(
      `UPDATE v_b_clients_c_campaign_steps 
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Étape non trouvée' });
    }

    // Récupérer les informations de l'utilisateur assigné
    if (result.rows[0].assigned_user_id) {
      const userResult = await pool.query(
        `SELECT username, email FROM v_b_users WHERE id = $1`,
        [result.rows[0].assigned_user_id]
      );
      result.rows[0].username = userResult.rows[0]?.username;
      result.rows[0].email = userResult.rows[0]?.email;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur lors de la mise à jour de l\'étape:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de l\'étape', details: error.message });
  }
});

// DELETE /:id/campaigns/:campaignId/steps/:stepId — Supprimer une étape
router.delete('/:id/campaigns/:campaignId/steps/:stepId', verifyJWT, async (req, res) => {
  try {
    const { stepId } = req.params;

    const result = await pool.query(
      `DELETE FROM v_b_clients_c_campaign_steps WHERE id = $1 RETURNING id`,
      [stepId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Étape non trouvée' });
    }

    res.json({ success: true, message: 'Étape supprimée avec succès' });
  } catch (error) {
    console.error('Erreur lors de la suppression de l\'étape:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de l\'étape', details: error.message });
  }
});

export default router;
