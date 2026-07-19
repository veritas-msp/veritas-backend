// ───────────────────────────────────────────────
// 📦 Check MK entry point — consolidated routes
// ───────────────────────────────────────────────

import express from 'express';

// Import all module routes
import mappingRouter from './mapping.js';
import hostsRouter from './hosts.js';
import servicesRouter from './services.js';
import availabilityRouter from './availability.js';
import metricsRouter from './metrics.js';
import eventsRouter from './events.js';
import notificationsRouter from './notifications.js';
import reportPeriodRouter from './reportPeriod.js';
import saveJobsSyncRouter from './saveJobsSync.js';
import equipmentMonitoringSyncRouter from './equipmentMonitoringSync.js';
import checkmkWebhookRouter from './webhook.js';

const router = express.Router();

// ───────────────────────────────────────────────
// 📍 Mapping routes
// ───────────────────────────────────────────────
router.use('/', mappingRouter);

// ───────────────────────────────────────────────
// ───────────────────────────────────────────────
// ───────────────────────────────────────────────
router.use('/', hostsRouter);

// ───────────────────────────────────────────────
// 📋 Service routes
// ───────────────────────────────────────────────
router.use('/', servicesRouter);

// ───────────────────────────────────────────────
// 📊 Availability routes
// ───────────────────────────────────────────────
router.use('/', availabilityRouter);

// ───────────────────────────────────────────────
// 📊 Metrics routes
// ───────────────────────────────────────────────
router.use('/', metricsRouter);

// ───────────────────────────────────────────────
// 📊 Event routes
// ───────────────────────────────────────────────
router.use('/', eventsRouter);

// ───────────────────────────────────────────────
// 📧 Notification routes
// ───────────────────────────────────────────────
router.use('/', notificationsRouter);

// ───────────────────────────────────────────────
// ───────────────────────────────────────────────
// ───────────────────────────────────────────────
router.use('/', reportPeriodRouter);

// ───────────────────────────────────────────────
// 🔄 Sync backup jobs (last_backup_date, last_backup_duration from CheckMK)
// ───────────────────────────────────────────────
router.use('/', saveJobsSyncRouter);

// ───────────────────────────────────────────────
// 🔄 Sync monitoring data (persist CheckMK data for EquipmentDetailPage)
// ───────────────────────────────────────────────
router.use('/', equipmentMonitoringSyncRouter);

// ───────────────────────────────────────────────
// 📦 Check MK entry point — consolidated routes
// ───────────────────────────────────────────────
router.use('/', checkmkWebhookRouter);

export default router;
