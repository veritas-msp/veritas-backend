import express from "express";
import { testWhatsAppConnection } from "../../../services/whatsappService.js";

const router = express.Router();

router.post("/test", async (req, res) => {
  try {
    const info = await testWhatsAppConnection();
    res.json({
      success: true,
      message: "Connexion à l'API WhatsApp Business réussie.",
      details: [
        info.verifiedName ? `Compte : ${info.verifiedName}` : null,
        info.displayPhoneNumber ? `Numéro : ${info.displayPhoneNumber}` : null,
        info.qualityRating ? `Qualité : ${info.qualityRating}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      info,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error?.message || "Échec du test WhatsApp.",
      details: error?.message,
    });
  }
});

export default router;
