// ───────────────────────────────────────────────
// 📦 Route Microsoft Partner Center — Integration with Microsoft Graph API
// Uses the /policies/crossTenantAccessPolicy/partners endpoint to list partners
// ───────────────────────────────────────────────

import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import fetch from 'node-fetch';
import { getSettingsMap } from '../../utils/settingsHelper.js';

const router = express.Router();

// All routes require authentication
router.use(verifyJWT);

// ───────────────────────────────────────────────
// 🔧 Configuration
// ───────────────────────────────────────────────
const GRAPH_API_URL = 'https://graph.microsoft.com/beta';
const PARTNER_CENTER_API_URL = 'https://api.partnercenter.microsoft.com/v1';
const AUTH_URL_TEMPLATE = (tenantId) => `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

// ───────────────────────────────────────────────
// 🔐 Utility function: fetch Partner Center settings
// ───────────────────────────────────────────────
async function getPartnerCenterSettings() {
  try {
    const settings = await getSettingsMap([
      'PARTNER_CENTER_APP_ID',
      'PARTNER_CENTER_SECRET_ID',
      'PARTNER_CENTER_TENANT_ID'
    ]);
    return {
      clientId: settings.PARTNER_CENTER_APP_ID || '',
      clientSecret: settings.PARTNER_CENTER_SECRET_ID || '',
      tenantId: settings.PARTNER_CENTER_TENANT_ID || ''
    };
  } catch (error) {
    return null;
  }
}

// ───────────────────────────────────────────────
// 🔑 Access token management (in-memory cache)
// ───────────────────────────────────────────────
let graphTokenCache = {
  token: null,
  expiry: null
};

let partnerCenterTokenCache = {
  token: null,
  expiry: null
};

// Function to clear the token cache (useful after permission changes)
function clearTokenCache() {
  graphTokenCache.token = null;
  graphTokenCache.expiry = null;
  partnerCenterTokenCache.token = null;
  partnerCenterTokenCache.expiry = null;
}

// Token for Microsoft Graph API
async function getGraphAccessToken() {
  // Check whether the token is still valid (with a 5-minute margin)
  if (graphTokenCache.token && graphTokenCache.expiry && Date.now() < graphTokenCache.expiry) {
    return graphTokenCache.token;
  }

  const settings = await getPartnerCenterSettings();
  if (!settings || !settings.clientId || !settings.clientSecret || !settings.tenantId) {
    throw new Error('Configuration Partner Center incomplète');
  }

  try {
    const response = await fetch(
      AUTH_URL_TEMPLATE(settings.tenantId),
      {
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
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error_description || `HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    graphTokenCache.token = data.access_token;
    // Expire 5 minutes before actual expiration
    graphTokenCache.expiry = Date.now() + (data.expires_in - 300) * 1000;

    return graphTokenCache.token;
  } catch (error) {
    throw new Error(`Échec de l'authentification: ${error.message}`);
  }
}

