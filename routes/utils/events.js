// ───────────────────────────────────────────────
// 📅 Routes pour la gestion des événements du planning
// ───────────────────────────────────────────────
import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import {
  normalizePlanningEventDateInput,
  comparePlanningEventDates,
} from './planningEventDateTime.js';
import { ensureEventsSchema } from '../../services/ensureEventsSchema.js';

const router = express.Router();
router.use(verifyJWT);

function formatEventRowForApi(row) {
  if (!row) return row;
  const start = normalizePlanningEventDateInput(row.start);
  const end = normalizePlanningEventDateInput(row.end);
  return {
    ...row,
    start: start ? start.replace(" ", "T") : row.start,
    end: end ? end.replace(" ", "T") : row.end,
  };
}

function buildEventsListSql(schema, { whereSql, orderSql, limitSql }) {
  const ticketFields = schema.hasTicketId
    ? `e.ticket_id,
        t.ticket_number,
        t.type AS ticket_type,
        t.client_id AS ticket_client_id,
        t.requester_contact_id AS ticket_requester_contact_id,
        COALESCE(
          NULLIF(TRIM(CONCAT_WS(' ', rc.prenom, rc.nom)), ''),
          rc.email,
          req_u.username,
          req_u.email
        ) AS ticket_requester_name`
    : `NULL::uuid AS ticket_id,
        NULL::text AS ticket_number,
        NULL::text AS ticket_type,
        NULL::integer AS ticket_client_id,
        NULL::uuid AS ticket_requester_contact_id,
        NULL::text AS ticket_requester_name`;

  const ticketJoins = schema.hasTicketId
    ? `LEFT JOIN v_b_tickets t ON t.id = e.ticket_id
      LEFT JOIN v_b_contacts rc ON rc.id = t.requester_contact_id
      LEFT JOIN v_b_users req_u ON req_u.id = t.requester_user_id`
    : "";

  return `SELECT 
        e.id,
        e.title,
        e.type,
        to_char(e.start, 'YYYY-MM-DD"T"HH24:MI:SS') AS start,
        to_char(e."end", 'YYYY-MM-DD"T"HH24:MI:SS') AS "end",
        to_char(e."end", 'YYYY-MM-DD"T"HH24:MI:SS') AS event_end,
        e.description,
        e.client_id,
        e.equipment_id,
        e.user_id,
        e.assigned_user_id,
        ${ticketFields},
        e.created_at,
        e.updated_at
      FROM v_b_events e
      ${ticketJoins}
      ${whereSql}
      ${orderSql}${limitSql}`;
}

