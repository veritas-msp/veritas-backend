import { requirePro } from "./edition.js";

const INFRA_ROOT_PATHS = new Set(["/equipment-counts"]);

const INFRA_CLIENT_SUBPATHS = new Set([
  "modules",
  "logs",
  "antivirus",
  "antispam",
  "custom-equipment",
  "custom-equipment-map",
]);

/** Infra subpaths accessible in Community edition (company profile). */
const COMMUNITY_INFRA_CLIENT_SUBPATHS = new Set([
  "ssl-certificates",
  "licences",
]);

/**
 * Blocks API access to infrastructure data (v_b_clients_m_*) in Community edition.
 * Basic company routes (list, identity profile, contacts) remain open.
 */
export function isClientInfraApiPath(pathname) {
  const path = String(pathname || "").split("?")[0];
  if (INFRA_ROOT_PATHS.has(path)) return true;

  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return false;

  const sub = segments[1];
  if (COMMUNITY_INFRA_CLIENT_SUBPATHS.has(sub)) return false;
  if (INFRA_CLIENT_SUBPATHS.has(sub)) return true;

  if (sub === "antispam" && segments.length >= 3) return true;

  return false;
}

export function requireProForClientInfra(req, res, next) {
  if (!isClientInfraApiPath(req.path)) return next();
  return requirePro(req, res, next);
}
