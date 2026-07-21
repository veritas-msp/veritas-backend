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
export function verifyToken(token) {
  return jwt.verify(token, getJwtSecret(), {
    algorithms: ["HS256"]
  });
}
const NON_SESSION_PURPOSES = new Set(["mfa", "password_reset"]);
export function isSessionPurpose(purpose) {
  if (!purpose) return true;
  return purpose === "client_impersonation";
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
    return res.status(401).json({
      error: "Not authenticated"
    });
  }
  try {
    const decoded = verifyToken(token);
    if (NON_SESSION_PURPOSES.has(decoded?.purpose) || !isSessionPurpose(decoded?.purpose)) {
      return res.status(401).json({
        error: "Token not authorized for this resource"
      });
    }
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      error: "Session expired, please sign in again"
    });
  }
}
