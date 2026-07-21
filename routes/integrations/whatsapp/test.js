import express from "express";
import { testWhatsAppConnection } from "../../../services/whatsappService.js";
const router = express.Router();
router.post("/test", async (req, res) => {
  try {
    const info = await testWhatsAppConnection();
    res.json({
      success: true,
      message: "WhatsApp Business API connection successful.",
      details: [info.verifiedName ? `Compte : ${info.verifiedName}` : null, info.displayPhoneNumber ? `Number: ${info.displayPhoneNumber}` : null, info.qualityRating ? `Quality: ${info.qualityRating}` : null].filter(Boolean).join("\n"),
      info
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error?.message || "WhatsApp tis failed.",
      details: error?.message
    });
  }
});
export default router;