// ───────────────────────────────────────────────
// 📋 GET /api/events — Récupérer tous les événements
// ───────────────────────────────────────────────
router.get('/', verifyJWT, async (req, res) => {
  try {
    const schema = await ensureEventsSchema();
    const { clientId, upcoming, recent, limit } = req.query;
    const where = [];
    const values = [];
    let i = 1;
    const isUpcoming = upcoming === "true" || upcoming === "1";
    const isRecent = recent === "true" || recent === "1";

    if (clientId !== undefined && clientId !== "") {
      where.push(`e.client_id = $${i++}`);
      values.push(Number(clientId));
    }
    if (req.query.ticketId !== undefined && req.query.ticketId !== "") {
      if (!schema.hasTicketId) {
        return res.json([]);
      }
      where.push(`e.ticket_id = $${i++}`);
      values.push(String(req.query.ticketId));
    }
    if (req.query.equipmentId !== undefined && req.query.equipmentId !== "") {
      where.push(`e.equipment_id::text = $${i++}`);
      values.push(String(req.query.equipmentId).trim());
    }
    if (req.query.startDate !== undefined && req.query.startDate !== "") {
      where.push(`e."end" >= $${i++}::timestamptz`);
      values.push(String(req.query.startDate).trim());
    }
    if (req.query.endDate !== undefined && req.query.endDate !== "") {
      where.push(`e.start <= $${i++}::timestamptz`);
      values.push(String(req.query.endDate).trim());
    }
    if (isUpcoming) {
      where.push(`e."end" >= NOW()`);
    }
    if (isRecent) {
      where.push(`e."end" < NOW()`);
      where.push(`e."end" >= NOW() - INTERVAL '30 days'`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limitValue = Math.min(Math.max(Number(limit) || 0, 0), 200);
    const limitSql = limitValue > 0 ? ` LIMIT ${limitValue}` : "";
    const orderSql = isRecent ? `ORDER BY e."end" DESC` : `ORDER BY e.start ASC`;

    const result = await pool.query(
      buildEventsListSql(schema, { whereSql, orderSql, limitSql }),
      values
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Erreur lors de la récupération des événements:', err);
    res.status(500).json({ error: 'Erreur lors de la récupération des événements' });
  }
});

// ───────────────────────────────────────────────
// ➕ POST /api/events — Créer un événement
// ───────────────────────────────────────────────
router.post(
  '/',
  verifyJWT,
  [
    body('title').notEmpty().withMessage('Le titre est requis'),
    body('type').isIn(['intervention', 'presentation', 'maintenance', 'maintenance_preventive', 'mise_a_jour', 'integration_monitoring', 'conge', 'other']).withMessage('Type d\'événement invalide'),
    body('start').isISO8601().withMessage('La date de début doit être au format ISO8601'),
    body('end').isISO8601().withMessage('La date de fin doit être au format ISO8601'),
    body('clientId').optional({ nullable: true, checkFalsy: true }).isInt().withMessage('clientId doit être un entier'),
    body('equipmentId').optional({ nullable: true, checkFalsy: true }).custom((value) => {
      if (value === null || value === undefined || value === '') return true;
      // Accepter les entiers, strings (IDs générés), UUID (services), ou format "Type-Nom-Index" (cybersécurité)
      return Number.isInteger(Number(value)) || typeof value === 'string';
    }).withMessage('equipmentId doit être un entier ou une chaîne de caractères'),
    body('assignedUserId').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('assignedUserId doit être un UUID valide'),
    body('ticketId').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('ticketId doit être un UUID valide'),
  ],
  async (req, res) => {
    try {
      const schema = await ensureEventsSchema();
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          error: 'Erreur de validation',
          errors: errors.array() 
        });
      }

      const { title, type, start, end, description, clientId, equipmentId, assignedUserId, ticketId } = req.body;
      const userId = req.user.id;

      const startStored = normalizePlanningEventDateInput(start);
      const endStored = normalizePlanningEventDateInput(end);
      if (!startStored || !endStored) {
        return res.status(400).json({ error: 'Dates de début ou de fin invalides' });
      }
      if (comparePlanningEventDates(end, start) <= 0) {
        return res.status(400).json({ error: 'La date de fin doit être après la date de début' });
      }

      if (ticketId && !schema.hasTicketId) {
        return res.status(503).json({
          error: 'Les rappels liés aux tickets ne sont pas encore disponibles sur cette base.',
        });
      }

      if (ticketId && schema.hasTicketId) {
        const existingReminder = await pool.query(
          'SELECT id FROM v_b_events WHERE ticket_id = $1 LIMIT 1',
          [ticketId]
        );
        if (existingReminder.rows.length > 0) {
          return res.status(409).json({ error: 'Un rappel existe déjà pour ce ticket' });
        }
      }

      const insertColumns = [
        'title',
        'type',
        'start',
        '"end"',
        'description',
        'client_id',
        'equipment_id',
        'user_id',
        'assigned_user_id',
      ];
      const insertValues = [
        title,
        type,
        startStored,
        endStored,
        description || null,
        clientId || null,
        equipmentId || null,
        userId,
        assignedUserId || null,
      ];

      if (schema.hasTicketId) {
        insertColumns.push('ticket_id');
        insertValues.push(ticketId || null);
      }

      const placeholders = insertValues.map((_, index) => `$${index + 1}`);
      insertColumns.push('created_at', 'updated_at');
      placeholders.push('NOW()', 'NOW()');

      const result = await pool.query(
        `INSERT INTO v_b_events (${insertColumns.join(', ')})
         VALUES (${placeholders.join(', ')})
         RETURNING *`,
        insertValues
      );

      res.status(201).json(formatEventRowForApi(result.rows[0]));
    } catch (err) {
      console.error('Erreur lors de la création de l\'événement:', err);
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'Un rappel existe déjà pour ce ticket' });
      }
      res.status(500).json({ error: 'Erreur lors de la création de l\'événement' });
    }
  }
);

