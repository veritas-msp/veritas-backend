import { pool } from "../database/db.js";
import { COMMUNITY_LIMITS, isCommunity, isPro } from "./edition.js";
import { ensureFreshLicense, getLicensedMspAgentLimit } from "./proLicense.js";
const ACTIVE_MSP_AGENTS_SQL = `
  SELECT COUNT(*)::int AS count
  FROM v_b_users
  WHERE is_active = true
    AND COALESCE(role, '') <> 'client'
`;
const ACTIVE_CLIENT_PORTAL_SQL = `
  SELECT COUNT(*)::int AS count
  FROM v_b_users
  WHERE is_active = true
    AND COALESCE(role, '') = 'client'
`;
const CLIENTS_COUNT_SQL = `SELECT COUNT(*)::int AS count FROM v_b_clients`;
const CONTACTS_COUNT_SQL = `SELECT COUNT(*)::int AS count FROM v_b_contacts`;
const RMM_AGENTS_COUNT_SQL = `
  SELECT COUNT(*)::int AS count
  FROM v_b_rmm_agents
  WHERE COALESCE(status, 'active') = 'active'
`;
export function editionLimitError(code, message) {
  const err = new Error(message);
  err.status = 403;
  err.code = code;
  return err;
}
export function communityLimitError(code, message) {
  return editionLimitError(code, message);
}
async function countQuery(sql) {
  const result = await pool.query(sql);
  return Number(result.rows[0]?.count) || 0;
}
export async function assertMspAgentLimit(extra = 0) {
  await ensureFreshLicense();
  const count = await countQuery(ACTIVE_MSP_AGENTS_SQL);
  if (isCommunity()) {
    if (count + extra > COMMUNITY_LIMITS.mspAgents) {
      throw editionLimitError("COMMUNITY_AGENT_LIMIT", `Community limit: maximum ${COMMUNITY_LIMITS.mspAgents} MSP agents. Upgrade to Veritas Pro.`);
    }
    return;
  }
  if (!isPro()) return;
  const limit = getLicensedMspAgentLimit();
  if (limit == null) return;
  if (count + extra > limit) {
    throw editionLimitError("PRO_AGENT_LIMIT", `Pro limit: maximum ${limit} MSP agent(s) under your subscription. Update your subscription or deactivate accounts.`);
  }
}
export async function assertCommunityMspAgentLimit(extra = 0) {
  return assertMspAgentLimit(extra);
}
export async function getActiveClientPortalCount() {
  return countQuery(ACTIVE_CLIENT_PORTAL_SQL);
}
export async function assertCommunityClientPortalLimit(extra = 0) {
  if (!isCommunity()) return;
  const count = await getActiveClientPortalCount();
  if (count + extra > COMMUNITY_LIMITS.clientPortalUsers) {
    throw communityLimitError("COMMUNITY_CLIENT_PORTAL_LIMIT", `Community limit: maximum ${COMMUNITY_LIMITS.clientPortalUsers} client portal accounts.`);
  }
}
export async function assertCommunityClientsLimit(extra = 0) {
  if (!isCommunity()) return;
  const count = await countQuery(CLIENTS_COUNT_SQL);
  if (count + extra > COMMUNITY_LIMITS.clients) {
    throw communityLimitError("COMMUNITY_CLIENT_LIMIT", `Community limit: maximum ${COMMUNITY_LIMITS.clients} companies.`);
  }
}
export async function assertCommunityContactsLimit(extra = 0) {
  if (!isCommunity()) return;
  const count = await countQuery(CONTACTS_COUNT_SQL);
  if (count + extra > COMMUNITY_LIMITS.contacts) {
    throw communityLimitError("COMMUNITY_CONTACT_LIMIT", `Community limit: maximum ${COMMUNITY_LIMITS.contacts} contacts.`);
  }
}
export async function assertCommunityRmmAgentLimit(extra = 0) {
  if (!isCommunity()) return;
  const count = await countQuery(RMM_AGENTS_COUNT_SQL);
  if (count + extra > COMMUNITY_LIMITS.rmmAgents) {
    throw communityLimitError("COMMUNITY_RMM_AGENT_LIMIT", `Community limit: maximum ${COMMUNITY_LIMITS.rmmAgents} RMM agents.`);
  }
}
export function assertCommunitySitesLimit(sites) {
  if (!isCommunity()) return;
  const count = Array.isArray(sites) ? sites.length : 0;
  const limit = COMMUNITY_LIMITS.sitesPerClient;
  if (count > limit) {
    throw communityLimitError("COMMUNITY_SITES_LIMIT", `Community limit: maximum ${limit} sites per company. Upgrade to Veritas Pro.`);
  }
}
export function assertCommunityTicketTemplatesLimit(templates) {
  if (!isCommunity()) return;
  const count = Array.isArray(templates) ? templates.length : 0;
  const limit = COMMUNITY_LIMITS.ticketTemplates;
  if (count > limit) {
    throw communityLimitError("COMMUNITY_TICKET_TEMPLATES_LIMIT", `Community limit: maximum ${limit} templates. Upgrade to Veritas Pro.`);
  }
}
export function assertCommunityTicketMacrosLimit(macros) {
  if (!isCommunity()) return;
  const count = Array.isArray(macros) ? macros.length : 0;
  const limit = COMMUNITY_LIMITS.ticketMacros;
  if (count > limit) {
    throw communityLimitError("COMMUNITY_TICKET_MACROS_LIMIT", `Community limit: maximum ${limit} macros. Upgrade to Veritas Pro.`);
  }
}
export function assertCommunityTicketAutomationLimits(config) {
  assertCommunityTicketTemplatesLimit(config?.commentTemplates);
  assertCommunityTicketMacrosLimit(config?.macros);
}
export function sendCommunityLimitError(res, err) {
  return res.status(err.status || 403).json({
    error: err.message,
    code: err.code || "EDITION_LIMIT"
  });
}
