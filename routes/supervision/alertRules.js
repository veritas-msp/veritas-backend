import express from "express";
import verifyJWT from "../../middleware/auth.js";
import {
  buildDefaultSupervisionAlertRules,
  getSupervisionAlertRules,
  getSupervisionAlertRulesPayload,
  saveSupervisionAlertRules,
} from "../../utils/supervisionAlertRules.js";

const router = express.Router();

function requireAdmin(req, res, next) {
  if (String(req.user?.role || "").toLowerCase() !== "admin") {
    return res.status(403).json({ error: "Accès réservé aux administrateurs" });
  }
  return next();
}

router.get("/", verifyJWT, async (_req, res) => {
  try {
    const rules = await getSupervisionAlertRules({ fresh: true });
    res.json(getSupervisionAlertRulesPayload(rules));
  } catch (err) {
    console.error("[supervision-alert-rules] GET:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const incoming = req.body?.rules;
    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({ error: "rules requis (objet par famille)" });
    }
    const saved = await saveSupervisionAlertRules(incoming);
    res.json(getSupervisionAlertRulesPayload(saved));
  } catch (err) {
    console.error("[supervision-alert-rules] PUT:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/defaults", verifyJWT, (_req, res) => {
  res.json(getSupervisionAlertRulesPayload(buildDefaultSupervisionAlertRules()));
});

export default router;
