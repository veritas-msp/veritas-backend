// ───────────────────────────────────────────────
// 📦 Point d'entrée Check MK - Routes consolidées
// ───────────────────────────────────────────────

import express from 'express';

// Importer tous les modules de routes
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

const router = express.Router();

// ───────────────────────────────────────────────
// 📍 Routes de Mapping
// ───────────────────────────────────────────────
router.use('/', mappingRouter);

// ───────────────────────────────────────────────
// 🏠 Routes des Hôtes
// ───────────────────────────────────────────────
router.use('/', hostsRouter);

// ───────────────────────────────────────────────
// 📋 Routes des Services
// ───────────────────────────────────────────────
router.use('/', servicesRouter);

// ───────────────────────────────────────────────
// 📊 Routes de Disponibilité
// ───────────────────────────────────────────────
router.use('/', availabilityRouter);

// ───────────────────────────────────────────────
// 📊 Routes des Métriques
// ───────────────────────────────────────────────
router.use('/', metricsRouter);

// ───────────────────────────────────────────────
// 📊 Routes des Événements
// ───────────────────────────────────────────────
router.use('/', eventsRouter);

// ───────────────────────────────────────────────
// 📧 Routes des Notifications
// ───────────────────────────────────────────────
router.use('/', notificationsRouter);

// ───────────────────────────────────────────────
// 📋 Période du rapport (événements + disponibilité pour la période uniquement)
// ───────────────────────────────────────────────
router.use('/', reportPeriodRouter);

// ───────────────────────────────────────────────
// 🔄 Sync jobs sauvegarde (last_backup_date, last_backup_duration depuis CheckMK)
// ───────────────────────────────────────────────
router.use('/', saveJobsSyncRouter);

// ───────────────────────────────────────────────
// 🔄 Sync monitoring équipement (persistance CheckMK pour EquipmentDetailPage)
// ───────────────────────────────────────────────
router.use('/', equipmentMonitoringSyncRouter);

export default router;
