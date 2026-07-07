import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT, { verifyToken } from "../../middleware/auth.js";
import {
  buildSessionPayload,
  setSessionCookie,
  signSessionToken,
} from "../../utils/authSession.js";
import {
  generateMfaSecret,
  buildOtpAuthUrl,
  generateQrDataUrl,
  verifyTotp,
} from "../../utils/mfa.js";
import { normalizePortal, getPortalAccessError } from "../../utils/authPortal.js";
import { mfaLoginRateLimit } from "../../middleware/rateLimit.js";

const router = express.Router();

async function getUserMfa(userId) {
  const { rows } = await pool.query(
    `SELECT id, email, username, role, client_id,
            COALESCE(is_active, true) AS is_active,
            mfa_enabled, mfa_secret
     FROM v_b_users WHERE id = $1`,
    [userId]
  );
  return rows[0];
}

// ── Étape 2 connexion : valider le code TOTP ──────────────────────────
router.post("/login", mfaLoginRateLimit, async (req, res) => {
  const { mfaToken, code } = req.body;
  if (!mfaToken || !code) {
    return res.status(400).json({ error: "Token et code requis." });
  }

  try {
    const decoded = verifyToken(mfaToken);
    if (decoded.purpose !== "mfa") {
      return res.status(400).json({ error: "Token invalide." });
    }

    const user = await getUserMfa(decoded.id);
    if (!user?.mfa_enabled || !user.mfa_secret) {
      return res.status(400).json({ error: "MFA non activé pour ce compte." });
    }

    if (!verifyTotp(code, user.mfa_secret)) {
      return res.status(401).json({ error: "Code invalide." });
    }

    const portal = normalizePortal(decoded.portal);
    const portalError = getPortalAccessError(portal, user.role);
    if (portalError) {
      return res.status(403).json({ error: portalError });
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: "Ce compte est désactivé. Contactez votre prestataire." });
    }

    const token = signSessionToken(buildSessionPayload(user));
    setSessionCookie(req, res, token);
    res.json({
      id: user.id,
      email: user.email,
      username: user.username || null,
      role: user.role,
      client_id: user.client_id ?? null,
      mfa_enabled: true,
    });
  } catch {
    res.status(400).json({ error: "Session MFA expirée. Reconnectez-vous." });
  }
});

// ── Générer le secret + QR (utilisateur connecté) ───────────────────
router.post("/setup", verifyJWT, async (req, res) => {
  try {
    const user = await getUserMfa(req.user.id);
    if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });
    if (user.mfa_enabled) {
      return res.status(400).json({ error: "MFA déjà activé." });
    }

    const secret = generateMfaSecret();
    await pool.query("UPDATE v_b_users SET mfa_secret = $1 WHERE id = $2", [secret, user.id]);

    const otpauthUrl = buildOtpAuthUrl(user.email, secret);
    const qrCodeDataUrl = await generateQrDataUrl(otpauthUrl);

    res.json({ secret, otpauthUrl, qrCodeDataUrl });
  } catch (err) {
    console.error("Erreur MFA setup:", err);
    res.status(500).json({ error: "Erreur lors de la configuration MFA." });
  }
});

// ── Confirmer l'activation MFA ────────────────────────────────────────
router.post("/verify", verifyJWT, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Code requis." });

  try {
    const user = await getUserMfa(req.user.id);
    if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });
    if (user.mfa_enabled) {
      return res.status(400).json({ error: "MFA déjà activé." });
    }
    if (!user.mfa_secret) {
      return res.status(400).json({ error: "Configuration MFA non démarrée." });
    }

    if (!verifyTotp(code, user.mfa_secret)) {
      return res.status(400).json({ error: "Code invalide. Réessayez." });
    }

    await pool.query(
      "UPDATE v_b_users SET mfa_enabled = true WHERE id = $1",
      [user.id]
    );

    res.json({ success: true, mfa_enabled: true });
  } catch (err) {
    console.error("Erreur MFA verify:", err);
    res.status(500).json({ error: "Erreur lors de l'activation MFA." });
  }
});

// ── Statut MFA ────────────────────────────────────────────────────────
router.get("/status", verifyJWT, async (req, res) => {
  try {
    const user = await getUserMfa(req.user.id);
    if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });
    res.json({ mfa_enabled: Boolean(user.mfa_enabled) });
  } catch (err) {
    console.error("Erreur MFA status:", err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

export default router;
