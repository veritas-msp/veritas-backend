import express from "express";
import { getEditionPayload } from "../../utils/edition.js";
import { ensureFreshLicense } from "../../utils/proLicense.js";
const router = express.Router();
router.get("/", async (_req, res) => {
  try {
    await ensureFreshLicense();
    res.json(getEditionPayload());
  } catch (error) {
    console.error("[edition] GET /:", error.message);
    res.status(503).json({
      error: "License validation unavailable",
      code: "LICENSE_CHECK_FAILED"
    });
  }
});
export default router;
