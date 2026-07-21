export function requireRole(allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return (req, res, next) => {
    const user = req.user;
    if (!user || !user.role) {
      return res.status(403).json({
        error: "Access denied. No role detected."
      });
    }
    if (!roles.includes(user.role)) {
      return res.status(403).json({
        error: "Access denied. Insufficient role."
      });
    }
    next();
  };
}
