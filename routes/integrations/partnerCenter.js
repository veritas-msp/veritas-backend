import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import fetch from 'node-fetch';
import { getSettingsMap } from '../../utils/settingsHelper.js';
const router = express.Router();
router.use(verifyJWT);
const GRAPH_API_URL = 'https://graph.microsoft.com/beta';
const PARTNER_CENTER_API_URL = 'https://api.partnercenter.microsoft.com/v1';
const AUTH_URL_TEMPLATE = tenantId => `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
async function getPartnerCenterSettings() {
  try {
    const settings = await getSettingsMap(['PARTNER_CENTER_APP_ID', 'PARTNER_CENTER_SECRET_ID', 'PARTNER_CENTER_TENANT_ID']);
    return {
      clientId: settings.PARTNER_CENTER_APP_ID || '',
      clientSecret: settings.PARTNER_CENTER_SECRET_ID || '',
      tenantId: settings.PARTNER_CENTER_TENANT_ID || ''
    };
  } catch (error) {
    return null;
  }
}
let graphTokenCache = {
  token: null,
  expiry: null
};
let partnerCenterTokenCache = {
  token: null,
  expiry: null
};
function clearTokenCache() {
  graphTokenCache.token = null;
  graphTokenCache.expiry = null;
  partnerCenterTokenCache.token = null;
  partnerCenterTokenCache.expiry = null;
}
async function getGraphAccessToken() {
  if (graphTokenCache.token && graphTokenCache.expiry && Date.now() < graphTokenCache.expiry) {
    return graphTokenCache.token;
  }
  const settings = await getPartnerCenterSettings();
  if (!settings || !settings.clientId || !settings.clientSecret || !settings.tenantId) {
    throw new Error('Partner Center configuration incomplete');
  }
  try {
    const response = await fetch(AUTH_URL_TEMPLATE(settings.tenantId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      })
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error_description || `HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    graphTokenCache.token = data.access_token;
    graphTokenCache.expiry = Date.now() + (data.expires_in - 300) * 1000;
    return graphTokenCache.token;
  } catch (error) {
    throw new Error(`Authentication failed: ${error.message}`);
  }
}
async function getPartnerCenterAccessToken() {
  if (partnerCenterTokenCache.token && partnerCenterTokenCache.expiry && Date.now() < partnerCenterTokenCache.expiry) {
    return partnerCenterTokenCache.token;
  }
  const settings = await getPartnerCenterSettings();
  if (!settings || !settings.clientId || !settings.clientSecret || !settings.tenantId) {
    throw new Error('Partner Center configuration incomplete');
  }
  try {
    const response = await fetch(AUTH_URL_TEMPLATE(settings.tenantId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        scope: 'https://api.partnercenter.microsoft.com/.default',
        grant_type: 'client_credentials'
      })
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error_description || `HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    partnerCenterTokenCache.token = data.access_token;
    partnerCenterTokenCache.expiry = Date.now() + (data.expires_in - 300) * 1000;
    return partnerCenterTokenCache.token;
  } catch (error) {
    throw new Error(`Partner Center authentication failed: ${error.message}`);
  }
}
async function getAccessToken() {
  return getGraphAccessToken();
}
function decodeToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const payload = parts[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch (error) {
    return null;
  }
}
async function checkTokenPermissions() {
  try {
    const token = await getGraphAccessToken();
    const decoded = decodeToken(token);
    if (!decoded) {
      return {
        success: false,
        error: 'Unable to decode token'
      };
    }
    const roles = decoded.roles || [];
    const scopes = decoded.scp || decoded.scope || '';
    return {
      success: true,
      roles: roles,
      scopes: typeof scopes === 'string' ? scopes.split(' ') : scopes,
      appId: decoded.appid || decoded.azp,
      tenantId: decoded.tid,
      hasPolicyReadAll: roles.includes('Policy.Read.All') || roles.some(r => r.includes('Policy.Read.All')),
      hasPartnerBillingReadAll: roles.includes('PartnerBilling.Read.All') || roles.some(r => r.includes('PartnerBilling.Read.All')),
      allRoles: roles
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}
async function callGraphApi(endpoint, method = 'GET', body = null) {
  const token = await getAccessToken();
  const url = endpoint.startsWith('http') ? endpoint : `${GRAPH_API_URL}${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'MS-RequestId': generateRequestId(),
    'MS-CorrelationId': generateCorrelationId()
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  const options = {
    method,
    headers
  };
  if (body) {
    options.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || errorData.message || response.statusText;
      const errorCode = errorData.error?.code || errorData.code || '';
      const detailedError = new Error(errorMessage);
      detailedError.status = response.status;
      detailedError.statusText = response.statusText;
      detailedError.code = errorCode;
      detailedError.details = errorData.error || errorData;
      if (response.status === 403 && errorCode === 'Authorization_RequestDenied') {
        detailedError.permissionIssue = true;
        detailedError.suggestion = 'Admin consent may not have been granted. ' + 'Check in Azure Portal → App registrations → Your app → API permissions → ' + 'that all permissions show status "✓ Granted for [your organization]"';
      }
      throw detailedError;
    }
    return await response.json();
  } catch (error) {
    if (error.status) {
      throw error;
    }
    throw error;
  }
}
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : r & 0x3 | 0x8;
    return v.toString(16);
  });
}
function generateRequestId() {
  return generateUUID();
}
function generateCorrelationId() {
  return generateUUID();
}
async function callPartnerCenterApi(endpoint, method = 'GET', body = null) {
  const token = await getPartnerCenterAccessToken();
  const url = endpoint.startsWith('http') ? endpoint : `${PARTNER_CENTER_API_URL}${endpoint}`;
  const requestId = generateRequestId();
  const correlationId = generateCorrelationId();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'MS-RequestId': requestId,
    'MS-CorrelationId': correlationId,
    'X-Locale': 'fr-FR'
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  const options = {
    method,
    headers
  };
  if (body) {
    options.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      const errorText = await response.text();
      let errorData = {};
      try {
        errorData = JSON.parse(errorText);
      } catch (e) {
        errorData = {
          raw: errorText
        };
      }
      const errorMessage = errorData.error?.message || errorData.message || errorData.description || errorData.error_description || errorData.raw || response.statusText;
      const errorCode = errorData.error?.code || errorData.code || '';
      const detailedError = new Error(errorMessage);
      detailedError.status = response.status;
      detailedError.statusText = response.statusText;
      detailedError.code = errorCode;
      detailedError.details = errorData.error || errorData;
      detailedError.fullResponse = errorData;
      detailedError.endpoint = endpoint;
      detailedError.rawResponse = errorText;
      if (response.status === 403) {
        detailedError.permissionIssue = true;
        detailedError.suggestion = 'The Partner Center API requires a authentication App+User (application + signed-in user) rather than App-only (client_credentials).\\n\\n' + 'Evin if the application is added in Partner Center, l\\\'endpoint /customers requires a signed-in user.\\n\\n' + 'SOLUTION: Implement l\\\'authentication App+User with the OAuth 2.0 Authorization Code.\\n' + '1. The user must sign in once to obtain a refresh token\\n' + '2. Utiliser ce refresh token pour obtenir des access tokens\n' + '3. Access tokens obtained with App+User have access to CSP customers';
      }
      throw detailedError;
    }
    return await response.json();
  } catch (error) {
    if (error.status) {
      throw error;
    }
    throw error;
  }
}
async function getAllPartnersFromAPI() {
  const testedEndpoints = [];
  const errors = [];
  try {
    testedEndpoints.push('Microsoft Graph /contracts');
    const contractsResponse = await callGraphApi('/contracts');
    if (contractsResponse.value && Array.isArray(contractsResponse.value) && contractsResponse.value.length > 0) {
      return {
        partners: normalizePartnersFromGraph(contractsResponse.value),
        source: 'Microsoft Graph (CSP Contracts)',
        errorInfo: null,
        testedEndpoints: testedEndpoints
      };
    } else if (contractsResponse.value && Array.isArray(contractsResponse.value) && contractsResponse.value.length === 0) {
      errors.push({
        endpoint: 'Microsoft Graph /contracts',
        status: 'empty',
        message: 'No contract found'
      });
    } else {
      errors.push({
        endpoint: 'Microsoft Graph /contracts',
        status: 'unexpected',
        message: 'Unexpected response structure',
        response: contractsResponse
      });
    }
  } catch (contractsError) {
    errors.push({
      endpoint: 'Microsoft Graph /contracts',
      status: contractsError.status || 'error',
      code: contractsError.code,
      message: contractsError.message,
      details: contractsError.details
    });
  }
  try {
    testedEndpoints.push('Microsoft Graph /organization');
    const orgResponse = await callGraphApi('/organization');
    if (orgResponse.value && Array.isArray(orgResponse.value) && orgResponse.value.length > 0) {}
  } catch (orgError) {
    errors.push({
      endpoint: 'Microsoft Graph /organization',
      status: orgError.status || 'error',
      message: orgError.message
    });
  }
  try {
    testedEndpoints.push('Microsoft Graph /organization/relationships');
    const relationshipsResponse = await callGraphApi('/organization/relationships');
    if (relationshipsResponse.value && Array.isArray(relationshipsResponse.value) && relationshipsResponse.value.length > 0) {
      const partners = relationshipsResponse.value.map(rel => ({
        partner_id: rel.id || rel.targetTenantId || '',
        company_name: rel.displayName || rel.targetTenantName || '',
        domain: rel.targetTenantDomain || '',
        relationship_to_partner: rel.relationshipType || 'organization',
        mpn_id: '',
        location_country: '',
        location_city: '',
        status: 'active',
        raw_data: rel
      }));
      if (partners.length > 0) {
        return {
          partners: partners,
          source: 'Microsoft Graph (Organization Relationships)',
          errorInfo: null,
          testedEndpoints: testedEndpoints
        };
      }
    }
  } catch (relError) {
    errors.push({
      endpoint: 'Microsoft Graph /organization/relationships',
      status: relError.status || 'error',
      message: relError.message
    });
  }
  const partnerCenterEndpoints = ['/customers?size=40', '/customers', '/relationships', '/profiles/organization'];
  let lastPartnerCenterError = null;
  for (const endpoint of partnerCenterEndpoints) {
    try {
      const response = await callPartnerCenterApi(endpoint);
      let allPartners = [];
      let partnersFound = false;
      if (response.items && Array.isArray(response.items)) {
        allPartners = [...response.items];
        partnersFound = true;
        let hasMore = true;
        let currentResponse = response;
        while (hasMore) {
          const nextLink = currentResponse.links?.next;
          if (nextLink && nextLink.uri) {
            try {
              const nextEndpoint = nextLink.uri.startsWith('/') ? nextLink.uri : nextLink.uri.replace(PARTNER_CENTER_API_URL, '');
              const nextResponse = await callPartnerCenterApi(nextEndpoint);
              if (nextResponse.items && Array.isArray(nextResponse.items) && nextResponse.items.length > 0) {
                allPartners.push(...nextResponse.items);
                currentResponse = nextResponse;
              } else {
                hasMore = false;
              }
            } catch (pageError) {
              hasMore = false;
            }
          } else {
            hasMore = false;
          }
        }
      } else if (response.value && Array.isArray(response.value)) {
        allPartners = response.value;
        partnersFound = true;
      } else if (Array.isArray(response)) {
        allPartners = response;
        partnersFound = true;
      } else if (response.organizationProfile || response.companyProfile) {
        partnersFound = false;
      } else if (response.totalCount !== undefined) {
        if (response.totalCount === 0) {
          return {
            partners: [],
            source: `Partner Center API (${endpoint})`,
            errorInfo: {
              type: 'empty',
              message: 'No CSP customer found in Partner Center',
              endpoint: endpoint,
              responseStructure: Object.keys(response)
            }
          };
        }
      }
      if (partnersFound && allPartners.length > 0) {
        return {
          partners: normalizePartners(allPartners),
          source: `Partner Center API (${endpoint})`,
          errorInfo: null
        };
      }
      if (partnersFound && allPartners.length === 0) {
        continue;
      }
      continue;
    } catch (error) {
      lastPartnerCenterError = {
        endpoint: endpoint,
        status: error.status,
        code: error.code,
        message: error.message,
        details: error.details,
        fullResponse: error.fullResponse,
        rawResponse: error.rawResponse,
        statusText: error.statusText,
        suggestion: error.suggestion
      };
      if (error.status === 403 || error.status === 401) {
        continue;
      }
      continue;
    }
  }
  if (lastPartnerCenterError) {
    let errorMessage = '';
    if (lastPartnerCenterError.status === 403) {
      errorMessage = `Access denied (403) to l'API Partner Center - Endpoint: ${lastPartnerCenterError.endpoint}`;
      if (lastPartnerCenterError.message) {
        errorMessage += `\nMessage: ${lastPartnerCenterError.message}`;
      }
      if (lastPartnerCenterError.code) {
        errorMessage += `\nCode: ${lastPartnerCenterError.code}`;
      }
    } else if (lastPartnerCenterError.status === 401) {
      errorMessage = `Authentication error (401) with Partner Center API - Endpoint: ${lastPartnerCenterError.endpoint}`;
      if (lastPartnerCenterError.message) {
        errorMessage += `\nMessage: ${lastPartnerCenterError.message}`;
      }
    } else {
      errorMessage = `Partner Center API error - Endpoint: ${lastPartnerCenterError.endpoint}`;
      if (lastPartnerCenterError.message) {
        errorMessage += `\nMessage: ${lastPartnerCenterError.message}`;
      }
    }
    return {
      partners: [],
      source: 'Partner Center API',
      errorInfo: {
        type: lastPartnerCenterError.status === 403 ? 'permission' : lastPartnerCenterError.status === 401 ? 'auth' : 'error',
        status: lastPartnerCenterError.status,
        code: lastPartnerCenterError.code,
        message: errorMessage,
        endpoint: lastPartnerCenterError.endpoint,
        details: lastPartnerCenterError.details,
        fullResponse: lastPartnerCenterError.fullResponse,
        rawResponse: lastPartnerCenterError.rawResponse,
        suggestion: lastPartnerCenterError.status === 403 ? '🔴 ISSUE IDENTIFIED : L\\\'API Partner Center /customers requires a authentication App+User\\n\\n' + 'Even if your "Veritas Prod" application is correctly added in Partner Center with the appropriate roles, the /customers endpoint requires a signed-in user.\\n\\n' + '📋 DIFFERENCE BETWEEN App-only ET App+User :\\n' + '   • App-only (client_credentials) : L\'application s\'authentifie seule\n' + '     → Fonctionne pour certains endpoints, mais PAS pour /customers\n' + ' • App+User (authorization_code) : The application + a signed-in user\\n' + ' → Required to access to CSP customers via /customers\\n\\n' + '🔧 SOLUTION: Implement l\\\'authentication App+User\\n\\n' + 'STEP 1: Change flow d\\\'authentication\\n' + '   - Use the OAuth 2.0 Authorization Code flow instead of client_credentials\n' + ' - L\\\'user doit sign in a fois via a URL d\\\'authorization\\n' + ' - Retrieve a refresh tokin on the first sign-in\\n\\n' + 'STEP 2: Use refresh token\\n' + ' - Store the refresh tokin securely\\n' + '   - Utiliser ce refresh token pour obtenir des access tokens\n' + '   - Access tokens obtained with App+User have access to CSP customers\\n\\n' + '📚 Documentation :\n' + '   - https://learn.microsoft.com/fr-fr/partner-center/developer/partner-center-authentication\n' + '   - Section "App+User authentication"\n\n' + '💡 ALTERNATIVE : Utiliser Microsoft Graph /contracts\n' + ' If yor add the permission PartnerBilling.Read.All (Application) in Microsoft Graph,\\n' + ' yor can retrieve CSP customers via l\\\'endpoint /contracts without App+User.' : lastPartnerCenterError.status === 401 ? 'Authentication error. Verify the access tokin is valide and the application is correctly configured in Partner Center.' : `Partner Center API error.\\n\\n` + `Error details :\\n` + `- Endpoint: ${lastPartnerCenterError.endpoint}\n` + `- Statut: ${lastPartnerCenterError.status}\n` + `- Message: ${lastPartnerCenterError.message || 'No message'}\\n` + (lastPartnerCenterError.rawResponse ? `\\nRaw response API:\\n${lastPartnerCenterError.rawResponse.substring(0, 500)}` : '')
      }
    };
  }
  try {
    testedEndpoints.push('Microsoft Graph /policies/crossTenantAccessPolicy/partners');
    const graphResponse = await callGraphApi('/policies/crossTenantAccessPolicy/partners');
    if (graphResponse.value && Array.isArray(graphResponse.value) && graphResponse.value.length > 0) {
      return {
        partners: normalizePartnersFromGraphCrossTenant(graphResponse.value),
        source: 'Microsoft Graph (Cross-Tenant Access Policy)',
        errorInfo: null,
        testedEndpoints: testedEndpoints
      };
    } else if (graphResponse.value && Array.isArray(graphResponse.value) && graphResponse.value.length === 0) {
      errors.push({
        endpoint: 'Microsoft Graph /policies/crossTenantAccessPolicy/partners',
        status: 'empty',
        message: 'No partner configured in cross-tenant access policies Azure AD'
      });
    }
  } catch (graphError) {
    errors.push({
      endpoint: 'Microsoft Graph /policies/crossTenantAccessPolicy/partners',
      status: graphError.status || 'error',
      code: graphError.code,
      message: graphError.message,
      details: graphError.details
    });
  }
  return {
    partners: [],
    source: 'inconnue',
    errorInfo: {
      type: 'error',
      message: 'No partner customer found after testing all availabendpoints',
      testedEndpoints: testedEndpoints,
      errors: errors,
      details: 'Endpoints tested:\\n' + testedEndpoints.map(e => `- ${e}`).join('\n') + '\n\n' + 'Errors encountered:\\n' + errors.map(e => `- ${e.endpoint}: ${e.status} - ${e.message}`).join('\n'),
      suggestion: 'IMPORTANT: CSP customers (those you see in Partner Center) are DIFFERENT from partners in Azure AD cross-tenant access policies.\n\n' + 'To retrieve your CSP customers :\\n' + '→ Option 1 : Add the permission PartnerBilling.Read.All (Application) in Microsoft Graph\\n' + '   Azure Portal → App registrations → Your app → API permissions → Add PartnerBilling.Read.All (Application) → Grant admin consent\n\n' + '→ Option 2 : Ajouter l\'application dans Partner Center\n' + ' Partner Center → Settings → Applications → Add your application Azure AD\\n' + ' Note : L\\\'API Partner Center may require authentication App+User rather than App-only\\n\\n' + 'To retrieve partners Azure AD (with Policy.Read.All) :\\n' + '→ Configure partners in Azure AD → External Identities → Cross-tenant access settings\n' + '→ Add the Tenant ID of each partner'
    }
  };
}
function normalizePartnersFromGraphCrossTenant(partners) {
  return partners.map(partner => {
    const tenantId = partner.tenantId || '';
    const displayName = partner.identitySynchronization?.displayName || partner.displayName || `Tenant ${tenantId.substring(0, 8)}...`;
    return {
      partner_id: tenantId,
      company_name: displayName,
      domain: '',
      relationship_to_partner: partner.isInMultiTenantOrganization ? 'Multi-tenant organization' : 'Cross-tenant access',
      mpn_id: '',
      location_country: '',
      location_city: '',
      status: 'active',
      raw_data: partner
    };
  });
}
function normalizePartnersFromGraph(contracts) {
  return contracts.map(contract => ({
    partner_id: contract.customerId || contract.id || '',
    company_name: contract.displayName || contract.customerDisplayName || '',
    domain: contract.defaultDomainName || '',
    relationship_to_partner: 'CSP',
    mpn_id: contract.partnerId || '',
    location_country: '',
    location_city: '',
    status: contract.status || 'active',
    raw_data: contract
  }));
}
function normalizePartners(partners) {
  return partners.map(partner => {
    const customerId = partner.id || partner.customerId || partner.partnerId || '';
    const tenantId = partner.companyProfile?.tenantId || partner.tenantId || partner.companyProfile?.organizationId || '';
    const partnerId = tenantId || customerId;
    const companyName = partner.companyProfile?.companyName || partner.companyName || partner.name || partner.displayName || partner.organizationName || '';
    const domain = partner.companyProfile?.domain || partner.domain || partner.companyProfile?.defaultDomainName || '';
    const mpnId = partner.companyProfile?.mpnId || partner.mpnId || partner.partnerId || '';
    const country = partner.companyProfile?.address?.country || partner.address?.country || partner.country || partner.companyProfile?.country || '';
    const city = partner.companyProfile?.address?.city || partner.address?.city || partner.city || partner.companyProfile?.city || '';
    const relationship = partner.relationshipToPartner || partner.relationship || partner.type || 'reseller';
    return {
      partner_id: partnerId || customerId,
      company_name: companyName || `Client ${customerId.substring(0, 8)}...`,
      domain: domain,
      relationship_to_partner: relationship,
      mpn_id: mpnId,
      location_country: country,
      location_city: city,
      status: partner.status || 'active',
      raw_data: partner
    };
  });
}
function extractContinuationToken(nextLink) {
  if (!nextLink) return null;
  const match = nextLink.match(/continuationToken=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
async function syncPartners() {
  try {
    const apiResult = await getAllPartnersFromAPI();
    const apiPartners = apiResult.partners || [];
    const source = apiResult.source;
    const errorInfo = apiResult.errorInfo;
    const testedEndpoints = apiResult.testedEndpoints || apiResult.errorInfo?.testedEndpoints || [];
    const dbResult = await pool.query('SELECT * FROM v_b_s_ms_partner');
    const dbPartners = dbResult.rows;
    const dbPartnersMap = new Map(dbPartners.map(p => [p.partner_id, p]));
    const stats = {
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0
    };
    const apiPartnersMap = new Map(apiPartners.map(p => [p.partner_id, p]));
    for (const apiPartner of apiPartners) {
      const dbPartner = dbPartnersMap.get(apiPartner.partner_id);
      if (!dbPartner) {
        await pool.query(`INSERT INTO v_b_s_ms_partner 
           (partner_id, company_name, domain, relationship_to_partner, mpn_id, 
            location_country, location_city, status, raw_data, last_synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`, [apiPartner.partner_id, apiPartner.company_name, apiPartner.domain, apiPartner.relationship_to_partner, apiPartner.mpn_id, apiPartner.location_country, apiPartner.location_city, apiPartner.status, JSON.stringify(apiPartner.raw_data)]);
        stats.created++;
      } else {
        const hasChanges = dbPartner.company_name !== apiPartner.company_name || dbPartner.domain !== apiPartner.domain || dbPartner.status !== apiPartner.status || dbPartner.mpn_id !== apiPartner.mpn_id || dbPartner.location_country !== apiPartner.location_country || dbPartner.location_city !== apiPartner.location_city;
        if (hasChanges) {
          await pool.query(`UPDATE v_b_s_ms_partner 
             SET company_name = $1, domain = $2, relationship_to_partner = $3,
                 mpn_id = $4, location_country = $5, location_city = $6,
                 status = $7, raw_data = $8, updated_at = NOW(), last_synced_at = NOW()
             WHERE partner_id = $9`, [apiPartner.company_name, apiPartner.domain, apiPartner.relationship_to_partner, apiPartner.mpn_id, apiPartner.location_country, apiPartner.location_city, apiPartner.status, JSON.stringify(apiPartner.raw_data), apiPartner.partner_id]);
          stats.updated++;
        } else {
          await pool.query('UPDATE v_b_s_ms_partner SET last_synced_at = NOW() WHERE partner_id = $1', [apiPartner.partner_id]);
          stats.unchanged++;
        }
      }
    }
    for (const dbPartner of dbPartnersMap.values()) {
      if (!apiPartnersMap.has(dbPartner.partner_id)) {
        await pool.query('UPDATE v_b_s_ms_partner SET status = $1, updated_at = NOW() WHERE partner_id = $2', ['inactive', dbPartner.partner_id]);
        stats.deleted++;
      }
    }
    let warning = null;
    let diagnosticMessage = null;
    if (apiPartners.length === 0) {
      warning = 'No partner found in l\\\'API.\\n\\n';
      if (errorInfo) {
        warning += `Source tested: ${source || 'unknown'}\\n\\n`;
        if (errorInfo.testedEndpoints && errorInfo.testedEndpoints.length > 0) {
          warning += 'Endpoints tested:\\n';
          errorInfo.testedEndpoints.forEach(endpoint => {
            warning += `- ${endpoint}\n`;
          });
          warning += '\n';
        }
        if (errorInfo.errors && errorInfo.errors.length > 0) {
          warning += 'Errors encountered:\\n';
          errorInfo.errors.forEach(err => {
            warning += `- ${err.endpoint}: ${err.status} - ${err.message || 'No message'}\\n`;
          });
          warning += '\n';
        }
        if (errorInfo.suggestion) {
          warning += errorInfo.suggestion;
        } else {
          warning += 'The customers you see in Partner Center probably require ' + 'App+User authentication (application + signed-in user) ' + 'rather than App-only authentication (client_credentials only).\\n\\n' + 'To retrieve your CSP customers, you need to implement App+User authentication ' + 'with the OAuth 2.0 Authorization Code flow.';
        }
      } else {
        warning += 'The customers you see in Partner Center probably require ' + 'App+User authentication (application + signed-in user) ' + 'rather than App-only authentication (client_credentials only).\\n\\n' + 'To retrieve your CSP customers, you need to implement App+User authentication ' + 'with the OAuth 2.0 Authorization Code flow.';
      }
      diagnosticMessage = {
        source: source,
        errorInfo: errorInfo,
        testedEndpoints: testedEndpoints,
        suggestion: errorInfo?.suggestion || 'Check permissions and configuration application'
      };
    }
    return {
      success: true,
      stats,
      total: apiPartners.length,
      source: source,
      warning: warning,
      diagnostic: diagnosticMessage,
      testedEndpoints: testedEndpoints,
      errorInfo: errorInfo
    };
  } catch (error) {
    throw error;
  }
}
async function getApplicationInfo(clientId) {
  try {
    const response = await callGraphApi(`/applications?$filter=appId eq '${clientId}'`);
    if (response.value && response.value.length > 0) {
      const app = response.value[0];
      const appName = app.displayName || app.appDisplayName || 'Application inconnue';
      let secretExpiry = null;
      let secretError = null;
      try {
        const credentialsResponse = await callGraphApi(`/applications/${app.id}/passwordCredentials`);
        if (credentialsResponse.value && credentialsResponse.value.length > 0) {
          const secrets = credentialsResponse.value.sort((a, b) => {
            const dateA = a.endDateTime ? new Date(a.endDateTime) : new Date(0);
            const dateB = b.endDateTime ? new Date(b.endDateTime) : new Date(0);
            return dateB - dateA;
          });
          if (secrets.length > 0 && secrets[0].endDateTime) {
            secretExpiry = secrets[0].endDateTime;
          }
        }
      } catch (credError) {
        secretError = credError.status === 403 ? 'Insufficient permissions (Application.Read.All required)' : credError.message;
      }
      return {
        appName,
        secretExpiry,
        secretError
      };
    }
    return {
      appName: 'Application not found',
      secretExpiry: null,
      secretError: null
    };
  } catch (error) {
    if (error.status === 403) {
      const isConsentIssue = error.code === 'Authorization_RequestDenied';
      return {
        appName: isConsentIssue ? 'Error 403: Admin consent required' : 'Error 403: Insufficient permissions',
        secretExpiry: null,
        secretError: isConsentIssue ? 'Admin consent was not granted. Click "Grant admin consent" in Azure Portal.' : `Missing permission: Application.Read.All (type Application, not Delegated)`,
        permissionError: true,
        consentIssue: isConsentIssue
      };
    }
    return {
      appName: `Error: ${error.message}`,
      secretExpiry: null,
      secretError: null
    };
  }
}
router.post('/test', async (req, res) => {
  try {
    const settings = await getPartnerCenterSettings();
    if (!settings || !settings.clientId || !settings.clientSecret || !settings.tenantId) {
      return res.status(400).json({
        success: false,
        error: 'Incomplete configuration',
        details: 'Please configure APP_ID, SECRET_ID and TENANT_ID in Entra ID settings'
      });
    }
    const graphToken = await getGraphAccessToken();
    if (!graphToken) {
      return res.status(401).json({
        success: false,
        error: 'Microsoft Graph authentication failed',
        details: 'Unabto obtain an access token'
      });
    }
    let partnerCenterToken = null;
    try {
      partnerCenterToken = await getPartnerCenterAccessToken();
    } catch (pcError) {}
    const appInfo = await getApplicationInfo(settings.clientId);
    let multiTenantInfo = null;
    try {
      const graphToken = await getGraphAccessToken();
      const appResponse = await fetch(`${GRAPH_API_URL}/applications?$filter=appId eq '${settings.clientId}'&$select=id,appId,displayName,signInAudience`, {
        headers: {
          'Authorization': `Bearer ${graphToken}`,
          'Content-Type': 'application/json'
        }
      });
      if (appResponse.ok) {
        const appData = await appResponse.json();
        if (appData.value && appData.value.length > 0) {
          const app = appData.value[0];
          multiTenantInfo = {
            isMultiTenant: app.signInAudience === 'AzureADMultipleOrgs' || app.signInAudience === 'AzureADandPersonalMicrosoftAccount',
            signInAudience: app.signInAudience
          };
        }
      }
    } catch (mtError) {}
    const tokenPermissions = await checkTokenPermissions();
    try {
      const result = await getAllPartnersFromAPI();
      const partners = result.partners || [];
      const source = result.source;
      const errorInfo = result.errorInfo;
      if (partners.length === 0) {
        let warning = 'No partner found.\\n\\n' + '📋 PARTNER TYPES (IMPORTANT - These are different things !) :\\n\\n' + '1. CLIENTS CSP PARTNER CENTER (ce que vous voyez dans Partner Center)\n' + ' → Endpoints tested:\\n' + '     - Microsoft Graph /contracts (contrats CSP)\n' + '     - Partner Center API /customers\n' + '   → These are the customers you see in Partner Center → Customers\n' + '   → Permissions: PartnerBilling.Read.All, CrossTenantInformation.ReadBasic.All\n' + ' → ⚠️ These customers are DIFFERENT partners in cross-tenant access policies\\n\\n' + '2. CROSS-TENANT ACCESS POLICY PARTNERS (Azure AD)\\n' + '   → Endpoint: /policies/crossTenantAccessPolicy/partners\n' + ' → Lists partners in cross-tenant access policies Azure AD\\n' + ' → Required permission: Policy.Read.All (Application)\\n' + ' → ⚠️ These are partners configured in Azure AD → External Identities\\n' + '   → Documentation: https://learn.microsoft.com/en-us/graph/api/crosstenantaccesspolicy-list-partners\n\n';
        if (!partnerCenterToken) {
          warning += '⚠️ Partner Center authentication failed. Verify that :\\n' + '- "Application" permissions are configured for Partner Center API\\n' + '- Admin consent was granted\n' + '- L\\\'application is added in Partner Center';
        } else {
          if (errorInfo && errorInfo.type === 'permission') {
            warning += `❌ ERROR DETECTED : ${errorInfo.message}\\n\\n` + '🔴 PERMISSION MICROSOFT GRAPH MANQUANTE\n\n' + `Error code: ${errorInfo.code || 'Authorization_RequestDenied'}\\n` + `Statut HTTP: ${errorInfo.status}\n\n` + '🔧 IMMEDIATE SOLUTION :\\n' + '1. Azure Portal → App registrations → Your application\n' + '2. Onglet "API permissions" → "Add a permission"\n' + '3. Select "Microsoft Graph" → "Application permissions"\\n' + '4. Rechercher et ajouter "Policy.Read.All"\n' + '5. Click "Grant admin consent for [your organization]"\n' + '6. Wait a few seconds for propagation\n' + '7. Re-tis the connection\\n\\n' + '📝 Documentation: https://learn.microsoft.com/en-us/graph/api/crosstenantaccesspolicy-list-partners';
          } else if (errorInfo && errorInfo.type === 'empty') {
            warning += `ℹ️ INFORMATION : ${errorInfo.message}\n\n` + '✅ Microsoft Graph works correctly, but no partner is configured.\\n\\n' + '🔧 POUR AJOUTER DES PARTENAIRES :\n' + '1. Azure Portal → Azure Active Directory → External Identities\n' + '2. Cross-tenant access settings → Add partner organization\n' + '3. Enter the partner Tenant ID\n' + '4. Configure access settings\\n' + '5. Save\n\n' + 'OR use Partner Center API to retrieve CSP customers.';
          } else {
            warning += '✅ Authentication successful, but no CSP customer found.\\n\\n' + '🔴 POSSIBLE ISSUES :\\n\\n' + '1. ENDPOINT MICROSOFT GRAPH /contracts RETURNS NO DATA\\n' + '   → You have the permissions (PartnerBilling.Read.All, etc.)\n' + '   → Mais /contracts retourne un tableau vide\n' + '   → This may mean CSP contracts are not accessible via this endpoint\n' + ' → OU that l\\\'endpoint requires additional parameters\\n\\n' + '2. PARTNER CENTER API /customers RETOURNE 403\n' + ' → L\\\'API Partner Center may require authentication "App+User"\\n' + '   → Current authentication is "App-only" (client_credentials only)\n' + ' → Evin if the application is added in Partner Center\\n\\n' + '3. ENDPOINT INCORRECT\n' + ' → The customers you see in Partner Center may require a different endpoint\n' + ' → Ou a additional configuration in Partner Center\\n\\n' + '🔧 SOLUTIONS TO TRY :\\n\\n' + 'OPTION 1 : Check server logs\\n' + '   → Check the logs to see exactly what the endpoints return\n' + ' → Check si /contracts really returns an empty array or an error\\n\\n' + 'OPTION 2 : Utiliser l\'API Partner Center avec authentification App+User\n' + '   → Change the code to use the OAuth 2.0 Authorization Code flow\n' + ' → A user must sign in once to obtain a refresh token\\n' + '   → Utiliser ce refresh token pour obtenir des access tokens\n\n' + 'OPTION 3 : Check configuration in Partner Center\\n' + ' → Partner Center → Settings → Applications → Your application\\n' + ' → Verify that l\\\'application has the required ro(e.g. "Customer management")\\n' + ' → Verify that l\\\'application is enabled and approved\\n\\n' + 'OPTION 4 : Essayer d\'autres endpoints Microsoft Graph\n' + ' → Perhaps CSP customers are accessibvia another endpoint\\n' + '   → See Microsoft Graph documentation for CSP endpoints\n\n' + '📝 Note: The customers you see in Partner Center → Customers are CSP customers.\n' + ' They are different partners in cross-tenant access policies Azure AD.';
          }
          if (source) {
            warning += `\\n\\n📊 Source tested: ${source}`;
          }
        }
        warning += '\\n\\nCheck server logs for more details on tested endpoints.';
        return res.json({
          success: true,
          message: 'Authentication successful',
          partnersCount: 0,
          tenantId: settings.tenantId,
          appName: appInfo.appName,
          secretExpiry: appInfo.secretExpiry,
          secretError: appInfo.secretError,
          permissionError: appInfo.permissionError || errorInfo && errorInfo.type === 'permission',
          partnerCenterAuth: !!partnerCenterToken,
          multiTenantInfo: multiTenantInfo,
          adminConsentUrl: multiTenantInfo && !multiTenantInfo.isMultiTenant ? `https://login.microsoftonline.com/organizations/adminconsent?client_id=${settings.clientId}` : null,
          source: source,
          errorInfo: errorInfo,
          tokenPermissions: tokenPermissions,
          warning: warning
        });
      }
      return res.json({
        success: true,
        message: `Connection successful - ${source || 'API'}`,
        partnersCount: partners.length,
        tenantId: settings.tenantId,
        appName: appInfo.appName,
        secretExpiry: appInfo.secretExpiry,
        secretError: appInfo.secretError,
        partnerCenterAuth: !!partnerCenterToken,
        source: source,
        errorInfo: null,
        tokenPermissions: tokenPermissions
      });
    } catch (apiError) {
      let permissionMessage = '';
      if (apiError.status === 403 && apiError.code === 'Authorization_RequestDenied') {
        permissionMessage =
          '\\n\\n❌ ERROR 403 - ADMIN CONSENT REQUIRED\\n\\n' +
          'Permissions are added but ADMIN CONSENT was not granted.\\n\\n' +
          'STEPS TO FOLLOW:\\n' +
          '1. Azure Portal → Azure Active Directory → App registrations → Your application\\n' +
          '2. API permissions → Verify all your Application permissions are listed\\n' +
          '   - For Microsoft Graph: Application.Read.All (for application info)\\n' +
          '   - For Partner Center API: permissions required to access customers\\n' +
          '3. Check the "Status" column for each permission\\n' +
          '4. If you see "⚠️ Requires admin consent" or "Not granted", click "Grant admin consent for [your organization]"\\n' +
          '5. Wait a few seconds for propagation\\n' +
          '6. Re-test the connection\\n\\n' +
          'IMPORTANT:\\n' +
          '- The "Grant admin consent" button must be clicked for EACH Application permission\\n' +
          '- You must be an Azure AD administrator to grant consent\\n' +
          '- There may be a few minutes delay for propagation\\n' +
          '- Make sure the application is added in Partner Center\\n\\n' +
          'Verify the status shows "✓ Granted for [your organization]" (not just "✓ Granted for PSI")';
      } else if (apiError.status === 403) {
        let multiTenantWarning = '';
        if (multiTenantInfo && !multiTenantInfo.isMultiTenant) {
          multiTenantWarning =
            '\\n\\n⚠️ NON-MULTI-TENANT APPLICATION DETECTED\\n' +
            'Your application is not configured as multi-tenant.\\n' +
            'This can cause the error: "The client application TenantID is missing service principal in the tenant CustomerTenantID"\\n\\n' +
            '🔧 SOLUTION:\\n' +
            '1. Azure Portal → App registrations → Your application → Authentication\\n' +
            '2. Section "Supported account types"\\n' +
            '3. Select "Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)"\\n' +
            '4. Save\\n' +
            '5. For each customer tenant, run:\\n' +
            `   https://login.microsoftonline.com/{CustomerTenantID}/adminconsent?client_id=${settings.clientId}\\n\\n`;
        }
        permissionMessage =
          '\\n\\n🔴 ERROR 403 - ACCESS DENIED\\n\\n' +
          multiTenantWarning +
          'Authentication works, but access to data is denied.\\n\\n' +
          '📋 POSSIBLE CAUSES:\\n\\n' +
          '1. APPLICATION NOT MULTI-TENANT\\n' +
          '   → The application must be configured as multi-tenant\\n' +
          '   → The Service Principal must be created in each customer tenant via adminconsent\\n\\n' +
          '2. APP+USER AUTHENTICATION REQUIRED\\n' +
          '   → The Partner Center API may require "App+User" authentication (application + user)\\n' +
          '   → Current authentication is "App-only" (client_credentials only)\\n\\n' +
          '3. INSUFFICIENT PERMISSIONS\\n' +
          '   → Required permissions are not granted\\n' +
          '   → Admin consent was not granted\\n\\n' +
          '🔧 SOLUTIONS:\\n\\n' +
          'STEP 1: Configure the application as multi-tenant\\n' +
          '1. Azure Portal → App registrations → Your application → Authentication\\n' +
          '2. Select "Accounts in any organizational directory (Multitenant)"\\n' +
          '3. Save\\n\\n' +
          'STEP 2: Create Service Principals in customer tenants\\n' +
          'For each customer tenant, a global administrator must visit:\\n' +
          `   https://login.microsoftonline.com/{CustomerTenantID}/adminconsent?client_id=${settings.clientId}\\n\\n` +
          'OR for all organization tenants:\\n' +
          `   https://login.microsoftonline.com/organizations/adminconsent?client_id=${settings.clientId}\\n\\n` +
          'STEP 3: Check permissions\\n' +
          '1. Azure Portal → App registrations → Your app → API permissions\\n' +
          '2. For Microsoft Graph /policies/crossTenantAccessPolicy/partners:\\n' +
          '   → Add the permission "Policy.Read.All" (Application)\\n' +
          '   → Documentation: https://learn.microsoft.com/en-us/graph/api/crosstenantaccesspolicy-list-partners\\n' +
          '3. Grant admin consent\\n\\n' +
          'STEP 4: Check in Partner Center (if you use Partner Center API)\\n' +
          '1. Partner Center → Settings → Applications → Your application\\n' +
          '2. Verify the application is added, enabled and has the required roles\\n\\n' +
          '📝 IMPORTANT NOTE:\\n' +
          '   - Microsoft Graph /policies/crossTenantAccessPolicy/partners lists partners in Azure AD cross-tenant access policies\\n' +
          '   - Partner Center API /customers lists customers/partners in Partner Center (CSP)\\n' +
          '   - These are two different types of partners!\\n' +
          '   - If the issue persists, the Partner Center API may require App+User authentication';
      }
      return res.json({
        success: true,
        message: 'Authentication successful',
        partnersCount: 0,
        warning: 'Unable to retrieve partners. Check application permissions.' + permissionMessage,
        tenantId: settings.tenantId,
        appName: appInfo.appName,
        secretExpiry: appInfo.secretExpiry,
        secretError: appInfo.secretError,
        permissionError: appInfo.permissionError || apiError.status === 403,
        consentIssue: appInfo.consentIssue || apiError.status === 403 && apiError.code === 'Authorization_RequestDenied',
        details: apiError.message || apiError.details?.message,
        errorCode: apiError.code,
        multiTenantInfo: multiTenantInfo,
        adminConsentUrl: multiTenantInfo && !multiTenantInfo.isMultiTenant ? `https://login.microsoftonline.com/organizations/adminconsent?client_id=${settings.clientId}` : null,
        tokenPermissions: tokenPermissions,
        suggestion: apiError.status === 403 && apiError.code === 'Authorization_RequestDenied'
          ? 'IMPORTANT STEPS:\\n' +
            '1. Azure Portal → App registrations → Your app → API permissions\\n' +
            '2. Verify each Application permission has status "✓ Granted for [your organization]"\\n' +
            '3. If you see "⚠️ Requires admin consent", click "Grant admin consent for [your organization]"\\n' +
            '4. Wait 1-2 minutes for propagation\\n' +
            '5. Re-test the connection\\n\\n' +
            'The following permissions must be granted (Application type):\\n' +
            '- Application.Read.All\\n' +
            '- Policy.Read.All or Policy.ReadWrite.CrossTenantAccess'
          : 'Verify the Azure AD application has the following permissions (APPLICATION type):\\n' +
            '- Microsoft Graph API: Policy.Read.All or Policy.ReadWrite.CrossTenantAccess (Application)\\n' +
            '- Microsoft Graph API: Application.Read.All (Application)\\n' +
            '- Admin consent must be granted for each permission'
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Connection error to Microsoft Graph API',
      details: error.message
    });
  }
});
router.get('/partners', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM v_b_s_ms_partner ORDER BY company_name');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});
router.post('/partners/sync', async (req, res) => {
  try {
    const result = await syncPartners();
    const diagnosticInfo = {
      source: result.source,
      errorInfo: result.errorInfo,
      testedEndpoints: result.errorInfo?.testedEndpoints || [],
      errors: result.errorInfo?.errors || [],
      totalPartnersFound: result.total || 0,
      stats: result.stats || {}
    };
    res.json({
      ...result,
      diagnostic: diagnosticInfo
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack,
      suggestion: 'The customers you see in Partner Center probably require ' + 'a authentication App+User. See details below for more information.',
      diagnostic: {
        errorType: error.name,
        errorMessage: error.message,
        errorStack: error.stack
      }
    });
  }
});
router.get('/partners/sync/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
        COUNT(CASE WHEN status = 'inactive' THEN 1 END) as inactive,
        MAX(last_synced_at) as last_sync
      FROM v_b_s_ms_partner
    `);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});
export default router;
