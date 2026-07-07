import express from "express";
import {
  getWhatsAppConfig,
  handleWhatsAppWebhookPayload,
  verifyWebhookSignature,
} from "../../../services/whatsappService.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const config = await getWhatsAppConfig();
    const mode = String(req.query["hub.mode"] || "");
    const token = String(req.query["hub.verify_token"] || "");
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token && token === config.verifyToken) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Forbidden");
  } catch (error) {
    console.error("Erreur vérification webhook WhatsApp:", error);
    return res.status(500).send("Error");
  }
});

router.post("/", async (req, res) => {
  try {
    const config = await getWhatsAppConfig();
    if (!config.enabled) {
      return res.status(200).json({ success: true, skipped: true });
    }

    const rawBody = req.rawBody;
    const signature = req.get("x-hub-signature-256");
    if (config.appSecret && !verifyWebhookSignature(rawBody, signature, config.appSecret)) {
      return res.status(403).json({ error: "Signature invalide" });
    }

    const results = await handleWhatsAppWebhookPayload(req.body || {});
    return res.status(200).json({ success: true, results });
  } catch (error) {
    console.error("Erreur webhook WhatsApp:", error);
    // Meta réessaie en cas d'erreur — on répond 200 pour éviter les boucles si traitement partiel
    return res.status(200).json({ success: false, error: error?.message || "Erreur interne" });
  }
});

export default router;
