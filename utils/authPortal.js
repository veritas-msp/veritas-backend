export function normalizePortal(portal) {
  return portal === "client" ? "client" : "agent";
}
export function getPortalAccessError(portal, role) {
  const r = String(role || "").toLowerCase();
  if (portal === "client" && r !== "client") {
    return "This account is not authorized for the client portal. Use the MSP Agent sign-in.";
  }
  if (portal === "agent" && r === "client") {
    return "Use the client portal to sign in.";
  }
  return null;
}
