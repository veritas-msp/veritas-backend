/** Rate limiting en mémoire (par IP) — suffisant pour une instance self-hosted. */

const buckets = new Map();

const isProduction = process.env.NODE_ENV === "production";

function clientIp(req) {
  // Express résout req.ip via trust proxy (server.js) — ne pas parser X-Forwarded-For manuellement.
  const ip = req.ip || req.socket?.remoteAddress;
  if (ip) return ip;
  return "unknown";
}

function createRateLimiter({
  windowMs = 60_000,
  max = 20,
  message,
  name = "default",
  skipInDevelopment = true,
} = {}) {
  const limitMessage =
    message || "Trop de requêtes. Réessayez dans quelques minutes.";

  return (req, res, next) => {
    if (skipInDevelopment && !isProduction) {
      return next();
    }

    const key = `${name}:${clientIp(req)}`;
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((windowMs - (now - bucket.start)) / 1000)));
      return res.status(429).json({ error: limitMessage, code: "RATE_LIMITED" });
    }

    return next();
  };
}

export const loginRateLimit = createRateLimiter({
  name: "login",
  windowMs: 15 * 60_000,
  max: 20,
  message: "Trop de tentatives de connexion. Réessayez plus tard.",
});

export const forgotPasswordRateLimit = createRateLimiter({
  name: "forgot-password",
  windowMs: 60 * 60_000,
  max: 8,
  message: "Trop de demandes de réinitialisation. Réessayez plus tard.",
});

export const resetPasswordRateLimit = createRateLimiter({
  name: "reset-password",
  windowMs: 15 * 60_000,
  max: 15,
  message: "Trop de tentatives de réinitialisation. Réessayez plus tard.",
});

export const mfaLoginRateLimit = createRateLimiter({
  name: "mfa-login",
  windowMs: 15 * 60_000,
  max: 30,
  message: "Trop de tentatives MFA. Réessayez plus tard.",
});

export const rmmEnrollRateLimit = createRateLimiter({
  name: "rmm-enroll",
  windowMs: 60 * 60_000,
  max: 40,
  message: "Trop de tentatives d'enrôlement RMM. Réessayez plus tard.",
  skipInDevelopment: false,
});

/** Routes wizard hors migrations (status, env, database, admin). */
export const setupRateLimit = createRateLimiter({
  name: "setup",
  windowMs: 60_000,
  max: 120,
  message: "Trop de requêtes sur l'assistant d'installation.",
});

/** Migrations pas à pas : jusqu'à ~80 tables + seeds en une minute. */
export const setupMigrateRateLimit = createRateLimiter({
  name: "setup-migrate",
  windowMs: 60_000,
  max: 200,
  message: "Trop de requêtes de migration. Patientez une minute puis relancez.",
  skipInDevelopment: false,
});

/** Réinitialise les compteurs (tests / dépannage). */
export function resetRateLimitBuckets() {
  buckets.clear();
}
