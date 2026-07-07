// ─────────────────────────────────────────────
// 🛡️ Middleware de contrôle par rôle
// ─────────────────────────────────────────────

export function requireRole(allowedRoles) {
  // Autorise : string unique OU tableau de rôles
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

