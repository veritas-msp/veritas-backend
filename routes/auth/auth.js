import express from "express";
import bcrypt from "bcrypt";
import { pool } from "../../database/db.js";
import { sendMail } from "../../utils/sendMail.js";
import { forgotPasswordEmailContent } from "../../utils/authEmailTemplates.js";
import { getPrimaryFrontendBaseUrl } from "../../utils/envFile.js";
import verifyJWT, { verifyToken } from "../../middleware/auth.js";
import mfaRoutes from "./mfa.js";
import { validateStrongPassword } from "../../utils/passwordPolicy.js";
import { normalizePortal, getPortalAccessError } from "../../utils/authPortal.js";
import { attachUserAvatar, USER_AVATAR_SETTING_KEY } from "../../utils/userAvatar.js";
import { loginRateLimit, forgotPasswordRateLimit, resetPasswordRateLimit } from "../../middleware/rateLimit.js";
import {
  buildSessionPayload,
  clearImpersonatorCookie,
  clearSessionCookie,
  isImpersonationPayload,
  buildImpersonationClientPayload,
  setSessionCookie,
  signSessionToken,
} from "../../utils/authSession.js";

const router = express.Router();

router.use("/mfa", mfaRoutes);

async function getUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, username, password_hash AS password, role, client_id,
            COALESCE(is_active, true) AS is_active,
            COALESCE(mfa_enabled, false) AS mfa_enabled, mfa_secret
     FROM v_b_users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
    [email]
  );
  return rows[0];
}

// ── Connexion ─────────────────────────────────────────────────────────
router.post("/login", loginRateLimit, async (req, res) => {
  const { email, password } = req.body;
  const portal = normalizePortal(req.body.portal);
  if (!email || !password) {
    return res.status(400).json({ error: "Email et mot de passe requis." });
  }

  try {
    const user = await getUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Identifiants invalides." });
    }

    const portalError = getPortalAccessError(portal, user.role);
    if (portalError) {
      return res.status(403).json({ error: portalError });
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: "Ce compte est désactivé. Contactez votre prestataire." });
    }

    if (user.mfa_enabled && user.mfa_secret) {
      const mfaToken = signSessionToken(
        {
          id: user.id,
          email: user.email,
          role: user.role,
          client_id: user.client_id ?? null,
          portal,
          purpose: "mfa",
        },
        "5m"
      );
      return res.json({ mfaRequired: true, mfaToken });
    }

    const token = signSessionToken(buildSessionPayload(user));
    setSessionCookie(req, res, token);
    res.json({
      id: user.id,
      email: user.email,
      username: user.username || null,
      role: user.role,
      client_id: user.client_id ?? null,
      mfa_enabled: false,
    });
  } catch (err) {
    console.error("Erreur login:", err);
    res.status(500).json({ error: "Erreur serveur lors de la connexion." });
  }
});

// ── Déconnexion ───────────────────────────────────────────────────────
router.post("/logout", (req, res) => {
  clearSessionCookie(req, res);
  clearImpersonatorCookie(req, res);
  res.json({ message: "Déconnecté." });
});

// ── Mot de passe oublié ───────────────────────────────────────────────
router.post("/forgot-password", forgotPasswordRateLimit, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Email requis." });
  }

  try {
    const user = await getUserByEmail(email);
    // Réponse identique qu'un compte existe ou non (anti-énumération)
    if (!user) {
      return res.json({ success: true });
    }

    const token = signSessionToken({ id: user.id, email: user.email, purpose: "password_reset" }, "15m");
    const resetLink = `${getPrimaryFrontendBaseUrl()}/reset-password?token=${token}`;

    await sendMail({
      to: email,
      subject: "Réinitialisation de votre mot de passe Veritas",
      title: "Mot de passe oublié",
      htmlContent: forgotPasswordEmailContent({ resetLink }),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Erreur forgot-password:", err);
    res.status(500).json({ error: "Erreur lors de l'envoi du mail." });
  }
});

