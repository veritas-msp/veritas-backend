import { getLicensePublicSummary, isDevProBypass, isLicenseCacheValid, getLicensedMspAgentLimit } from "./proLicense.js";
export const COMMUNITY_LIMITS = {
  mspAgents: 5,
  clientPortalUsers: 3,
  clients: 100,
  contacts: 300,
  rmmAgents: 25,
  sitesPerClient: 3,
  ticketMacros: 3,
  ticketTemplates: 3
};
export function isCommunity() {
  return !isPro();
}
export function isPro() {
  return isLicenseCacheValid();
}
export function getEdition() {
  return isPro() ? "pro" : "community";
}
export function getEditionPayload() {
  const summary = getLicensePublicSummary();
  const agentLimit = getLicensedMspAgentLimit();
  return {
    edition: getEdition(),
    limits: isCommunity() ? {
      ...COMMUNITY_LIMITS
    } : agentLimit != null ? {
      mspAgents: agentLimit
    } : null,
    modules: isCommunity() ? {
      Contrat: true,
      Contact: true,
      Ticket: true,
      Home: true
    } : null,
    license: summary.license
  };
}
