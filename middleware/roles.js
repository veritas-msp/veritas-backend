// ─────────────────────────────────────────────
// 🛡️ Role-based access middleware
// ─────────────────────────────────────────────

export function requireRole(allowedRoles) {
  // Allows: a single string OR an array of roles
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    const user = req.user;

    if (!user || !user.role) {
      return res.status(403).json({ error: "Accès interdit. Aucun rôle détecté." });
    }

    if (!roles.includes(user.role)) {
      return res.status(403).json({ error: "Accès refusé. Rôle insuffisant." });
    }

    next();
  };
}

