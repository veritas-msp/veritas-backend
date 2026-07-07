import verifyJWT from "./auth.js";
import { requireRole } from "./roles.js";
import { getSetupStatus } from "../utils/setupState.js";

/** Bloque l'accès aux routes /api/setup/* une fois l'installation terminée. */
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

/** Routes de test/setup : ouvertes pendant l'assistant d'installation, admin ensuite. */
export function requireSetupOrAdmin(req, res, next) {
  getSetupStatus()
    .then(({ needsSetup }) => {
      if (needsSetup) return next();
      verifyJWT(req, res, () => requireRole("admin")(req, res, next));
    })
    .catch(() => next());
}
