import express from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { pool } from "../../database/db.js";
import { sendMail } from "../../utils/sendMail.js";
import { forgotPasswordEmailContent } from "../../utils/authEmailTemplates.js";
import { getPrimaryFrontendBaseUrl } from "../../utils/envFile.js";
import verifyJWT, { verifyToken } from "../../middleware/auth.js";
import mfaRoutes from "./mfa.js";
import { validateStrongPassword, validatePortalPassword, PORTAL_PASSWORD_MIN_LENGTH } from "../../utils/passwordPolicy.js";
import { normalizePortal, getPortalAccessError } from "../../utils/authPortal.js";
import { attachUserAvatar, USER_AVATAR_SETTING_KEY } from "../../utils/userAvatar.js";
import { loginRateLimit, forgotPasswordRateLimit, resetPasswordRateLimit } from "../../middleware/rateLimit.js";
import { buildSessionPayload, clearImpersonatorCookie, clearSessionCookie, isImpersonationPayload, buildImpersonationClientPayload, setSessionCookie, signSessionToken } from "../../utils/authSession.js";
const router = express.Router();
const PORTAL_PASSWORD_ERROR = `Password too weak: at least ${PORTAL_PASSWORD_MIN_LENGTH} characters, with at least one letter and one digit.`;
router.use("/mfa", mfaRoutes);
function passwordFingerprint(passwordHash) {
  return crypto.createHash("sha256").update(String(passwordHash || "")).digest("hex").slice(0, 16);
}
async function getUserByEmail(email) {
  const {
    rows
  } = await pool.query(`SELECT id, email, username, password_hash AS password, role, profile, client_id,
            COALESCE(is_active, true) AS is_active,
            COALESCE(mfa_enabled, false) AS mfa_enabled, mfa_secret,
            COALESCE(password_pending, false) AS password_pending
     FROM v_b_users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`, [email]);
  return rows[0];
}
router.post("/login", loginRateLimit, async (req, res) => {
  const {
    email,
    password
  } = req.body;
  const portal = normalizePortal(req.body.portal);
  if (!email || !password) {
    return res.status(400).json({
      error: "Email and password required."
    });
  }
  try {
    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({
        error: "Invalid credentials."
      });
    }
    if (user.password_pending && String(user.role).toLowerCase() === "client") {
      return res.status(403).json({
        error: "Account not activated. Use the link received by email to set your password.",
        passwordPending: true
      });
    }
    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({
        error: "Invalid credentials."
      });
    }
    const portalError = getPortalAccessError(portal, user.role);
    if (portalError) {
      return res.status(403).json({
        error: portalError
      });
    }
    if (user.is_active === false) {
      return res.status(403).json({
        error: "This account is disabled. Contact your provider."
      });
    }
    let effectiveRole = user.role;
    const roleMissing = effectiveRole == null || String(effectiveRole).trim() === "";
    if (roleMissing) {
      try {
        await pool.query(`UPDATE v_b_users SET role = 'utilisateur'
           WHERE id = $1 AND (role IS NULL OR TRIM(COALESCE(role, '')) = '')`, [user.id]);
      } catch (healErr) {
        console.warn("[auth] Heal role failed:", healErr.message);
      }
      effectiveRole = "utilisateur";
      user.role = effectiveRole;
    }
    if (user.mfa_enabled && user.mfa_secret) {
      const mfaToken = signSessionToken({
        id: user.id,
        email: user.email,
        role: user.role,
        profile: user.profile ?? null,
        client_id: user.client_id ?? null,
        portal,
        purpose: "mfa"
      }, "5m");
      return res.json({
        mfaRequired: true,
        mfaToken
      });
    }
    const token = signSessionToken(buildSessionPayload(user));
    setSessionCookie(req, res, token);
    res.json({
      id: user.id,
      email: user.email,
      username: user.username || null,
      role: user.role,
      profile: user.profile ?? null,
      client_id: user.client_id ?? null,
      mfa_enabled: false
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      error: "Server error during login."
    });
  }
});
router.post("/logout", (req, res) => {
  clearSessionCookie(req, res);
  clearImpersonatorCookie(req, res);
  res.json({
    message: "Logged out."
  });
});
router.post("/forgot-password", forgotPasswordRateLimit, async (req, res) => {
  const {
    email
  } = req.body;
  if (!email) {
    return res.status(400).json({
      error: "Email required."
    });
  }
  try {
    const user = await getUserByEmail(email);
    if (!user) {
      return res.json({
        success: true
      });
    }
    const token = signSessionToken({
      id: user.id,
      email: user.email,
      purpose: "password_reset",
      fp: passwordFingerprint(user.password)
    }, "15m");
    const resetLink = `${getPrimaryFrontendBaseUrl()}/reset-password#token=${token}`;
    const mailResult = await sendMail({
      to: email,
      subject: "Reset your Veritas password",
      title: "Forgot password",
      htmlContent: forgotPasswordEmailContent({
        resetLink
      })
    });
    const payload = {
      success: true
    };
    if (mailResult?.skipped && process.env.NODE_ENV !== "production") {
      payload.devResetLink = resetLink;
      payload.mailSkipped = true;
    }
    res.json(payload);
  } catch (err) {
    console.error("Forgot-password error:", err);
    res.status(500).json({
      error: "Error sending email"
    });
  }
});
router.post("/reset-password", resetPasswordRateLimit, async (req, res) => {
  const {
    token,
    newPassword
  } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({
      error: "Token and new password required."
    });
  }
  try {
    const decoded = verifyToken(token);
    if (decoded.purpose !== "password_reset") {
      return res.status(400).json({
        error: "Invalid or expired token."
      });
    }
    const {
      rows: current
    } = await pool.query("SELECT password_hash, role FROM v_b_users WHERE id = $1", [decoded.id]);
    if (!current[0]) {
      return res.status(400).json({
        error: "Invalid or expired token."
      });
    }
    const isClient = String(current[0].role || "").toLowerCase() === "client";
    const {
      valid
    } = isClient ? validatePortalPassword(newPassword) : validateStrongPassword(newPassword);
    if (!valid) {
      return res.status(400).json({
        error: isClient ? PORTAL_PASSWORD_ERROR : "Password too weak: at least 12 characters, with uppercase, lowercase, digit and special character."
      });
    }
    if (!decoded.fp || decoded.fp !== passwordFingerprint(current[0].password_hash)) {
      return res.status(400).json({
        error: "This link has already been used or is no longer valid."
      });
    }
    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE v_b_users SET password_hash = $1, password_pending = false WHERE id = $2", [hashed, decoded.id]);
    await sendMail({
      to: decoded.email,
      subject: "Your password has been changed",
      title: "Password changed",
      htmlContent: `
        <p>Hello,</p>
        <p>Your password has been updated successfully.</p>
        <p>If you did not make this change, contact your administrator immediately.</p>
      `
    });
    res.json({
      success: true
    });
  } catch {
    res.status(400).json({
      error: "Invalid or expired token."
    });
  }
});
router.post("/activate-portal", resetPasswordRateLimit, async (req, res) => {
  const {
    token,
    newPassword
  } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({
      error: "Token and password required."
    });
  }
  try {
    const decoded = verifyToken(token);
    if (decoded.purpose !== "portal_invite") {
      return res.status(400).json({
        error: "Invalid or expired link."
      });
    }
    const {
      valid
    } = validatePortalPassword(newPassword);
    if (!valid) {
      return res.status(400).json({
        error: PORTAL_PASSWORD_ERROR
      });
    }
    const {
      rows: current
    } = await pool.query(`SELECT id, email, username, role, profile, client_id, password_hash,
              COALESCE(is_active, true) AS is_active,
              COALESCE(password_pending, false) AS password_pending
       FROM v_b_users WHERE id = $1`, [decoded.id]);
    const user = current[0];
    if (!user || String(user.role).toLowerCase() !== "client") {
      return res.status(400).json({
        error: "Invalid or expired link."
      });
    }
    if (!user.password_pending) {
      return res.status(400).json({
        error: "This account is already activated. Sign in normally."
      });
    }
    if (!decoded.fp || decoded.fp !== passwordFingerprint(user.password_hash)) {
      return res.status(400).json({
        error: "This link has already been used or is no longer valid."
      });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE v_b_users SET password_hash = $1, password_pending = false WHERE id = $2", [hashed, user.id]);
    const sessionUser = {
      ...user,
      password: hashed,
      password_pending: false
    };
    const sessionToken = signSessionToken(buildSessionPayload(sessionUser));
    setSessionCookie(req, res, sessionToken);
    res.json({
      success: true,
      id: user.id,
      email: user.email,
      username: user.username || null,
      role: user.role,
      client_id: user.client_id ?? null
    });
  } catch {
    res.status(400).json({
      error: "Invalid or expired link."
    });
  }
});
router.post("/refresh", verifyJWT, async (req, res) => {
  try {
    const {
      rows
    } = await pool.query(`SELECT id, email, role, profile, client_id, COALESCE(is_active, true) AS is_active
       FROM v_b_users WHERE id = $1`, [req.user.id]);
    const user = rows[0];
    if (!user || user.is_active === false) {
      clearSessionCookie(req, res);
      clearImpersonatorCookie(req, res);
      return res.status(401).json({
        error: "Invalid Session."
      });
    }
    let token;
    if (isImpersonationPayload(req.user) && req.cookies?.impersonator_token) {
      token = signSessionToken(buildImpersonationClientPayload(user, {
        id: req.user.impersonated_by,
        email: req.user.impersonated_by_email
      }));
    } else {
      token = signSessionToken(buildSessionPayload(user));
    }
    setSessionCookie(req, res, token);
    return res.status(204).send();
  } catch (err) {
    console.error("/refresh error:", err);
    return res.status(500).json({
      error: "Server error."
    });
  }
});
router.post("/impersonate/stop", verifyJWT, async (req, res) => {
  const restoreToken = req.cookies?.impersonator_token;
  if (!restoreToken || !isImpersonationPayload(req.user)) {
    return res.status(400).json({
      error: "No active impersonation."
    });
  }
  try {
    const decoded = verifyToken(restoreToken);
    if (String(decoded.role || "").toLowerCase() === "client") {
      clearSessionCookie(req, res);
      clearImpersonatorCookie(req, res);
      return res.status(400).json({
        error: "Invalid Session agent."
      });
    }
    const {
      rows
    } = await pool.query(`SELECT id, email, username, role, profile, client_id, COALESCE(is_active, true) AS is_active
       FROM v_b_users WHERE id = $1`, [decoded.id]);
    const agent = rows[0];
    if (!agent || agent.is_active === false) {
      clearSessionCookie(req, res);
      clearImpersonatorCookie(req, res);
      return res.status(401).json({
        error: "Agent session expired. Sign in again."
      });
    }
    const token = signSessionToken(buildSessionPayload(agent));
    setSessionCookie(req, res, token);
    clearImpersonatorCookie(req, res);
    res.json({
      id: agent.id,
      email: agent.email,
      username: agent.username || null,
      role: agent.role,
      client_id: agent.client_id ?? null
    });
  } catch {
    clearSessionCookie(req, res);
    clearImpersonatorCookie(req, res);
    return res.status(401).json({
      error: "Session expired. Sign in again."
    });
  }
});
router.get("/me", verifyJWT, async (req, res) => {
  try {
    const {
      rows
    } = await pool.query(`SELECT u.id, u.email, u.username, u.role, u.profile, u.client_id,
              COALESCE(u.mfa_enabled, false) AS mfa_enabled,
              av.setting_value AS avatar_setting_raw
       FROM v_b_users u
       LEFT JOIN v_b_users_settings av
         ON av.user_id = u.id AND av.setting_key = $2
       WHERE u.id = $1`, [req.user.id, USER_AVATAR_SETTING_KEY]);
    if (!rows[0]) return res.status(404).json({
      error: "User not found."
    });
    res.json({
      ...attachUserAvatar(rows[0]),
      impersonating: isImpersonationPayload(req.user),
      impersonated_by: req.user.impersonated_by ?? null,
      impersonated_by_email: req.user.impersonated_by_email ?? null
    });
  } catch (err) {
    console.error("/me error:", err);
    res.status(500).json({
      error: "Server error."
    });
  }
});
export default router;
