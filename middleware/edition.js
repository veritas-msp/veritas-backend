import verifyJWT from "./auth.js";
import { isCommunity } from "../utils/edition.js";
import { ensureFreshLicense } from "../utils/proLicense.js";

export async function requirePro(req, res, next) {
  try {
    await ensureFreshLicense();
    if (isCommunity()) {
      return res.status(403).json({
        error: "Fonctionnalité réservée à Veritas Pro",
        code: "PRO_FEATURE_REQUIRED",
      });
    }
    return next();
  } catch (error) {
    console.error("[edition] requirePro:", error.message);
    return res.status(503).json({
      error: "Validation licence indisponible",
      code: "LICENSE_CHECK_FAILED",
    });
  }
}

/** Requires JWT then Pro edition — use on all Pro mounts (except public webhooks). */
export function requireProAuth(req, res, next) {
  verifyJWT(req, res, () => {
    requirePro(req, res, next);
  });
}