// Token for Partner Center API
async function getPartnerCenterAccessToken() {
  // Check whether the token is still valid (with a 5-minute margin)
  if (partnerCenterTokenCache.token && partnerCenterTokenCache.expiry && Date.now() < partnerCenterTokenCache.expiry) {
    return partnerCenterTokenCache.token;
  }

  const settings = await getPartnerCenterSettings();
  if (!settings || !settings.clientId || !settings.clientSecret || !settings.tenantId) {
    throw new Error('Configuration Partner Center incomplète');
  }

  try {
    const response = await fetch(
      AUTH_URL_TEMPLATE(settings.tenantId),
      {
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
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error_description || `HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    partnerCenterTokenCache.token = data.access_token;
    // Expire 5 minutes before actual expiration
    partnerCenterTokenCache.expiry = Date.now() + (data.expires_in - 300) * 1000;

    return partnerCenterTokenCache.token;
  } catch (error) {
    throw new Error(`Échec de l'authentification Partner Center: ${error.message}`);
  }
}

// Compatibility alias
async function getAccessToken() {
  return getGraphAccessToken();
}

// ───────────────────────────────────────────────
// 🔍 Function: decode the JWT token to verify permissions
// ───────────────────────────────────────────────
function decodeToken(token) {
  try {
    // A JWT has three dot-separated parts: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    
    // Decode the payload (base64url)
    const payload = parts[1];
    // Replace base64url characters with standard base64
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding if needed
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    
    return JSON.parse(decoded);
  } catch (error) {
    return null;
  }
}

// ───────────────────────────────────────────────
// 🔍 Function : Check permissions in token
// ───────────────────────────────────────────────
async function checkTokenPermissions() {
  try {
    const token = await getGraphAccessToken();
    const decoded = decodeToken(token);
    
    if (!decoded) {
      return {
        success: false,
        error: 'Impossible de décoder le token'
      };
    }
    
    // Application permissions are in "roles" or "scp"
    // For client_credentials, permissions are in "roles"
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

// ───────────────────────────────────────────────
// 📡 Utility function: Partner Center API call
// ───────────────────────────────────────────────
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
      
      // Create a more detailed error object
      const detailedError = new Error(errorMessage);
      detailedError.status = response.status;
      detailedError.statusText = response.statusText;
      detailedError.code = errorCode;
      detailedError.details = errorData.error || errorData;
      
      // Special message for 403 errors
      if (response.status === 403 && errorCode === 'Authorization_RequestDenied') {
        detailedError.permissionIssue = true;
        detailedError.suggestion = 'Le consentement administrateur n\'a peut-être pas été accordé. ' +
          'Vérifiez dans Azure Portal → App registrations → Votre app → API permissions → ' +
          'que toutes les permissions ont un statut "✓ Accordé pour [votre organisation]"';
      }
      
      throw detailedError;
    }

    return await response.json();
  } catch (error) {
    // If it is already our detailed error, rethrow it
    if (error.status) {
      throw error;
    }
    throw error;
  }
}

// Generate a UUID v4 for Partner Center headers
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function generateRequestId() {
  // Partner Center expects a UUID for MS-RequestId
  return generateUUID();
}

function generateCorrelationId() {
  // Partner Center expects a UUID for MS-CorrelationId
  return generateUUID();
}

// ───────────────────────────────────────────────
// 📡 Utility function: Partner Center API call
// ───────────────────────────────────────────────
async function callPartnerCenterApi(endpoint, method = 'GET', body = null) {
  const token = await getPartnerCenterAccessToken();
  const url = endpoint.startsWith('http') ? endpoint : `${PARTNER_CENTER_API_URL}${endpoint}`;

  // Partner Center requires UUIDs for the MS-RequestId and MS-CorrelationId headers
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
        // If this is not JSON, keep raw text
        errorData = { raw: errorText };
      }
      
      const errorMessage = errorData.error?.message || 
                          errorData.message || 
                          errorData.description || 
                          errorData.error_description ||
                          errorData.raw || 
                          response.statusText;
      const errorCode = errorData.error?.code || errorData.code || '';
      
      const detailedError = new Error(errorMessage);
      detailedError.status = response.status;
      detailedError.statusText = response.statusText;
      detailedError.code = errorCode;
      detailedError.details = errorData.error || errorData;
      detailedError.fullResponse = errorData;
      detailedError.endpoint = endpoint;
      detailedError.rawResponse = errorText; // Keep the raw response for diagnostics
      
      // Add extra information for 403 errors
      if (response.status === 403) {
        detailedError.permissionIssue = true;
        detailedError.suggestion = 'L\'API Partner Center nécessite une authentification App+User (application + utilisateur connecté) plutôt qu\'App-only (client_credentials).\n\n' +
          'Même si l\'application est ajoutée dans Partner Center, l\'endpoint /customers nécessite qu\'un utilisateur soit connecté.\n\n' +
          'SOLUTION : Implémenter l\'authentification App+User avec le flux OAuth 2.0 Authorization Code.\n' +
          '1. L\'utilisateur doit se connecter une fois pour obtenir un refresh token\n' +
          '2. Utiliser ce refresh token pour obtenir des access tokens\n' +
          '3. Les access tokens obtenus avec App+User ont accès aux clients CSP';
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

// ───────────────────────────────────────────────
// 📋 Function: fetch all partners (CSP clients)
// ───────────────────────────────────────────────
async function getAllPartnersFromAPI() {
  // Try several sources in order:
  // 1. Microsoft Graph /contracts (CSP customers — requires PartnerBilling.Read.All)
  // 2. Microsoft Graph /organization (organization information)
  // 3. Microsoft Graph /organization/relationships (organization relationships)
  // 4. Partner Center API /customers (CSP customers — requires app in Partner Center)
  // 5. Microsoft Graph /policies/crossTenantAccessPolicy/partners (Azure AD partners — requires Policy.Read.All)
  
  const testedEndpoints = [];
  const errors = [];
  
  // 1. Try Microsoft Graph /contracts for CSP clients
  // Requires PartnerBilling.Read.All (Application) with admin consent
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
      // No CSP contract found; continue trying other endpoints
      errors.push({ endpoint: 'Microsoft Graph /contracts', status: 'empty', message: 'Aucun contrat trouvé' });
    } else {
      errors.push({ endpoint: 'Microsoft Graph /contracts', status: 'unexpected', message: 'Structure de réponse inattendue', response: contractsResponse });
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
  
  // 2. Try Microsoft Graph /organization to fetch organization information
  try {
    testedEndpoints.push('Microsoft Graph /organization');
    const orgResponse = await callGraphApi('/organization');
    
    if (orgResponse.value && Array.isArray(orgResponse.value) && orgResponse.value.length > 0) {
      // Information can be extracted but this is not a client list
      // Continue to try other endpoints
    }
  } catch (orgError) {
    errors.push({ 
      endpoint: 'Microsoft Graph /organization', 
      status: orgError.status || 'error', 
      message: orgError.message 
    });
  }
  
  // 3. Try Microsoft Graph /organization/relationships (when available)
  try {
    testedEndpoints.push('Microsoft Graph /organization/relationships');
    const relationshipsResponse = await callGraphApi('/organization/relationships');
    
    if (relationshipsResponse.value && Array.isArray(relationshipsResponse.value) && relationshipsResponse.value.length > 0) {
      // Normalize organization relationships
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
    // When an endpoint may not exist, continue
    errors.push({ 
      endpoint: 'Microsoft Graph /organization/relationships', 
      status: relError.status || 'error', 
      message: relError.message 
    });
  }
  
  // 2. Try Partner Center API with several endpoints
  // Documentation: https://learn.microsoft.com/en-us/partner-center/developer/partner-center-rest-api-reference
  const partnerCenterEndpoints = [
    '/customers?size=40',
    '/customers',
    '/relationships',
    '/profiles/organization'
  ];
  
  let lastPartnerCenterError = null;
  
  for (const endpoint of partnerCenterEndpoints) {
    try {
      const response = await callPartnerCenterApi(endpoint);
    
      // The Partner Center API response may have different structures depending on the endpoint
      // For /customers: { "totalCount": number, "items": [...], "links": {...} }
      // For /relationships: the structure may differ
      // For /profiles/organization: partner organization information
      
      let allPartners = [];
      let partnersFound = false;
      
      // Check whether the response contains items (/customers structure)
      if (response.items && Array.isArray(response.items)) {
        allPartners = [...response.items];
        partnersFound = true;
        
        // Handle pagination if needed
        let hasMore = true;
        let currentResponse = response;
        
        while (hasMore) {
          const nextLink = currentResponse.links?.next;
          
          if (nextLink && nextLink.uri) {
            try {
              const nextEndpoint = nextLink.uri.startsWith('/') 
                ? nextLink.uri 
                : nextLink.uri.replace(PARTNER_CENTER_API_URL, '');
              
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
      } 
      // Check whether the response has a value property (OData structure)
      else if (response.value && Array.isArray(response.value)) {
        allPartners = response.value;
        partnersFound = true;
      }
      // Check whether this is directly an array
      else if (Array.isArray(response)) {
        allPartners = response;
        partnersFound = true;
      }
      // For /profiles/organization, organization information can be extracted
      else if (response.organizationProfile || response.companyProfile) {
        // This is an organization response, not a customer list
        // It can be used to verify that the API works
        partnersFound = false;
      }
      // Check totalCount = 0
      else if (response.totalCount !== undefined) {
        if (response.totalCount === 0) {
          return {
            partners: [],
            source: `Partner Center API (${endpoint})`,
            errorInfo: {
              type: 'empty',
              message: 'Aucun client CSP trouvé dans Partner Center',
              endpoint: endpoint,
              responseStructure: Object.keys(response)
            }
          };
        }
      }
      
      // If partners were found, normalize and return them
      if (partnersFound && allPartners.length > 0) {
        return {
          partners: normalizePartners(allPartners),
          source: `Partner Center API (${endpoint})`,
          errorInfo: null
        };
      }
      
      // If the response is valid but empty, continue with the next endpoint
      if (partnersFound && allPartners.length === 0) {
        continue;
      }
      
      // If the structure is unexpected but valid, continue
      continue;
      
    } catch (error) {
      // Store the last error for the final message with all details
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
      
      // If this is a 403 or 401 error, continue trying other endpoints
      // but keep it for the final message
      if (error.status === 403 || error.status === 401) {
        continue;
      }
      // For other errors, continue as well
      continue;
    }
  }
  
      // If all Partner Center endpoints failed, return error details
  if (lastPartnerCenterError) {
    // Build a detailed error message
    let errorMessage = '';
    if (lastPartnerCenterError.status === 403) {
      errorMessage = `Accès refusé (403) à l'API Partner Center - Endpoint: ${lastPartnerCenterError.endpoint}`;
      if (lastPartnerCenterError.message) {
        errorMessage += `\nMessage: ${lastPartnerCenterError.message}`;
      }
      if (lastPartnerCenterError.code) {
        errorMessage += `\nCode: ${lastPartnerCenterError.code}`;
      }
    } else if (lastPartnerCenterError.status === 401) {
      errorMessage = `Erreur d'authentification (401) avec Partner Center API - Endpoint: ${lastPartnerCenterError.endpoint}`;
      if (lastPartnerCenterError.message) {
        errorMessage += `\nMessage: ${lastPartnerCenterError.message}`;
      }
    } else {
      errorMessage = `Erreur avec Partner Center API - Endpoint: ${lastPartnerCenterError.endpoint}`;
      if (lastPartnerCenterError.message) {
        errorMessage += `\nMessage: ${lastPartnerCenterError.message}`;
      }
    }
    
    return {
      partners: [],
      source: 'Partner Center API',
      errorInfo: {
        type: lastPartnerCenterError.status === 403 ? 'permission' : (lastPartnerCenterError.status === 401 ? 'auth' : 'error'),
        status: lastPartnerCenterError.status,
        code: lastPartnerCenterError.code,
        message: errorMessage,
        endpoint: lastPartnerCenterError.endpoint,
        details: lastPartnerCenterError.details,
        fullResponse: lastPartnerCenterError.fullResponse,
        rawResponse: lastPartnerCenterError.rawResponse,
        suggestion: lastPartnerCenterError.status === 403
          ? '🔴 PROBLÈME IDENTIFIÉ : L\'API Partner Center /customers nécessite une authentification App+User\n\n' +
            'Même si votre application "Veritas Prod" est bien ajoutée dans Partner Center avec les rôles appropriés, l\'endpoint /customers nécessite qu\'un utilisateur soit connecté.\n\n' +
            '📋 DIFFÉRENCE ENTRE App-only ET App+User :\n' +
            '   • App-only (client_credentials) : L\'application s\'authentifie seule\n' +
            '     → Fonctionne pour certains endpoints, mais PAS pour /customers\n' +
            '   • App+User (authorization_code) : L\'application + un utilisateur connecté\n' +
            '     → Nécessaire pour accéder aux clients CSP via /customers\n\n' +
            '🔧 SOLUTION : Implémenter l\'authentification App+User\n\n' +
            'ÉTAPE 1 : Modifier le flux d\'authentification\n' +
            '   - Utiliser le flux OAuth 2.0 Authorization Code au lieu de client_credentials\n' +
            '   - L\'utilisateur doit se connecter une fois via une URL d\'autorisation\n' +
            '   - Récupérer un refresh token lors de la première connexion\n\n' +
            'ÉTAPE 2 : Utiliser le refresh token\n' +
            '   - Stocker le refresh token de manière sécurisée\n' +
            '   - Utiliser ce refresh token pour obtenir des access tokens\n' +
            '   - Les access tokens obtenus avec App+User ont accès aux clients CSP\n\n' +
            '📚 Documentation :\n' +
            '   - https://learn.microsoft.com/fr-fr/partner-center/developer/partner-center-authentication\n' +
            '   - Section "App+User authentication"\n\n' +
            '💡 ALTERNATIVE : Utiliser Microsoft Graph /contracts\n' +
            '   Si vous ajoutez la permission PartnerBilling.Read.All (Application) dans Microsoft Graph,\n' +
            '   vous pouvez récupérer les clients CSP via l\'endpoint /contracts sans App+User.'
          : lastPartnerCenterError.status === 401
          ? 'Erreur d\'authentification. Vérifiez que le token d\'accès est valide et que l\'application est correctement configurée dans Partner Center.'
          : `Erreur avec Partner Center API.\n\n` +
            `Détails de l'erreur :\n` +
            `- Endpoint: ${lastPartnerCenterError.endpoint}\n` +
            `- Statut: ${lastPartnerCenterError.status}\n` +
            `- Message: ${lastPartnerCenterError.message || 'Aucun message'}\n` +
            (lastPartnerCenterError.rawResponse ? `\nRéponse brute de l'API:\n${lastPartnerCenterError.rawResponse.substring(0, 500)}` : '')
      }
    };
  }
  
  // 4. Try Microsoft Graph /policies/crossTenantAccessPolicy/partners (with Policy.Read.All)
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
      // No partners in cross-tenant access policies
      errors.push({ 
        endpoint: 'Microsoft Graph /policies/crossTenantAccessPolicy/partners', 
        status: 'empty', 
        message: 'Aucun partenaire configuré dans les politiques d\'accès inter-locataires Azure AD' 
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
  
  // If all endpoints failed, return a detailed error with all tests performed
  return {
    partners: [],
    source: 'inconnue',
    errorInfo: {
      type: 'error',
      message: 'Aucun client partenaire trouvé après avoir testé tous les endpoints disponibles',
      testedEndpoints: testedEndpoints,
      errors: errors,
      details: 'Endpoints testés :\n' + testedEndpoints.map(e => `- ${e}`).join('\n') + '\n\n' +
               'Erreurs rencontrées :\n' + errors.map(e => `- ${e.endpoint}: ${e.status} - ${e.message}`).join('\n'),
      suggestion: 'IMPORTANT : Les clients CSP (ceux que vous voyez dans Partner Center) sont DIFFÉRENTS des partenaires dans les politiques d\'accès inter-locataires Azure AD.\n\n' +
                 'Pour récupérer vos clients CSP :\n' +
                 '→ Option 1 : Ajouter la permission PartnerBilling.Read.All (Application) dans Microsoft Graph\n' +
                 '   Azure Portal → App registrations → Votre app → API permissions → Ajouter PartnerBilling.Read.All (Application) → Accorder le consentement administrateur\n\n' +
                 '→ Option 2 : Ajouter l\'application dans Partner Center\n' +
                 '   Partner Center → Paramètres → Applications → Ajouter votre application Azure AD\n' +
                 '   Note : L\'API Partner Center peut nécessiter une authentification App+User plutôt qu\'App-only\n\n' +
                 'Pour récupérer les partenaires Azure AD (avec Policy.Read.All) :\n' +
                 '→ Configurer les partenaires dans Azure AD → External Identities → Cross-tenant access settings\n' +
                 '→ Ajouter le Tenant ID de chaque partenaire'
    }
  };
}

// Function to normalize partners from Microsoft Graph Cross-Tenant Access Policy
// Documentation: https://learn.microsoft.com/en-us/graph/api/crosstenantaccesspolicy-list-partners
function normalizePartnersFromGraphCrossTenant(partners) {
  return partners.map(partner => {
    const tenantId = partner.tenantId || '';
    
    // Try to fetch the tenant name from the sync identity when available
    const displayName = partner.identitySynchronization?.displayName || 
                       partner.displayName || 
                       `Tenant ${tenantId.substring(0, 8)}...`;
    
    return {
      partner_id: tenantId,
      company_name: displayName,
      domain: '', // Domains are not directly available in this response
      relationship_to_partner: partner.isInMultiTenantOrganization ? 'Multi-tenant organization' : 'Cross-tenant access',
      mpn_id: '',
      location_country: '',
      location_city: '',
      status: 'active',
      raw_data: partner
    };
  });
}

// Function to normalize partners from Microsoft Graph Contracts (CSP)
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

// Function to normalize partners from the Partner Center API
// Handle different response structures depending on the endpoint used
// - /customers : { "id": "...", "companyProfile": { "companyName": "...", "tenantId": "...", ... }, "relationshipToPartner": "..." }
// - /relationships: the structure may differ
function normalizePartners(partners) {
  return partners.map(partner => {
    // The client ID is in partner.id (unique client identifier in Partner Center)
    // The Azure AD tenantId is in partner.companyProfile.tenantId
    const customerId = partner.id || partner.customerId || partner.partnerId || '';
    const tenantId = partner.companyProfile?.tenantId || 
                     partner.tenantId || 
                     partner.companyProfile?.organizationId || 
                     '';
    
    // Use tenantId as the primary identifier when available, otherwise client ID
    const partnerId = tenantId || customerId;
    
    // Company name may appear in several fields depending on structure
    const companyName = partner.companyProfile?.companyName || 
                       partner.companyName || 
                       partner.name || 
                       partner.displayName ||
                       partner.organizationName ||
                       '';
    
    // Domain may appear in several fields
    const domain = partner.companyProfile?.domain || 
                  partner.domain || 
                  partner.companyProfile?.defaultDomainName ||
                  '';
    
    // MPN ID may appear in several fields
    const mpnId = partner.companyProfile?.mpnId || 
                 partner.mpnId || 
                 partner.partnerId ||
                 '';
    
    // Address may appear in several fields
    const country = partner.companyProfile?.address?.country || 
                   partner.address?.country || 
                   partner.country || 
                   partner.companyProfile?.country ||
                   '';
    const city = partner.companyProfile?.address?.city || 
                partner.address?.city || 
                partner.city || 
                partner.companyProfile?.city ||
                '';
    
    // Relationship to partner (reseller, indirect-reseller, etc.)
    const relationship = partner.relationshipToPartner || 
                       partner.relationship || 
                       partner.type ||
                       'reseller';

    return {
      partner_id: partnerId || customerId, // Use tenantId when available, otherwise customerId
      company_name: companyName || `Client ${customerId.substring(0, 8)}...`, // Fallback when no name is available
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


// ───────────────────────────────────────────────
// 🔄 Function: synchronize partners
// ───────────────────────────────────────────────
async function syncPartners() {
  try {
    // 1. Fetch all partners from the API
    const apiResult = await getAllPartnersFromAPI();
    const apiPartners = apiResult.partners || [];
    const source = apiResult.source;
    const errorInfo = apiResult.errorInfo;
    const testedEndpoints = apiResult.testedEndpoints || apiResult.errorInfo?.testedEndpoints || [];

    // 2. Fetch all partners in the database
    const dbResult = await pool.query('SELECT * FROM v_b_s_ms_partner');
    const dbPartners = dbResult.rows;
    const dbPartnersMap = new Map(dbPartners.map(p => [p.partner_id, p]));

    const stats = {
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0
    };

    // 3. Compare and synchronize
    const apiPartnersMap = new Map(apiPartners.map(p => [p.partner_id, p]));

    // Create or update API partners
    for (const apiPartner of apiPartners) {
      const dbPartner = dbPartnersMap.get(apiPartner.partner_id);

      if (!dbPartner) {
        // New partner to create
        await pool.query(
          `INSERT INTO v_b_s_ms_partner 
           (partner_id, company_name, domain, relationship_to_partner, mpn_id, 
            location_country, location_city, status, raw_data, last_synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
          [
            apiPartner.partner_id,
            apiPartner.company_name,
            apiPartner.domain,
            apiPartner.relationship_to_partner,
            apiPartner.mpn_id,
            apiPartner.location_country,
            apiPartner.location_city,
            apiPartner.status,
            JSON.stringify(apiPartner.raw_data)
          ]
        );
        stats.created++;
      } else {
        // Check whether updates are needed
        const hasChanges = 
          dbPartner.company_name !== apiPartner.company_name ||
          dbPartner.domain !== apiPartner.domain ||
          dbPartner.status !== apiPartner.status ||
          dbPartner.mpn_id !== apiPartner.mpn_id ||
          dbPartner.location_country !== apiPartner.location_country ||
          dbPartner.location_city !== apiPartner.location_city;

        if (hasChanges) {
          // Update partner
          await pool.query(
            `UPDATE v_b_s_ms_partner 
             SET company_name = $1, domain = $2, relationship_to_partner = $3,
                 mpn_id = $4, location_country = $5, location_city = $6,
                 status = $7, raw_data = $8, updated_at = NOW(), last_synced_at = NOW()
             WHERE partner_id = $9`,
            [
              apiPartner.company_name,
              apiPartner.domain,
              apiPartner.relationship_to_partner,
              apiPartner.mpn_id,
              apiPartner.location_country,
              apiPartner.location_city,
              apiPartner.status,
              JSON.stringify(apiPartner.raw_data),
              apiPartner.partner_id
            ]
          );
          stats.updated++;
        } else {
          // Update only last_synced_at
          await pool.query(
            'UPDATE v_b_s_ms_partner SET last_synced_at = NOW() WHERE partner_id = $1',
            [apiPartner.partner_id]
          );
          stats.unchanged++;
        }
      }
    }

    // 4. Identify deleted partners (mark as inactive)
    for (const dbPartner of dbPartnersMap.values()) {
      if (!apiPartnersMap.has(dbPartner.partner_id)) {
        await pool.query(
          'UPDATE v_b_s_ms_partner SET status = $1, updated_at = NOW() WHERE partner_id = $2',
          ['inactive', dbPartner.partner_id]
        );
        stats.deleted++;
      }
    }
    
    // Warning message when no partner is found
    let warning = null;
    let diagnosticMessage = null;
    
    if (apiPartners.length === 0) {
      warning = 'Aucun partenaire trouvé dans l\'API.\n\n';
      
      if (errorInfo) {
        warning += `Source testée: ${source || 'inconnue'}\n\n`;
        
        if (errorInfo.testedEndpoints && errorInfo.testedEndpoints.length > 0) {
          warning += 'Endpoints testés :\n';
          errorInfo.testedEndpoints.forEach(endpoint => {
            warning += `- ${endpoint}\n`;
          });
          warning += '\n';
        }
        
        if (errorInfo.errors && errorInfo.errors.length > 0) {
          warning += 'Erreurs rencontrées :\n';
          errorInfo.errors.forEach(err => {
            warning += `- ${err.endpoint}: ${err.status} - ${err.message || 'Aucun message'}\n`;
          });
          warning += '\n';
        }
        
        if (errorInfo.suggestion) {
          warning += errorInfo.suggestion;
        } else {
          warning += 'Les clients que vous voyez dans Partner Center nécessitent probablement ' +
                    'une authentification App+User (application + utilisateur connecté) ' +
                    'plutôt qu\'une authentification App-only (client_credentials uniquement).\n\n' +
                    'Pour récupérer vos clients CSP, il faut implémenter l\'authentification App+User ' +
                    'avec le flux OAuth 2.0 Authorization Code.';
        }
      } else {
        warning += 'Les clients que vous voyez dans Partner Center nécessitent probablement ' +
                  'une authentification App+User (application + utilisateur connecté) ' +
                  'plutôt qu\'une authentification App-only (client_credentials uniquement).\n\n' +
                  'Pour récupérer vos clients CSP, il faut implémenter l\'authentification App+User ' +
                  'avec le flux OAuth 2.0 Authorization Code.';
      }
      
      diagnosticMessage = {
        source: source,
        errorInfo: errorInfo,
        testedEndpoints: testedEndpoints,
        suggestion: errorInfo?.suggestion || 'Vérifiez les permissions et la configuration de l\'application'
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

// ───────────────────────────────────────────────
// 📋 Function: fetch Azure AD application information
// ───────────────────────────────────────────────
async function getApplicationInfo(clientId) {
  try {
    // Fetch application information via Microsoft Graph
    // We can use /applications with a filter on appId
    const response = await callGraphApi(`/applications?$filter=appId eq '${clientId}'`);
    
    if (response.value && response.value.length > 0) {
      const app = response.value[0];
      const appName = app.displayName || app.appDisplayName || 'Application inconnue';
      
      // Fetch secrets/password credentials
      let secretExpiry = null;
      let secretError = null;
      try {
        const credentialsResponse = await callGraphApi(`/applications/${app.id}/passwordCredentials`);
        if (credentialsResponse.value && credentialsResponse.value.length > 0) {
          // Find the matching secret (cannot compare directly, so take the most recent one)
          const secrets = credentialsResponse.value.sort((a, b) => {
            const dateA = a.endDateTime ? new Date(a.endDateTime) : new Date(0);
            const dateB = b.endDateTime ? new Date(b.endDateTime) : new Date(0);
            return dateB - dateA; // Most recent first
          });
          
          if (secrets.length > 0 && secrets[0].endDateTime) {
            secretExpiry = secrets[0].endDateTime;
          }
        }
      } catch (credError) {
        secretError = credError.status === 403 
          ? 'Permissions insuffisantes (Application.Read.All requis)'
          : credError.message;
        // Continue without expiration date
      }
      
      return {
        appName,
        secretExpiry,
        secretError
      };
    }
    
    return {
      appName: 'Application non trouvée',
      secretExpiry: null,
      secretError: null
    };
  } catch (error) {
    // If this is a 403 error, provide more details
    if (error.status === 403) {
      const isConsentIssue = error.code === 'Authorization_RequestDenied';
      return {
        appName: isConsentIssue 
          ? 'Erreur 403: Consentement administrateur requis'
          : 'Erreur 403: Permissions insuffisantes',
        secretExpiry: null,
        secretError: isConsentIssue
          ? 'Le consentement administrateur n\'a pas été accordé. Cliquez sur "Grant admin consent" dans Azure Portal.'
          : `Permission manquante: Application.Read.All (type Application, pas Déléguée)`,
        permissionError: true,
        consentIssue: isConsentIssue
      };
    }
    
    return {
      appName: `Erreur: ${error.message}`,
      secretExpiry: null,
      secretError: null
    };
  }
}

// ───────────────────────────────────────────────
// 🧪 Route: connection test
// ───────────────────────────────────────────────
router.post('/test', async (req, res) => {
  try {
    const settings = await getPartnerCenterSettings();
    
    if (!settings || !settings.clientId || !settings.clientSecret || !settings.tenantId) {
      return res.status(400).json({
        success: false,
        error: 'Configuration incomplète',
        details: 'Veuillez configurer APP_ID, SECRET_ID et TENANT_ID dans les paramètres Entra ID'
      });
    }

    // Test Microsoft Graph authentication (for application info)
    const graphToken = await getGraphAccessToken();
    
    if (!graphToken) {
      return res.status(401).json({
        success: false,
        error: 'Échec de l\'authentification Microsoft Graph',
        details: 'Impossible d\'obtenir un token d\'accès'
      });
    }

    // Test Partner Center authentication
    let partnerCenterToken = null;
    try {
      partnerCenterToken = await getPartnerCenterAccessToken();
    } catch (pcError) {
      // Continue anyway to test Graph
    }

    // Fetch application information
    const appInfo = await getApplicationInfo(settings.clientId);
    
    // Check whether the app is multi-tenant (required to access customer tenants)
    let multiTenantInfo = null;
    try {
      const graphToken = await getGraphAccessToken();
      const appResponse = await fetch(
        `${GRAPH_API_URL}/applications?$filter=appId eq '${settings.clientId}'&$select=id,appId,displayName,signInAudience`,
        {
          headers: {
            'Authorization': `Bearer ${graphToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
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
    } catch (mtError) {
      // Ignore the error
    }

    // Check permissions in token
    const tokenPermissions = await checkTokenPermissions();
    
    // Try to fetch partners for the test
    try {
      const result = await getAllPartnersFromAPI();
      const partners = result.partners || [];
      const source = result.source;
      const errorInfo = result.errorInfo;
      
      if (partners.length === 0) {
        // Authentication succeeded but no partner was found
        let warning = 'Aucun partenaire trouvé.\n\n' +
                     '📋 TYPES DE PARTENAIRES (IMPORTANT - Ce sont des choses différentes !) :\n\n' +
                     '1. CLIENTS CSP PARTNER CENTER (ce que vous voyez dans Partner Center)\n' +
                     '   → Endpoints testés:\n' +
                     '     - Microsoft Graph /contracts (contrats CSP)\n' +
                     '     - Partner Center API /customers\n' +
                     '   → Ce sont les clients que vous voyez dans Partner Center → Clients\n' +
                     '   → Permissions: PartnerBilling.Read.All, CrossTenantInformation.ReadBasic.All\n' +
                     '   → ⚠️ Ces clients sont DIFFÉRENTS des partenaires dans les politiques d\'accès inter-locataires\n\n' +
                     '2. PARTENAIRES POLITIQUES D\'ACCÈS INTER-LOCATAIRES (Azure AD)\n' +
                     '   → Endpoint: /policies/crossTenantAccessPolicy/partners\n' +
                     '   → Liste les partenaires dans les politiques d\'accès inter-locataires Azure AD\n' +
                     '   → Permission requise: Policy.Read.All (Application)\n' +
                     '   → ⚠️ Ce sont des partenaires configurés dans Azure AD → External Identities\n' +
                     '   → Documentation: https://learn.microsoft.com/en-us/graph/api/crosstenantaccesspolicy-list-partners\n\n';
        
        if (!partnerCenterToken) {
          warning += '⚠️ Authentification Partner Center échouée. Vérifiez que :\n' +
                     '- Les permissions "Application" sont configurées pour Partner Center API\n' +
                     '- Le consentement administrateur a été accordé\n' +
                     '- L\'application est ajoutée dans Partner Center';
        } else {
          // Use detailed error information when available
          if (errorInfo && errorInfo.type === 'permission') {
            warning += `❌ ERREUR DÉTECTÉE : ${errorInfo.message}\n\n` +
                     '🔴 PERMISSION MICROSOFT GRAPH MANQUANTE\n\n' +
                     `Code d'erreur: ${errorInfo.code || 'Authorization_RequestDenied'}\n` +
                     `Statut HTTP: ${errorInfo.status}\n\n` +
                     '🔧 SOLUTION IMMÉDIATE :\n' +
                     '1. Azure Portal → App registrations → Votre application\n' +
                     '2. Onglet "API permissions" → "Add a permission"\n' +
                     '3. Sélectionner "Microsoft Graph" → "Application permissions"\n' +
                     '4. Rechercher et ajouter "Policy.Read.All"\n' +
                     '5. Cliquer sur "Grant admin consent for [votre organisation]"\n' +
                     '6. Attendre quelques secondes pour la propagation\n' +
                     '7. Re-tester la connexion\n\n' +
                     '📝 Documentation: https://learn.microsoft.com/en-us/graph/api/crosstenantaccesspolicy-list-partners';
          } else if (errorInfo && errorInfo.type === 'empty') {
            warning += `ℹ️ INFORMATION : ${errorInfo.message}\n\n` +
                     '✅ Microsoft Graph fonctionne correctement, mais aucun partenaire n\'est configuré.\n\n' +
                     '🔧 POUR AJOUTER DES PARTENAIRES :\n' +
                     '1. Azure Portal → Azure Active Directory → External Identities\n' +
                     '2. Cross-tenant access settings → Add partner organization\n' +
                     '3. Entrer le Tenant ID du partenaire\n' +
                     '4. Configurer les paramètres d\'accès\n' +
                     '5. Sauvegarder\n\n' +
                     'OU utilisez Partner Center API pour récupérer les clients CSP.';
          } else {
            warning += '✅ Authentification réussie, mais aucun client CSP trouvé.\n\n' +
                     '🔴 PROBLÈMES POSSIBLES :\n\n' +
                     '1. ENDPOINT MICROSOFT GRAPH /contracts NE RETOURNE PAS DE DONNÉES\n' +
                     '   → Vous avez les permissions (PartnerBilling.Read.All, etc.)\n' +
                     '   → Mais /contracts retourne un tableau vide\n' +
                     '   → Cela peut signifier que les contrats CSP ne sont pas accessibles via cet endpoint\n' +
                     '   → OU que l\'endpoint nécessite des paramètres supplémentaires\n\n' +
                     '2. PARTNER CENTER API /customers RETOURNE 403\n' +
                     '   → L\'API Partner Center peut nécessiter une authentification "App+User"\n' +
                     '   → L\'authentification actuelle est "App-only" (client_credentials uniquement)\n' +
                     '   → Même si l\'application est ajoutée dans Partner Center\n\n' +
                     '3. ENDPOINT INCORRECT\n' +
                     '   → Les clients que vous voyez dans Partner Center peuvent nécessiter un endpoint différent\n' +
                     '   → Ou une configuration supplémentaire dans Partner Center\n\n' +
                     '🔧 SOLUTIONS À ESSAYER :\n\n' +
                     'OPTION 1 : Vérifier les logs serveur\n' +
                     '   → Regardez les logs pour voir exactement ce que retournent les endpoints\n' +
                     '   → Vérifiez si /contracts retourne vraiment un tableau vide ou une erreur\n\n' +
                     'OPTION 2 : Utiliser l\'API Partner Center avec authentification App+User\n' +
                     '   → Modifier le code pour utiliser le flux OAuth 2.0 Authorization Code\n' +
                     '   → Un utilisateur doit se connecter une fois pour obtenir un refresh token\n' +
                     '   → Utiliser ce refresh token pour obtenir des access tokens\n\n' +
                     'OPTION 3 : Vérifier la configuration dans Partner Center\n' +
                     '   → Partner Center → Paramètres → Applications → Votre application\n' +
                     '   → Vérifiez que l\'application a les rôles nécessaires (ex: "Customer management")\n' +
                     '   → Vérifiez que l\'application est activée et approuvée\n\n' +
                     'OPTION 4 : Essayer d\'autres endpoints Microsoft Graph\n' +
                     '   → Peut-être que les clients CSP sont accessibles via un autre endpoint\n' +
                     '   → Consultez la documentation Microsoft Graph pour les endpoints CSP\n\n' +
                     '📝 Note : Les clients que vous voyez dans Partner Center → Clients sont des clients CSP.\n' +
                     '   Ils sont différents des partenaires dans les politiques d\'accès inter-locataires Azure AD.';
          }
          
          if (source) {
            warning += `\n\n📊 Source testée : ${source}`;
          }
        }
        warning += '\n\nConsultez les logs serveur pour plus de détails sur les endpoints testés.';
        
        return res.json({
        success: true,
        message: 'Authentification réussie',
        partnersCount: 0,
        tenantId: settings.tenantId,
        appName: appInfo.appName,
        secretExpiry: appInfo.secretExpiry,
        secretError: appInfo.secretError,
        permissionError: appInfo.permissionError || (errorInfo && errorInfo.type === 'permission'),
        partnerCenterAuth: !!partnerCenterToken,
        multiTenantInfo: multiTenantInfo,
        adminConsentUrl: multiTenantInfo && !multiTenantInfo.isMultiTenant 
          ? `https://login.microsoftonline.com/organizations/adminconsent?client_id=${settings.clientId}`
          : null,
        source: source,
        errorInfo: errorInfo,
        tokenPermissions: tokenPermissions,
        warning: warning
        });
      }
      
      return res.json({
        success: true,
        message: `Connexion réussie - ${source || 'API'}`,
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
      // If auth works but the API fails, it may be a permissions issue
      let permissionMessage = '';
      if (apiError.status === 403 && apiError.code === 'Authorization_RequestDenied') {
        permissionMessage = '\n\n❌ ERREUR 403 - CONSENTEMENT ADMINISTRATEUR REQUIS\n\n' +
          'Les permissions sont ajoutées mais le CONSENTEMENT ADMINISTRATEUR n\'a pas été accordé.\n\n' +
          'ÉTAPES À SUIVRE :\n' +
          '1. Azure Portal → Azure Active Directory → App registrations → Votre application\n' +
          '2. API permissions → Vérifier que toutes vos permissions Application sont listées\n' +
          '   - Pour Microsoft Graph : Application.Read.All (pour les infos de l\'application)\n' +
          '   - Pour Partner Center API : Les permissions nécessaires pour accéder aux clients\n' +
          '3. Chercher la colonne "Status" pour chaque permission\n' +
          '4. Si vous voyez "⚠️ Requires admin consent" ou "Not granted", cliquez sur "Grant admin consent for [votre organisation]"\n' +
          '5. Attendez quelques secondes pour la propagation\n' +
          '6. Re-testez la connexion\n\n' +
          'IMPORTANT :\n' +
          '- Le bouton "Grant admin consent" doit être cliqué pour CHAQUE permission Application\n' +
          '- Vous devez être administrateur Azure AD pour accorder le consentement\n' +
          '- Il peut y avoir un délai de quelques minutes pour la propagation\n' +
          '- Assurez-vous que l\'application est ajoutée dans Partner Center\n\n' +
          'Vérifiez que le statut affiche "✓ Accordé pour [votre organisation]" (pas juste "✓ Accordé pour PSI")';
      } else if (apiError.status === 403) {
        let multiTenantWarning = '';
        if (multiTenantInfo && !multiTenantInfo.isMultiTenant) {
          multiTenantWarning = '\n\n⚠️ APPLICATION NON MULTI-TENANT DÉTECTÉE\n' +
            'Votre application n\'est pas configurée comme multi-tenant.\n' +
            'Cela peut causer l\'erreur : "The client application TenantID is missing service principal in the tenant CustomerTenantID"\n\n' +
            '🔧 SOLUTION :\n' +
            '1. Azure Portal → App registrations → Votre application → Authentication\n' +
            '2. Section "Supported account types"\n' +
            '3. Sélectionner "Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)"\n' +
            '4. Sauvegarder\n' +
            '5. Pour chaque tenant client, exécuter :\n' +
            `   https://login.microsoftonline.com/{CustomerTenantID}/adminconsent?client_id=${settings.clientId}\n\n`;
        }
        
        permissionMessage = '\n\n🔴 ERREUR 403 - ACCÈS REFUSÉ\n\n' +
          multiTenantWarning +
          'L\'authentification fonctionne, mais l\'accès aux données est refusé.\n\n' +
          '📋 CAUSES POSSIBLES :\n\n' +
          '1. APPLICATION NON MULTI-TENANT\n' +
          '   → L\'application doit être configurée comme multi-tenant\n' +
          '   → Le Service Principal doit être créé dans chaque tenant client via adminconsent\n\n' +
          '2. AUTHENTIFICATION APP+USER REQUISE\n' +
          '   → L\'API Partner Center peut nécessiter une authentification "App+User" (application + utilisateur)\n' +
          '   → L\'authentification actuelle est "App-only" (client_credentials uniquement)\n\n' +
          '3. PERMISSIONS INSUFFISANTES\n' +
          '   → Les permissions nécessaires ne sont pas accordées\n' +
          '   → Le consentement administrateur n\'a pas été accordé\n\n' +
          '🔧 SOLUTIONS :\n\n' +
          'ÉTAPE 1 : Configurer l\'application comme multi-tenant\n' +
          '1. Azure Portal → App registrations → Votre application → Authentication\n' +
          '2. Sélectionner "Accounts in any organizational directory (Multitenant)"\n' +
          '3. Sauvegarder\n\n' +
          'ÉTAPE 2 : Créer les Service Principals dans les tenants clients\n' +
          'Pour chaque tenant client, un administrateur global doit visiter :\n' +
          `   https://login.microsoftonline.com/{CustomerTenantID}/adminconsent?client_id=${settings.clientId}\n\n` +
          'OU pour tous les tenants de l\'organisation :\n' +
          `   https://login.microsoftonline.com/organizations/adminconsent?client_id=${settings.clientId}\n\n` +
          'ÉTAPE 3 : Vérifier les permissions\n' +
          '1. Azure Portal → App registrations → Votre app → API permissions\n' +
          '2. Pour Microsoft Graph /policies/crossTenantAccessPolicy/partners :\n' +
          '   → Ajouter la permission "Policy.Read.All" (Application)\n' +
          '   → Documentation: https://learn.microsoft.com/en-us/graph/api/crosstenantaccesspolicy-list-partners\n' +
          '3. Accorder le consentement administrateur\n\n' +
          'ÉTAPE 4 : Vérifier dans Partner Center (si vous utilisez Partner Center API)\n' +
          '1. Partner Center → Paramètres → Applications → Votre application\n' +
          '2. Vérifiez que l\'application est ajoutée, activée et a les rôles nécessaires\n\n' +
          '📝 NOTE IMPORTANTE :\n' +
          '   - Microsoft Graph /policies/crossTenantAccessPolicy/partners liste les partenaires dans les\n' +
          '     politiques d\'accès inter-locataires Azure AD (cross-tenant access policies)\n' +
          '   - Partner Center API /customers liste les clients/partenaires dans Partner Center (CSP)\n' +
          '   - Ce sont deux types de partenaires différents !\n' +
          '   - Si le problème persiste, l\'API Partner Center peut nécessiter une authentification App+User';
      }
      
      return res.json({
        success: true,
        message: 'Authentification réussie',
        partnersCount: 0,
        warning: 'Impossible de récupérer les partenaires. Vérifiez les permissions de l\'application.' + permissionMessage,
        tenantId: settings.tenantId,
        appName: appInfo.appName,
        secretExpiry: appInfo.secretExpiry,
        secretError: appInfo.secretError,
        permissionError: appInfo.permissionError || apiError.status === 403,
        consentIssue: appInfo.consentIssue || (apiError.status === 403 && apiError.code === 'Authorization_RequestDenied'),
        details: apiError.message || apiError.details?.message,
        errorCode: apiError.code,
        multiTenantInfo: multiTenantInfo,
        adminConsentUrl: multiTenantInfo && !multiTenantInfo.isMultiTenant 
          ? `https://login.microsoftonline.com/organizations/adminconsent?client_id=${settings.clientId}`
          : null,
        tokenPermissions: tokenPermissions,
        suggestion: (apiError.status === 403 && apiError.code === 'Authorization_RequestDenied') 
          ? 'ÉTAPES IMPORTANTES :\n' +
            '1. Azure Portal → App registrations → Votre app → API permissions\n' +
            '2. Vérifiez que chaque permission Application a le statut "✓ Accordé pour [votre organisation]"\n' +
            '3. Si vous voyez "⚠️ Requires admin consent", cliquez sur "Grant admin consent for [votre organisation]"\n' +
            '4. Attendez 1-2 minutes pour la propagation\n' +
            '5. Re-testez la connexion\n\n' +
            'Les permissions suivantes doivent être accordées (type Application) :\n' +
            '- Application.Read.All\n' +
            '- Policy.Read.All ou Policy.ReadWrite.CrossTenantAccess'
          : 'Vérifiez que l\'application Azure AD a les permissions suivantes (type APPLICATION) :\n' +
            '- Microsoft Graph API : Policy.Read.All ou Policy.ReadWrite.CrossTenantAccess (Application)\n' +
            '- Microsoft Graph API : Application.Read.All (Application)\n' +
            '- Le consentement administrateur doit être accordé pour chaque permission'
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Erreur de connexion à Microsoft Graph API',
      details: error.message
    });
  }
});

// ───────────────────────────────────────────────
// 📋 Route: fetch all partners
// ───────────────────────────────────────────────
router.get('/partners', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM v_b_s_ms_partner ORDER BY company_name');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ───────────────────────────────────────────────
// 🔄 Route: synchronize partners
// ───────────────────────────────────────────────
router.post('/partners/sync', async (req, res) => {
  try {
    const result = await syncPartners();
    
    // Add extra diagnostic information
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
      suggestion: 'Les clients que vous voyez dans Partner Center nécessitent probablement ' +
                  'une authentification App+User. Consultez les détails ci-dessous pour plus d\'informations.',
      diagnostic: {
        errorType: error.name,
        errorMessage: error.message,
        errorStack: error.stack
      }
    });
  }
});

// ───────────────────────────────────────────────
// 📊 Route: synchronization statistics
// ───────────────────────────────────────────────
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
    res.status(500).json({ error: error.message });
  }
});

export default router;

