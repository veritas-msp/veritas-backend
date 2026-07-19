import express from "express";
import { pool } from "../../../database/db.js";
import { getMonitoringAutomationConfig } from "../../../utils/monitoringAutomationConfig.js";
import { recordMonitoringEvent } from "../../../services/monitoringEventQueue.js";
import { runEquipmentMonitoringAlertScan } from "../../../services/equipmentMonitoringAlertScan.js";

const router = express.Router();

function verifyWebhookSecret(req, secret) {
  if (!secret) return false;
  const header = req.headers["x-veritas-webhook-secret"] || req.headers["authorization"];
  if (!header) return false;
  const token = String(header).replace(/^Bearer\s+/i, "").trim();
  return token === secret;
}

/**
 * CheckMK / external monitoring webhook — triggers sync and alert scan.
 * POST /api/checkmk/webhook
 */
router.post("/webhook", async (req, res) => {
  try {
    const config = await getMonitoringAutomationConfig();
    const webhook = config?.checkmkWebhook || {};

    if (webhook.enabled !== true) {
      return res.status(403).json({ error: "Webhook désactivé" });
    }

    if (!verifyWebhookSecret(req, webhook.secret)) {
      return res.status(401).json({ error: "Secret webhook invalide" });
    }

    const body = req.body || {};
    const hostName = body.host_name || body.hostName || body.hostname || null;
    const clientId = body.client_id || body.clientId || null;
    const state = String(body.state || body.status || "").toLowerCase();

    await recordMonitoringEvent({
      source: "checkmk_webhook",
      eventType: "checkmk_alert",
      clientId: clientId ? Number(clientId) : null,
      payload: body,
      status: "pending",
    });

    if (hostName && clientId && webhook.triggerSync !== false) {
      const mkRow = await pool.query(
        `SELECT equipment_id, equipment_family
         FROM v_b_equipment_checkmk_monitoring
         WHERE client_id = $1 AND checkmk_host_name = $2
         LIMIT 1`,
        [Number(clientId), String(hostName)]
      );

      if (mkRow.rows[0]) {
        await pool.query(
          `UPDATE v_b_equipment_checkmk_monitoring SET updated_at = NOW() WHERE client_id = $1 AND checkmk_host_name = $2`,
          [Number(clientId), String(hostName)]
        );
      }
    }

    const scanResult = await runEquipmentMonitoringAlertScan();

    res.json({
      ok: true,
      state,
      scan: scanResult,
    });
  } catch (err) {
    console.error("[checkmk/webhook]", err.message);
    res.status(500).json({ error: "Erreur webhook" });
  }
});

export default router;
