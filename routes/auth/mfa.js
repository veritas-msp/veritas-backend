import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT, { verifyToken } from "../../middleware/auth.js";
import { buildSessionPayload, setSessionCookie, signSessionToken } from "../../utils/authSession.js";
import { generateMfaSecret, buildOtpAuthUrl, generateQrDataUrl, verifyTotp } from "../../utils/mfa.js";
import { normalizePortal, getPortalAccessError } from "../../utils/authPortal.js";
import { mfaLoginRateLimit } from "../../middleware/rateLimit.js";
const router = express.Router();
async function getUserMfa(userId) {
  const {
    rows
  } = await pool.query(`SELECT id, email, username, role, profile, client_id,
            COALESCE(is_active, true) AS is_active,
            mfa_enabled, mfa_secret
     FROM v_b_users WHERE id = $1`, [userId]);
  return rows[0];
}
router.post("/login", mfaLoginRateLimit, async (req, res) => {
  const {
    mfaToken,
    code
  } = req.body;
  if (!mfaToken || !code) {
    return res.status(400).json({
      error: "Token et code required."
    });
  }
  try {
    const decoded = verifyToken(mfaToken);
    if (decoded.purpose !== "mfa") {
      return res.status(400).json({
        error: "Invalid Token."
      });
    }
    const user = await getUserMfa(decoded.id);
    if (!user?.mfa_enabled || !user.mfa_secret) {
      return res.status(400).json({
        error: "MFA not enabled for this account."
      });
    }
    if (!verifyTotp(code, user.mfa_secret)) {
      return res.status(401).json({
        error: "Invalid Code."
      });
    }
    const portal = normalizePortal(decoded.portal);
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
    const token = signSessionToken(buildSessionPayload(user));
    setSessionCookie(req, res, token);
    res.json({
      id: user.id,
      email: user.email,
      username: user.username || null,
      role: user.role,
      profile: user.profile ?? null,
      client_id: user.client_id ?? null,
      mfa_enabled: true
    });
  } catch {
    res.status(400).json({
      error: "MFA session expired. Sign in again."
    });
  }
});
router.post("/setup", verifyJWT, async (req, res) => {
  try {
    const user = await getUserMfa(req.user.id);
    if (!user) return res.status(404).json({
      error: "User not found."
    });
    if (user.mfa_enabled) {
      return res.status(400).json({
        error: "MFA already enabled."
      });
    }
    const secret = generateMfaSecret();
    await pool.query("UPDATE v_b_users SET mfa_secret = $1 WHERE id = $2", [secret, user.id]);
    const otpauthUrl = buildOtpAuthUrl(user.email, secret);
    const qrCodeDataUrl = await generateQrDataUrl(otpauthUrl);
    res.json({
      secret,
      otpauthUrl,
      qrCodeDataUrl
    });
  } catch (err) {
    console.error("MFA setup error:", err);
    res.status(500).json({
      error: "Error configuring MFA"
    });
  }
});
router.post("/verify", verifyJWT, async (req, res) => {
  const {
    code
  } = req.body;
  if (!code) return res.status(400).json({
    error: "Code required."
  });
  try {
    const user = await getUserMfa(req.user.id);
    if (!user) return res.status(404).json({
      error: "User not found."
    });
    if (user.mfa_enabled) {
      return res.status(400).json({
        error: "MFA already enabled."
      });
    }
    if (!user.mfa_secret) {
      return res.status(400).json({
        error: "MFA configuration not started."
      });
    }
    if (!verifyTotp(code, user.mfa_secret)) {
      return res.status(400).json({
        error: "Invalid code. Try again."
      });
    }
    await pool.query("UPDATE v_b_users SET mfa_enabled = true WHERE id = $1", [user.id]);
    res.json({
      success: true,
      mfa_enabled: true
    });
  } catch (err) {
    console.error("MFA verify error:", err);
    res.status(500).json({
      error: "Error enabling MFA"
    });
  }
});
router.get("/status", verifyJWT, async (req, res) => {
  try {
    const user = await getUserMfa(req.user.id);
    if (!user) return res.status(404).json({
      error: "User not found."
    });
    res.json({
      mfa_enabled: Boolean(user.mfa_enabled)
    });
  } catch (err) {
    console.error("MFA status error:", err);
    res.status(500).json({
      error: "Server error."
    });
  }
});
export default router;