// ───────────────────────────────────────────────
// ✏️ PUT /api/events/:id — Mettre à jour un événement
// ───────────────────────────────────────────────
router.put(
  '/:id',
  verifyJWT,
  [
    body('title').optional().notEmpty().withMessage('Le titre ne peut pas être vide'),
    body('type').optional().isIn(['intervention', 'presentation', 'maintenance', 'maintenance_preventive', 'mise_a_jour', 'integration_monitoring', 'conge', 'other']).withMessage('Type d\'événement invalide'),
    body('start').optional().isISO8601().withMessage('La date de début doit être au format ISO8601'),
    body('end').optional().isISO8601().withMessage('La date de fin doit être au format ISO8601'),
    body('clientId').optional({ nullable: true, checkFalsy: true }).isInt().withMessage('clientId doit être un entier'),
    body('equipmentId').optional({ nullable: true, checkFalsy: true }).custom((value) => {
      if (value === null || value === undefined || value === '') return true;
      // Accepter les entiers, strings (IDs générés), UUID (services), ou format "Type-Nom-Index" (cybersécurité)
      return Number.isInteger(Number(value)) || typeof value === 'string';
    }).withMessage('equipmentId doit être un entier ou une chaîne de caractères'),
    body('assignedUserId').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('assignedUserId doit être un UUID valide'),
    body('ticketId').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('ticketId doit être un UUID valide'),
  ],
  async (req, res) => {
    try {
      const schema = await ensureEventsSchema();
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { id } = req.params;
      const { title, type, start, end, description, clientId, equipmentId, assignedUserId, ticketId } = req.body;

      // Vérifier que l'événement existe et appartient à l'utilisateur
      const existingEvent = await pool.query(
        'SELECT * FROM v_b_events WHERE id = $1',
        [id]
      );

      if (existingEvent.rows.length === 0) {
        return res.status(404).json({ error: 'Événement non trouvé' });
      }

      // Vérifier que la date de fin est après la date de début si les deux sont fournies
      const nextStart =
        start !== undefined
          ? normalizePlanningEventDateInput(start)
          : normalizePlanningEventDateInput(existingEvent.rows[0].start);
      const nextEnd =
        end !== undefined
          ? normalizePlanningEventDateInput(end)
          : normalizePlanningEventDateInput(existingEvent.rows[0].end);

      if (start !== undefined && !nextStart) {
        return res.status(400).json({ error: 'Date de début invalide' });
      }
      if (end !== undefined && !nextEnd) {
        return res.status(400).json({ error: 'Date de fin invalide' });
      }
      if (nextStart && nextEnd && comparePlanningEventDates(nextEnd, nextStart) <= 0) {
        return res.status(400).json({ error: 'La date de fin doit être après la date de début' });
      }


      // Construire la requête de mise à jour dynamiquement
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (title !== undefined) {
        updates.push(`title = $${paramIndex++}`);
        values.push(title);
      }
      if (type !== undefined) {
        updates.push(`type = $${paramIndex++}`);
        values.push(type);
      }
      if (start !== undefined) {
        updates.push(`start = $${paramIndex++}`);
        values.push(nextStart);
      }
      if (end !== undefined) {
        updates.push(`"end" = $${paramIndex++}`);
        values.push(nextEnd);
      }
      if (description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        values.push(description || null);
      }
      if (clientId !== undefined) {
        updates.push(`client_id = $${paramIndex++}`);
        values.push(clientId || null);
      }
      if (equipmentId !== undefined) {
        updates.push(`equipment_id = $${paramIndex++}`);
        values.push(equipmentId || null);
      }
      if (assignedUserId !== undefined) {
        updates.push(`assigned_user_id = $${paramIndex++}`);
        values.push(assignedUserId || null);
      }
      if (ticketId !== undefined) {
        if (!schema.hasTicketId) {
          return res.status(503).json({
            error: 'Les rappels liés aux tickets ne sont pas encore disponibles sur cette base.',
          });
        }
        if (ticketId) {
          const duplicateReminder = await pool.query(
            'SELECT id FROM v_b_events WHERE ticket_id = $1 AND id <> $2 LIMIT 1',
            [ticketId, id]
          );
          if (duplicateReminder.rows.length > 0) {
            return res.status(409).json({ error: 'Un rappel existe déjà pour ce ticket' });
          }
        }
        updates.push(`ticket_id = $${paramIndex++}`);
        values.push(ticketId || null);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
      }

      updates.push(`updated_at = NOW()`);
      values.push(id);

      const result = await pool.query(
        `UPDATE v_b_events 
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *`,
        values
      );

      res.json(formatEventRowForApi(result.rows[0]));
    } catch (err) {
      console.error('Erreur lors de la mise à jour de l\'événement:', err);
      res.status(500).json({ error: 'Erreur lors de la mise à jour de l\'événement' });
    }
  }
);

// ───────────────────────────────────────────────
// 🗑️ DELETE /api/events/:id — Supprimer un événement
// ───────────────────────────────────────────────
router.delete('/:id', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;

    // Vérifier que l'événement existe
    const existingEvent = await pool.query(
      'SELECT * FROM v_b_events WHERE id = $1',
      [id]
    );

    if (existingEvent.rows.length === 0) {
      return res.status(404).json({ error: 'Événement non trouvé' });
    }

    await pool.query('DELETE FROM v_b_events WHERE id = $1', [id]);

    res.json({ success: true, message: 'Événement supprimé avec succès' });
  } catch (err) {
    console.error('Erreur lors de la suppression de l\'événement:', err);
    res.status(500).json({ error: 'Erreur lors de la suppression de l\'événement' });
  }
});

export default router;

