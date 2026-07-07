// ───────────────────────────────────────────────
// 📧 Routes des Notifications Check MK
// ───────────────────────────────────────────────

import express from 'express';
import verifyJWT from '../../../middleware/auth.js';

const router = express.Router();

// ───────────────────────────────────────────────
// 📧 Endpoint : Récupérer les informations de notifications pour un host
// NOTE: Désactivé car les notifications ne sont pas accessibles via l'API REST Check MK
// ───────────────────────────────────────────────
router.get('/notifications/:hostName', verifyJWT, async (req, res) => {
  // Retourner 0 notifications car l'API Check MK ne permet pas de récupérer les notifications réelles
  res.json({ 
    host_name: req.params.hostName,
    events_count: 0,
    last_notification: null,
    last_notification_timestamp: null,
    events: []
  });
});

export default router;
