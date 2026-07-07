import jwt from "jsonwebtoken";

export function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production");
  }
  console.warn("[auth] JWT_SECRET missing — ephemeral development key (do not use in production)");
  return "veritas-dev-insecure-jwt-secret";
}

/**
 * Vérifie un JWT en imposant l'algorithme HMAC-SHA256.
 * Empêche les attaques de confusion d'algorithme (ex. jetons "alg":"none").
 */
export function verifyToken(token) {
  return jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] });
}

export default function verifyJWT(req, res, next) {
  let token = req.cookies?.token;

  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const headerToken = authHeader.substring(7).trim();
      if (headerToken && headerToken !== "null") token = headerToken;
    }
  }

  if (!token) {
    return res.status(401).json({ error: "Non authentifié" });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Session expirée, veuillez vous reconnecter" });
  }
}
