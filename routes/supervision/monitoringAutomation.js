import express from "express";
import verifyJWT from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import {
  getMonitoringAutomationConfig,
  saveMonitoringAutomationConfig,
  getMonitoringRunbooks,
  saveMonitoringRunbooks,
  DEFAULT_MONITORING_AUTOMATION_CONFIG,
  DEFAULT_MONITORING_RUNBOOKS,
} from "../../utils/monitoringAutomationConfig.js";
import {
  enableMonitoringAlertsForClient,
  loadSupervisionEquipmentInventory,
} from "../../utils/equipmentInventoryScan.js";
import {
  computeMonitoringAlertStats,
  computeMonitoringMetrics,
} from "../../services/monitoringMetricsService.js";
import {
  ingestExternalMonitoringEvent,
  listMonitoringEvents,
} from "../../services/monitoringEventQueue.js";
import { loadEquipmentMonitoringTimeline } from "../../services/equipmentMonitoringTimelineService.js";
import { runEquipmentMonitoringAlertScan } from "../../services/equipmentMonitoringAlertScan.js";

const router = express.Router();

router.get("/config", verifyJWT, requirePermission("supervision.view"), async (req, res) => {
  try {
    const config = await getMonitoringAutomationConfig();
    res.json({ config, defaults: DEFAULT_MONITORING_AUTOMATION_CONFIG });
  } catch (err) {
    console.error("[monitoring-automation] GET config:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/config", verifyJWT, requirePermission("supervision.manage"), async (req, res) => {
  try {
    const config = await saveMonitoringAutomationConfig(req.body?.config || req.body || {});
    res.json({ config });
  } catch (err) {
    console.error("[monitoring-automation] PUT config:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/runbooks", verifyJWT, requirePermission("supervision.view"), async (req, res) => {
  try {
    const runbooks = await getMonitoringRunbooks();
    res.json({ runbooks, defaults: DEFAULT_MONITORING_RUNBOOKS });
  } catch (err) {
    console.error("[monitoring-automation] GET runbooks:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/runbooks", verifyJWT, requirePermission("supervision.manage"), async (req, res) => {
  try {
    const runbooks = await saveMonitoringRunbooks(req.body?.runbooks || []);
    res.json({ runbooks });
  } catch (err) {
    console.error("[monitoring-automation] PUT runbooks:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post(
  "/clients/:clientId/enable-alerts",
  verifyJWT,
  requirePermission("supervision.manage"),
  async (req, res) => {
    try {
      const clientId = Number(req.params.clientId);
      if (!clientId) return res.status(400).json({ error: "clientId invalide" });

      const families = Array.isArray(req.body?.families) ? req.body.families : null;
      const result = await enableMonitoringAlertsForClient(clientId, { equipmentFamilies: families });
      res.json(result);
    } catch (err) {
      console.error("[monitoring-automation] enable-alerts:", err.message);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

router.get(
  "/clients/:clientId/inventory-summary",
  verifyJWT,
  requirePermission("supervision.view"),
  async (req, res) => {
    try {
      const clientId = Number(req.params.clientId);
      if (!clientId) return res.status(400).json({ error: "clientId invalide" });
      const inventory = await loadSupervisionEquipmentInventory({ clientId });
      res.json({
        total: inventory.length,
        families: [...new Set(inventory.map((i) => i.equipmentFamily))],
      });
    } catch (err) {
      console.error("[monitoring-automation] inventory-summary:", err.message);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

router.get("/metrics", verifyJWT, requirePermission("supervision.view"), async (req, res) => {
  try {
    const days = Number(req.query.days) || 30;
    const clientId = req.query.clientId ? Number(req.query.clientId) : null;
    const metrics = await computeMonitoringMetrics({ days, clientId });
    res.json(metrics);
  } catch (err) {
    console.error("[monitoring-automation] metrics:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/alert-stats", verifyJWT, requirePermission("supervision.view"), async (req, res) => {
  try {
    const clientId = req.query.clientId ? Number(req.query.clientId) : null;
    const stats = await computeMonitoringAlertStats({ clientId });
    res.json(stats);
  } catch (err) {
    console.error("[monitoring-automation] alert-stats:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/events", verifyJWT, requirePermission("supervision.view"), async (req, res) => {
  try {
    const events = await listMonitoringEvents({
      clientId: req.query.clientId ? Number(req.query.clientId) : null,
      status: req.query.status || null,
      limit: Number(req.query.limit) || 100,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ events });
  } catch (err) {
    console.error("[monitoring-automation] events:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/events", verifyJWT, requirePermission("supervision.manage"), async (req, res) => {
  try {
    const event = await ingestExternalMonitoringEvent(req.body || {});
    res.status(201).json({ event });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || "Erreur serveur" });
  }
});

router.get(
  "/equipment/:equipmentId/timeline",
  verifyJWT,
  requirePermission("supervision.view"),
  async (req, res) => {
    try {
      const clientId = Number(req.query.clientId);
      if (!clientId) return res.status(400).json({ error: "clientId requis" });

      const timeline = await loadEquipmentMonitoringTimeline({
        equipmentId: req.params.equipmentId,
        clientId,
        days: Number(req.query.days) || 90,
      });
      res.json(timeline);
    } catch (err) {
      console.error("[monitoring-automation] timeline:", err.message);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

router.post("/scan", verifyJWT, requirePermission("supervision.manage"), async (req, res) => {
  try {
    const result = await runEquipmentMonitoringAlertScan();
    res.json(result);
  } catch (err) {
    console.error("[monitoring-automation] scan:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
