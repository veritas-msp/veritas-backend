export function normalizePortal(portal) {
  return portal === "client" ? "client" : "agent";
}

export function getPortalAccessError(portal, role) {
  const r = String(role || "").toLowerCase();
  if (portal === "client" && r !== "client") {
    return "Ce compte n'est pas autorisé sur l'espace client. Utilisez la connexion Agent MSP.";
  }
  if (portal === "agent" && r === "client") {
    return "Utilisez l'espace client pour vous connecter.";
  }
  return null;
}
