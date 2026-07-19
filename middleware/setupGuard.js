import verifyJWT from "./auth.js";
import { requireRole } from "./roles.js";
import { getSetupStatus } from "../utils/setupState.js";

/** Blocks access to /api/setup/* routes once installation is complete. */
export function requireSetupIncomplete(req, res, next) {
  getSetupStatus()
    .then(({ needsSetup }) => {
      if (!needsSetup) {
        return res.status(403).json({
          error: "Initial setup is already complete.",
          code: "SETUP_ALREADY_COMPLETE",
        });
      }
      return next();
    })
    .catch(() => next());
}

/** Test/setup routes: open during setup wizard, admin-only afterward. */
export function requireSetupOrAdmin(req, res, next) {
  getSetupStatus()
    .then(({ needsSetup }) => {
      if (needsSetup) return next();
      verifyJWT(req, res, () => requireRole("admin")(req, res, next));
    })
    .catch(() => next());
}
