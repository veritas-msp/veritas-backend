import { userHasAllPermissions, userHasAnyPermission } from "../services/permissionService.js";
export function requirePermission(...keys) {
  const required = keys.flat().filter(Boolean);
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Not authenticated"
      });
    }
    try {
      if (await userHasAllPermissions(req.user, required)) return next();
    } catch (err) {
      console.error("[permissions] Check failed:", err.message);
      return res.status(500).json({
        error: "Permission check failed."
      });
    }
    return res.status(403).json({
      error: "You do not have permission to perform this action.",
      code: "PERMISSION_DENIED"
    });
  };
}
export function requireAnyPermission(...keys) {
  const required = keys.flat().filter(Boolean);
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Not authenticated"
      });
    }
    try {
      if (await userHasAnyPermission(req.user, required)) return next();
    } catch (err) {
      console.error("[permissions] Check failed:", err.message);
      return res.status(500).json({
        error: "Permission check failed."
      });
    }
    return res.status(403).json({
      error: "You do not have permission to perform this action.",
      code: "PERMISSION_DENIED"
    });
  };
}
