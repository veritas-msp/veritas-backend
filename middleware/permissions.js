import { userHasAllPermissions, userHasAnyPermission } from "../services/permissionService.js";

/**
 * Require the user to have ALL listed permissions.
 * Admins bypass automatically. Place after verifyJWT.
 *
 * @example router.delete("/:id", verifyJWT, requirePermission("clients.delete"), handler)
 */
export function requirePermission(...keys) {
  const required = keys.flat().filter(Boolean);
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Non authentifié" });
    }
    try {
      if (await userHasAllPermissions(req.user, required)) return next();
    } catch (err) {
      console.error("[permissions] Check failed:", err.message);
      return res.status(500).json({ error: "Erreur de vérification des droits." });
    }
    return res.status(403).json({
      error: "Vous n'avez pas la permission d'effectuer cette action.",
      code: "PERMISSION_DENIED",
    });
  };
}

/** Require AT LEAST ONE of the listed permissions. */
export function requireAnyPermission(...keys) {
  const required = keys.flat().filter(Boolean);
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Non authentifié" });
    }
    try {
      if (await userHasAnyPermission(req.user, required)) return next();
    } catch (err) {
      console.error("[permissions] Check failed:", err.message);
      return res.status(500).json({ error: "Erreur de vérification des droits." });
    }
    return res.status(403).json({
      error: "Vous n'avez pas la permission d'effectuer cette action.",
      code: "PERMISSION_DENIED",
    });
  };
}