// ── Réinitialisation du mot de passe ─────────────────────────────────
router.post("/reset-password", resetPasswordRateLimit, async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: "Token et nouveau mot de passe requis." });
  }

  try {
    const decoded = verifyToken(token);
    if (decoded.purpose !== "password_reset") {
      return res.status(400).json({ error: "Token invalide ou expiré." });
    }

    const { valid } = validateStrongPassword(newPassword);
    if (!valid) {
      return res.status(400).json({
        error:
          "Mot de passe trop faible : 12 caractères minimum, avec majuscule, minuscule, chiffre et caractère spécial.",
      });
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.query(
      "UPDATE v_b_users SET password_hash = $1 WHERE id = $2",
      [hashed, decoded.id]
    );

    await sendMail({
      to: decoded.email,
      subject: "Votre mot de passe a été modifié",
      title: "Mot de passe modifié",
      htmlContent: `
        <p>Bonjour,</p>
        <p>Votre mot de passe a bien été mis à jour.</p>
        <p>Si vous n'êtes pas à l'origine de cette modification, contactez immédiatement votre administrateur.</p>
      `,
    });

    res.json({ success: true });
  } catch {
    res.status(400).json({ error: "Token invalide ou expiré." });
  }
});

// ── Renouvellement silencieux (activité utilisateur) ─────────────────
router.post("/refresh", verifyJWT, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, role, client_id, COALESCE(is_active, true) AS is_active
       FROM v_b_users WHERE id = $1`,
      [req.user.id]
    );
    const user = rows[0];
    if (!user || user.is_active === false) {
      clearSessionCookie(req, res);
      clearImpersonatorCookie(req, res);
      return res.status(401).json({ error: "Session invalide." });
    }

    let token;
    if (isImpersonationPayload(req.user) && req.cookies?.impersonator_token) {
      token = signSessionToken(
        buildImpersonationClientPayload(user, {
          id: req.user.impersonated_by,
          email: req.user.impersonated_by_email,
        })
      );
    } else {
      token = signSessionToken(buildSessionPayload(user));
    }

    setSessionCookie(req, res, token);
    return res.status(204).send();
  } catch (err) {
    console.error("Erreur /refresh:", err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
});

// ── Fin d'impersonation portail client ────────────────────────────────
router.post("/impersonate/stop", verifyJWT, async (req, res) => {
  const restoreToken = req.cookies?.impersonator_token;
  if (!restoreToken || !isImpersonationPayload(req.user)) {
    return res.status(400).json({ error: "Aucune impersonation active." });
  }

  try {
    const decoded = verifyToken(restoreToken);
    if (String(decoded.role || "").toLowerCase() === "client") {
      clearSessionCookie(req, res);
      clearImpersonatorCookie(req, res);
      return res.status(400).json({ error: "Session agent invalide." });
    }

    const { rows } = await pool.query(
      `SELECT id, email, username, role, client_id, COALESCE(is_active, true) AS is_active
       FROM v_b_users WHERE id = $1`,
      [decoded.id]
    );
    const agent = rows[0];
    if (!agent || agent.is_active === false) {
      clearSessionCookie(req, res);
      clearImpersonatorCookie(req, res);
      return res.status(401).json({ error: "Session agent expirée. Reconnectez-vous." });
    }

    const token = signSessionToken(buildSessionPayload(agent));
    setSessionCookie(req, res, token);
    clearImpersonatorCookie(req, res);

    res.json({
      id: agent.id,
      email: agent.email,
      username: agent.username || null,
      role: agent.role,
      client_id: agent.client_id ?? null,
    });
  } catch {
    clearSessionCookie(req, res);
    clearImpersonatorCookie(req, res);
    return res.status(401).json({ error: "Session expirée. Reconnectez-vous." });
  }
});

// ── Session courante ──────────────────────────────────────────────────
router.get("/me", verifyJWT, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.username, u.role, u.profile, u.client_id,
              COALESCE(u.mfa_enabled, false) AS mfa_enabled,
              av.setting_value AS avatar_setting_raw
       FROM v_b_users u
       LEFT JOIN v_b_users_settings av
         ON av.user_id = u.id AND av.setting_key = $2
       WHERE u.id = $1`,
      [req.user.id, USER_AVATAR_SETTING_KEY]
    );
    if (!rows[0]) return res.status(404).json({ error: "Utilisateur non trouvé." });
    res.json({
      ...attachUserAvatar(rows[0]),
      impersonating: isImpersonationPayload(req.user),
      impersonated_by: req.user.impersonated_by ?? null,
      impersonated_by_email: req.user.impersonated_by_email ?? null,
    });
  } catch (err) {
    console.error("Erreur /me:", err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

export default router;
