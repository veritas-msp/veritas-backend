/** Expiration date utilities — mirror of frontend firewallLicenceUtils. */

export const EXPIRATION_SOON_DAYS = 30;

export function toDateInputValue(value) {
  if (!value) return "";
  const str = String(value).trim();
  if (!str) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  const frMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (frMatch) {
    const [, day, month, year] = frMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return "";
}

export function getExpirationStatus(value, soonDays = EXPIRATION_SOON_DAYS) {
  const iso = toDateInputValue(value);
  if (!iso) return "unknown";

  const expirationDate = new Date(iso);
  if (Number.isNaN(expirationDate.getTime())) return "unknown";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expirationDate.setHours(0, 0, 0, 0);

  const daysUntil = Math.ceil(
    (expirationDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  );

  const soonThreshold = Number.isFinite(Number(soonDays)) && Number(soonDays) > 0
    ? Number(soonDays)
    : EXPIRATION_SOON_DAYS;

  if (daysUntil < 0) return "expired";
  if (daysUntil <= soonThreshold) return "soon";
  return "ok";
}

function isMaintenanceLicence(licence) {
  const nom = String(licence?.nom || "").toLowerCase();
  const type = String(licence?.type || "").toLowerCase();
  return nom.includes("maintenance") || type.includes("maintenance");
}

export function getMaintenanceLicenceExpiration(licences) {
  if (!Array.isArray(licences)) return "";
  const maintenanceLicence = licences.find(isMaintenanceLicence);
  return toDateInputValue(maintenanceLicence?.expiration || "");
}

export function formatDateFr(value) {
  const iso = toDateInputValue(value);
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}
