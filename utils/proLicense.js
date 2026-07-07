import fetch from "node-fetch";
import {
  VERITAS_BILLING_API_URL,
  VERITAS_BILLING_LICENSE_SECRET,
} from "../constants/billing.js";

const LICENSE_KEY_RE = /^VRT-PRO-(?:[A-F0-9]{4}-){3}[A-F0-9]{4}$/;

const DEFAULT_CACHE_MS = 5000;

/** @type {{ valid: boolean, status: string|null, agentCount: number|null, billingInterval: string|null, checkedAt: string|null, checkedAtMs: number, lastError: string|null, billingConfigured: boolean, customerEmail: string|null, licenseRevision: string|null }} */
let cache = {
  valid: false,
  status: null,
  agentCount: null,
  billingInterval: null,
  checkedAt: null,
  checkedAtMs: 0,
  lastError: null,
  billingConfigured: false,
  customerEmail: null,
  licenseRevision: null,
};

let refreshInFlight = null;

export function normalizeLicenseKey(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidLicenseKeyFormat(key) {
  return LICENSE_KEY_RE.test(normalizeLicenseKey(key));
}

export function getLicenseCacheMaxAgeMs() {
  const raw = Number.parseInt(process.env.LICENSE_CACHE_MS || "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_MS;
}

/** Dev local : VERITAS_EDITION=pro sans clé ni billing. */
export function isDevProBypass() {
  return (
    process.env.NODE_ENV !== "production" &&
    String(process.env.VERITAS_EDITION || "").trim().toLowerCase() === "pro" &&
    !normalizeLicenseKey(process.env.VERITAS_LICENSE_KEY || "")
  );
}

export function isLicenseCacheValid() {
  if (isDevProBypass()) return true;
  return cache.valid === true;
}

export function getLicensedMspAgentLimit() {
  if (isDevProBypass()) return null;
  if (!isLicenseCacheValid()) return null;
  if (cache.agentCount == null) return null;
  return cache.agentCount;
}

function getBillingConfig() {
  return {
    billingUrl: VERITAS_BILLING_API_URL,
    secret: VERITAS_BILLING_LICENSE_SECRET,
    configured: true,
  };
}

function formatBillingFetchError(error, billingUrl) {
  const cause = error?.cause?.code || error?.code || "";
  if (cause === "ECONNREFUSED" || cause === "ENOTFOUND") {
    return `Service de validation licence injoignable (${billingUrl}). Vérifiez la connectivité réseau.`;
  }
  if (String(error?.message || "").includes("fetch failed")) {
    return `Impossible de joindre le service de validation licence (${billingUrl}).`;
  }
  return error?.message || "Erreur réseau vers le service de validation licence.";
}

export async function refreshProLicenseState() {
  cache.billingConfigured = getBillingConfig().configured;

  if (isDevProBypass()) {
    cache = {
      ...cache,
      valid: true,
      status: "dev_bypass",
      agentCount: null,
      billingInterval: null,
      checkedAt: new Date().toISOString(),
      checkedAtMs: Date.now(),
      lastError: null,
      customerEmail: null,
      licenseRevision: null,
    };
    return cache;
  }

  const key = normalizeLicenseKey(process.env.VERITAS_LICENSE_KEY || "");
  if (!key) {
    cache = {
      ...cache,
      valid: false,
      status: "missing",
      agentCount: null,
      billingInterval: null,
      checkedAt: new Date().toISOString(),
      checkedAtMs: Date.now(),
      lastError: null,
      customerEmail: null,
      licenseRevision: null,
    };
    return cache;
  }

  const { billingUrl, secret } = getBillingConfig();

  try {
    const res = await fetch(`${billingUrl}/api/license/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Veritas-License-Secret": secret,
      },
      body: JSON.stringify({ licenseKey: key }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      cache = {
        ...cache,
        valid: false,
        status: data.error || data.code || "error",
        agentCount: null,
        billingInterval: null,
        checkedAt: new Date().toISOString(),
        checkedAtMs: Date.now(),
        lastError: data.message || `Erreur billing HTTP ${res.status}`,
        customerEmail: null,
        licenseRevision: data.licenseRevision || data.updatedAt || null,
      };
      return cache;
    }

    cache = {
      ...cache,
      valid: Boolean(data.valid),
      status: data.status || (data.valid ? "active" : "invalid"),
      agentCount: data.agentCount ?? null,
      billingInterval: data.billingInterval ?? null,
      checkedAt: new Date().toISOString(),
      checkedAtMs: Date.now(),
      lastError: data.valid ? null : data.message || "Licence invalide ou abonnement inactif.",
      customerEmail: data.customerEmail ?? null,
      licenseRevision: data.licenseRevision || data.updatedAt || null,
    };
    return cache;
  } catch (error) {
    cache = {
      ...cache,
      valid: false,
      status: "network_error",
      agentCount: null,
      billingInterval: null,
      checkedAt: new Date().toISOString(),
      checkedAtMs: Date.now(),
      lastError: formatBillingFetchError(error, billingUrl),
      customerEmail: null,
      licenseRevision: null,
    };
    return cache;
  }
}

/** Rafraîchit la licence si le cache est périmé (révocation quasi instantanée). */
export async function ensureFreshLicense() {
  if (isDevProBypass()) return cache;

  const maxAge = getLicenseCacheMaxAgeMs();
  if (maxAge === 0 || Date.now() - (cache.checkedAtMs || 0) >= maxAge) {
    if (!refreshInFlight) {
      refreshInFlight = refreshProLicenseState().finally(() => {
        refreshInFlight = null;
      });
    }
    await refreshInFlight;
  }
  return cache;
}

export function invalidateLicenseCache() {
  cache.checkedAtMs = 0;
}

export function getLicenseKeyHint() {
  const key = normalizeLicenseKey(process.env.VERITAS_LICENSE_KEY || "");
  if (!key) return null;
  const parts = key.split("-");
  const tail = parts.slice(-2).join("-");
  return `••••-${tail}`;
}

function buildLicenseDetail({ includePrivate = false } = {}) {
  const detail = {
    valid: cache.valid || isDevProBypass(),
    status: isDevProBypass() ? "dev_bypass" : cache.status,
    agentCount: cache.agentCount,
    billingInterval: cache.billingInterval,
    checkedAt: cache.checkedAt,
    lastError: cache.lastError,
    billingConfigured: cache.billingConfigured,
    devBypass: isDevProBypass(),
  };
  if (includePrivate) {
    detail.customerEmail = cache.customerEmail;
  }
  return detail;
}

/** Résumé licence sans PII — exposé via GET /api/edition (public). */
export function getLicensePublicSummary() {
  return {
    edition: isLicenseCacheValid() ? "pro" : "community",
    hasLicenseKey: Boolean(normalizeLicenseKey(process.env.VERITAS_LICENSE_KEY || "")),
    keyHint: getLicenseKeyHint(),
    license: buildLicenseDetail({ includePrivate: false }),
  };
}

/** Résumé complet pour admins (GET /api/license). */
export function getLicenseAdminSummary() {
  return {
    edition: isLicenseCacheValid() ? "pro" : "community",
    hasLicenseKey: Boolean(normalizeLicenseKey(process.env.VERITAS_LICENSE_KEY || "")),
    keyHint: getLicenseKeyHint(),
    license: buildLicenseDetail({ includePrivate: true }),
  };
}
