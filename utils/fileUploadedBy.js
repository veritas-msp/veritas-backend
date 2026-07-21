const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value) {
  if (value == null || value === "") return false;
  return UUID_RE.test(String(value).trim());
}
export function resolveFileUploadedBy(user) {
  const raw = user?.id;
  if (raw == null || raw === "") return null;
  const str = String(raw).trim();
  return isUuid(str) ? str : null;
}
