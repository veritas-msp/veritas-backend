// ───────────────────────────────────────────────
// 📧 Routes Notifications Check MK
// ───────────────────────────────────────────────

import express from 'express';
import verifyJWT from '../../../middleware/auth.js';

const router = express.Router();

// ───────────────────────────────────────────────
// 📧 Endpoint: fetch notification information for a host
// NOTE: Disabled because notifications are not accessible via the Check MK REST API
// ───────────────────────────────────────────────
router.get('/notifications/:hostName', verifyJWT, async (req, res) => {
  // Return 0 notifications because the Check MK API cannot fetch real notifications
  res.json({ 
    host_name: req.params.hostName,
    events_count: 0,
    last_notification: null,
    last_notification_timestamp: null,
    events: []
  });
});

export default router;
