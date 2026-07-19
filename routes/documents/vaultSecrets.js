import express from "express";
import verifyJWT from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import {
  createAgentVaultSecret,
  listAgentVaultSecrets,
  revokeAgentVaultSecret,
} from "../../services/clientVaultSecretService.js";

const router = express.Router();

function requireAgent(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (role === "client") {
    return res.status(403).json({ error: "Accès réservé aux agents." });
  }
  next();
}

router.use(verifyJWT, requireAgent);

router.get("/", requirePermission("vault.view"), async (req, res) => {
  try {
    const contactId = Number(req.query.contactId);
    if (!contactId) return res.status(400).json({ error: "contactId requis." });
    const secrets = await listAgentVaultSecrets(contactId);
    res.json(secrets);
  } catch (err) {
    console.error("[GET /vault-secrets]", err.message);
    res.status(500).json({ error: err.message || "Erreur serveur." });
  }
});

router.post("/", requirePermission("vault.manage"), async (req, res) => {
  try {
    const clientId = Number(req.body?.clientId);
    const contactId = Number(req.body?.contactId);
    if (!clientId) return res.status(400).json({ error: "clientId requis." });
    if (!contactId) return res.status(400).json({ error: "contactId requis." });

    const secret = await createAgentVaultSecret({
      clientId,
      contactId,
      title: req.body?.title,
      description: req.body?.description,
      login: req.body?.login,
      secret: req.body?.secret,
      expiresInDays: req.body?.expiresInDays,
      maxViews: req.body?.maxViews,
      createdBy: req.user,
    });

    res.status(201).json(secret);
  } catch (err) {
    console.error("[POST /vault-secrets]", err.message);
    res.status(400).json({ error: err.message || "Impossible de créer le partage." });
  }
});

router.post("/:id/revoke", requirePermission("vault.manage"), async (req, res) => {
  try {
    const secret = await revokeAgentVaultSecret(req.params.id, req.user);
    res.json(secret);
  } catch (err) {
    console.error("[POST /vault-secrets/:id/revoke]", err.message);
    const status = err.message?.includes("introuvable") ? 404 : 400;
    res.status(status).json({ error: err.message || "Impossible de révoquer l'accès." });
  }
});

export default router;
