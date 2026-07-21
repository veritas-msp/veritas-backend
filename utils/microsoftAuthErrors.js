/**
 * Parse Microsoft Entra / Azure AD token endpoint errors into stable codes.
 */

function safeJsonParse(text) {
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractAadsts(description) {
  const match = String(description || "").match(/AADSTS(\d+)/i);
  return match ? match[1] : null;
}

function extractTenantHint(description) {
  const match = String(description || "").match(/tenant identifier '([^']+)'/i);
  return match?.[1] || null;
}

/**
 * @param {number} status
 * @param {string} bodyText
 * @returns {Error & { code: string, aadsts?: string|null, tenantHint?: string|null, httpStatus?: number, microsoftError?: string|null }}
 */
export function createMicrosoftAuthError(status, bodyText) {
  const parsed = safeJsonParse(bodyText);
  const description = parsed?.error_description || "";
  const microsoftError = parsed?.error || null;
  const aadsts = extractAadsts(description) || extractAadsts(bodyText);
  const tenantHint = extractTenantHint(description) || extractTenantHint(bodyText);

  let code = "MS_AUTH_FAILED";
  if (
    aadsts === "900023" ||
    aadsts === "90002" ||
    /neither a valid DNS name/i.test(description) ||
    /Tenant .+ not found/i.test(description)
  ) {
    code = "MS_AUTH_INVALID_TENANT";
  } else if (
    aadsts === "7000215" ||
    aadsts === "7000218" ||
    /Invalid client secret/i.test(description) ||
    /client secret is incorrect/i.test(description)
  ) {
    code = "MS_AUTH_INVALID_SECRET";
  } else if (
    aadsts === "700016" ||
    microsoftError === "unauthorized_client" ||
    /Application with identifier .+ was not found/i.test(description)
  ) {
    code = "MS_AUTH_INVALID_CLIENT";
  } else if (microsoftError === "invalid_client") {
    code = "MS_AUTH_INVALID_CLIENT";
  } else if (microsoftError === "invalid_request" && /tenant/i.test(description)) {
    code = "MS_AUTH_INVALID_TENANT";
  } else if (status === 401) {
    code = "MS_AUTH_UNAUTHORIZED";
  }

  const err = new Error(`Microsoft authentication failed (${code})`);
  err.code = code;
  err.aadsts = aadsts;
  err.tenantHint = tenantHint;
  err.httpStatus = status;
  err.microsoftError = microsoftError;
  return err;
}

export function isMicrosoftAuthError(error) {
  return Boolean(error && typeof error.code === "string" && error.code.startsWith("MS_AUTH_"));
}
