const buckets = new Map();
const isProduction = process.env.NODE_ENV === "production";
function clientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress;
  if (ip) return ip;
  return "unknown";
}
function createRateLimiter({
  windowMs = 60_000,
  max = 20,
  message,
  name = "default",
  skipInDevelopment = true
} = {}) {
  const limitMessage = message || "Too many requests. Please try again in a few minutes.";
  return (req, res, next) => {
    if (skipInDevelopment && !isProduction) {
      return next();
    }
    const key = `${name}:${clientIp(req)}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = {
        start: now,
        count: 0
      };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((windowMs - (now - bucket.start)) / 1000)));
      return res.status(429).json({
        error: limitMessage,
        code: "RATE_LIMITED"
      });
    }
    return next();
  };
}
export const loginRateLimit = createRateLimiter({
  name: "login",
  windowMs: 15 * 60_000,
  max: 20,
  message: "Too many login attempts. Please try again later."
});
export const forgotPasswordRateLimit = createRateLimiter({
  name: "forgot-password",
  windowMs: 60 * 60_000,
  max: 8,
  message: "Too many password reset requests. Please try again later."
});
export const resetPasswordRateLimit = createRateLimiter({
  name: "reset-password",
  windowMs: 15 * 60_000,
  max: 15,
  message: "Too many password reset attempts. Please try again later."
});
export const mfaLoginRateLimit = createRateLimiter({
  name: "mfa-login",
  windowMs: 15 * 60_000,
  max: 30,
  message: "Too many MFA attempts. Please try again later."
});
export const rmmEnrollRateLimit = createRateLimiter({
  name: "rmm-enroll",
  windowMs: 60 * 60_000,
  max: 40,
  message: "Too many RMM enrollment attempts. Please try again later.",
  skipInDevelopment: false
});
export const setupRateLimit = createRateLimiter({
  name: "setup",
  windowMs: 60_000,
  max: 120,
  message: "Too many requests to the setup wizard."
});
export const setupMigrateRateLimit = createRateLimiter({
  name: "setup-migrate",
  windowMs: 60_000,
  max: 200,
  message: "Too many migration requests. Wait one minute, then try again.",
  skipInDevelopment: false
});
export function resetRateLimitBuckets() {
  buckets.clear();
}
