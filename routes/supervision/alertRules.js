import express from "express";
import verifyJWT from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { buildDefaultSupervisionAlertRules, getSupervisionAlertRules, getSupervisionAlertRulesPayload, saveSupervisionAlertRules } from "../../utils/supervisionAlertRules.js";
const router = express.Router();
router.get("/", verifyJWT, requirePermission("supervision.view"), async (_req, res) => {
  try {
    const rules = await getSupervisionAlertRules({
      fresh: true
    });
    res.json(getSupervisionAlertRulesPayload(rules));
  } catch (err) {
    console.error("[supervision-alert-rules] GET:", err.message);
    res.status(500).json({
      error: "Server error"
    });
  }
});
router.put("/", verifyJWT, requirePermission("supervision.manage"), async (req, res) => {
  try {
    const incoming = req.body?.rules;
    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({
        error: "rurequired (object per family)"
      });
    }
    const saved = await saveSupervisionAlertRules(incoming);
    res.json(getSupervisionAlertRulesPayload(saved));
  } catch (err) {
    console.error("[supervision-alert-rules] PUT:", err.message);
    res.status(500).json({
      error: "Server error"
    });
  }
});
router.get("/defaults", verifyJWT, requirePermission("supervision.view"), (_req, res) => {
  res.json(getSupervisionAlertRulesPayload(buildDefaultSupervisionAlertRules()));
});
export default router;
