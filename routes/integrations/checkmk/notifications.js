import express from 'express';
import verifyJWT from '../../../middleware/auth.js';
const router = express.Router();
router.get('/notifications/:hostName', verifyJWT, async (req, res) => {
  res.json({
    host_name: req.params.hostName,
    events_count: 0,
    last_notification: null,
    last_notification_timestamp: null,
    events: []
  });
});
export default router;
