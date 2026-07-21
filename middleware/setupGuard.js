import verifyJWT from "./auth.js";
import { requireRole } from "./roles.js";
import { getSetupStatus } from "../utils/setupState.js";
export function requireSetupIncomplete(req, res, next) {
  getSetupStatus().then(({
    needsSetup
  }) => {
    if (!needsSetup) {
      return res.status(403).json({
        error: "Initial setup is already complete.",
        code: "SETUP_ALREADY_COMPLETE"
      });
    }
    return next();
  }).catch(() => next());
}
export function requireSetupOrAdmin(req, res, next) {
  getSetupStatus().then(({
    needsSetup
  }) => {
    if (needsSetup) return next();
    verifyJWT(req, res, () => requireRole("admin")(req, res, next));
  }).catch(() => next());
}
