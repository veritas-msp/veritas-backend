import jwt from "jsonwebtoken";
import { getJwtSecret } from "../middleware/auth.js";

/** Durée de session (JWT + cookie httpOnly), alignée sur 24 h. */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SESSION_JWT_EXPIRES_IN = "1d";

export function cookieOptions(req) {
  const secure =
    req.protocol === "https" ||
    req.headers["x-forwarded-proto"] === "https" ||
    req.secure === true;
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? "strict" : "lax",
    maxAge: SESSION_MAX_AGE_MS,
  };
}

export function signSessionToken(payload, expiresIn = SESSION_JWT_EXPIRES_IN) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn, algorithm: "HS256" });
}

export function buildSessionPayload(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    client_id: user.client_id ?? null,
  };
}

export const IMPERSONATOR_COOKIE = "impersonator_token";

export function isImpersonationPayload(user) {
  return Boolean(user?.impersonated_by || user?.purpose === "client_impersonation");
}

export function buildImpersonationClientPayload(portalUser, impersonator) {
  return {
    id: portalUser.id,
    email: portalUser.email,
    role: "client",
    client_id: portalUser.client_id ?? null,
    impersonated_by: impersonator.id,
    impersonated_by_email: impersonator.email ?? null,
    purpose: "client_impersonation",
  };
}

export function setImpersonatorCookie(req, res, token) {
  res.cookie(IMPERSONATOR_COOKIE, token, cookieOptions(req));
}

export function clearImpersonatorCookie(req, res) {
  const opts = cookieOptions(req);
  res.clearCookie(IMPERSONATOR_COOKIE, {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
  });
}

export function setSessionCookie(req, res, token) {
  res.cookie("token", token, cookieOptions(req));
}

export function clearSessionCookie(req, res) {
  const opts = cookieOptions(req);
  res.clearCookie("token", {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
  });
}
