import express from "express";
import verifyJWT from "../../middleware/auth.js";
import { pool } from "../../database/db.js";
import {
  areMonitoringAlertsEnabled,
  clearEquipmentAlertSuspension,
  getEquipmentAlertSettings,
  isAlertSuspensionActive,
  resolveEquipmentFamilyKey,
  setEquipmentAlertsEnabled,
  upsertEquipmentAlertSuspension,
} from "../../utils/equipmentMonitoringAlerts.js";

const router = express.Router();

router.get("/by-client/:clientId", verifyJWT, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "clientId requis" });

    const result = await pool.query(
      `SELECT * FROM v_b_equipment_monitoring_alerts WHERE client_id = $1`,
      [clientId]
    );

    const map = {};
    for (const row of result.rows) {
      const key = `${row.equipment_id}:${row.equipment_family}`;
      const settings = {
        alertsEnabled: Boolean(row.alerts_enabled),
        suspensionType: row.suspension_type,
        suspendedUntil: row.suspended_until,
      };
      map[key] = {
        alertsEnabled: settings.alertsEnabled,
        suspended: isAlertSuspensionActive(settings),
        blocked: !areMonitoringAlertsEnabled({
          alertsEnabled: settings.alertsEnabled,
          suspensionType: settings.suspensionType,
          suspendedUntil: settings.suspendedUntil,
        }),
        suspensionType: row.suspension_type,
        suspendedUntil: row.suspended_until,
        lastKnownStatus: row.last_known_status,
        lastTicketId: row.last_ticket_id,
      };
    }
    res.json({ alerts: map });
  } catch (err) {
    console.error("[equipment-monitoring-alerts] GET by-client:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

function parseDurationMinutes(value) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

router.get("/:clientId/:equipmentId", verifyJWT, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const equipmentId = String(req.params.equipmentId || "").trim();
    const family =
      resolveEquipmentFamilyKey(req.query.family || req.query.type) ||
      String(req.query.family || "").trim();

    if (!clientId || !equipmentId || !family) {
      return res.status(400).json({ error: "clientId, equipmentId et family requis" });
    }

    const settings = await getEquipmentAlertSettings(clientId, equipmentId, family);
    res.json({
      settings: settings || null,
      suspended: isAlertSuspensionActive(settings),
      alertsEnabled: Boolean(settings?.alertsEnabled),
    });
  } catch (err) {
    console.error("[equipment-monitoring-alerts] GET:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/:clientId/:equipmentId", verifyJWT, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const equipmentId = String(req.params.equipmentId || "").trim();
    const {
      family,
      type,
      equipmentName,
      suspensionType,
      suspendedUntil,
      durationMinutes,
      reason,
      alertsEnabled,
    } = req.body || {};

    const equipmentFamily = resolveEquipmentFamilyKey(family || type);
    if (!clientId || !equipmentId || !equipmentFamily) {
      return res.status(400).json({ error: "clientId, equipmentId et family requis" });
    }

    let untilIso = suspendedUntil || null;
    if (suspensionType === "temporary" && !untilIso) {
      const minutes = parseDurationMinutes(durationMinutes) || 60;
      untilIso = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    }

    if (suspensionType === "none" || suspensionType === null || suspensionType === "") {
      await clearEquipmentAlertSuspension(clientId, equipmentId, equipmentFamily);
      const settings = await setEquipmentAlertsEnabled({
        clientId,
        equipmentId,
        equipmentFamily,
        equipmentName,
        alertsEnabled: alertsEnabled === true,
      });
      return res.json({
        settings,
        suspended: false,
        alertsEnabled: Boolean(settings?.alertsEnabled),
      });
    }

    if (suspensionType !== "temporary" && suspensionType !== "permanent") {
      return res.status(400).json({ error: "suspensionType invalide (temporary|permanent|none)" });
    }

    const settings = await upsertEquipmentAlertSuspension({
      clientId,
      equipmentId,
      equipmentFamily,
      equipmentName,
      suspensionType,
      suspendedUntil: suspensionType === "temporary" ? untilIso : null,
      suspendedBy: req.user?.id || null,
      suspensionReason: reason || null,
    });

    res.json({
      settings,
      suspended: isAlertSuspensionActive(settings),
      alertsEnabled: Boolean(settings?.alertsEnabled),
    });
  } catch (err) {
    console.error("[equipment-monitoring-alerts] PUT:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
