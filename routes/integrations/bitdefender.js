import express from 'express';
import { pool } from '../../database/db.js';
import fetch from 'node-fetch';
import verifyJWT from '../../middleware/auth.js';
import { resolveBitdefenderCredentials, getGlobalBitdefenderConfigStatus } from '../../utils/bitdefenderCredentials.js';
const router = express.Router();
router.use(verifyJWT);
async function getCredentialsFromRequest(req) {
  const bodyUrl = (req.body?.BITDEFENDER_API_URL || req.body?.apiUrl || "").trim();
  const bodyKey = (req.body?.BITDEFENDER_API_KEY || req.body?.apiKey || "").trim();
  if (bodyUrl && bodyKey) {
    return {
      apiUrl: bodyUrl,
      apiKey: bodyKey,
      source: "inline"
    };
  }
  const clientId = req.query.clientId || req.body?.clientId || null;
  const bitdefenderTenantId = req.query.bitdefenderTenantId || req.body?.bitdefenderTenantId || null;
  return resolveBitdefenderCredentials({
    clientId,
    bitdefenderTenantId
  });
}
function parseAccountsList(accountsResult) {
  if (Array.isArray(accountsResult)) return accountsResult;
  if (accountsResult?.items && Array.isArray(accountsResult.items)) return accountsResult.items;
  if (accountsResult?.accounts && Array.isArray(accountsResult.accounts)) return accountsResult.accounts;
  if (accountsResult?.data && Array.isArray(accountsResult.data)) return accountsResult.data;
  return [];
}
async function fetchGravityZoneCompanies(apiUrl, apiKey, {
  includeDetails = false
} = {}) {
  const accountsResult = await bitdefenderRpcCall(apiUrl, apiKey, "accounts", "getAccountsList", {});
  const accounts = parseAccountsList(accountsResult);
  const companyById = new Map();
  for (const acc of accounts) {
    if (!acc.companyId || companyById.has(acc.companyId)) continue;
    companyById.set(acc.companyId, {
      id: acc.companyId,
      _id: acc.companyId,
      name: acc.companyName || "Entreprise sans nom",
      country: null
    });
  }
  if (includeDetails) {
    await Promise.all([...companyById.keys()].map(async companyId => {
      const entry = companyById.get(companyId);
      try {
        const companyDetails = await bitdefenderRpcCall(apiUrl, apiKey, "companies", "getCompanyDetails", {
          companyId
        });
        if (companyDetails && entry) {
          entry.name = companyDetails.name || entry.name;
          entry.country = companyDetails.country || companyDetails.countryCode || null;
          entry.type = companyDetails.type ?? null;
          entry.canBeManagedByAbove = companyDetails.canBeManagedByAbove ?? null;
        }
      } catch {}
    }));
  }
  const companies = [...companyById.values()];
  const seenNames = new Set();
  for (const account of accounts) {
    if (account.companyId || !account.companyName) continue;
    const normalized = account.companyName.toLowerCase();
    if (seenNames.has(normalized)) continue;
    seenNames.add(normalized);
    const companyNameKey = `name_${normalized.replace(/[^a-z0-9]/g, "_")}`;
    companies.push({
      id: companyNameKey,
      _id: companyNameKey,
      name: account.companyName,
      country: account.country || null,
      isFromAccount: true
    });
  }
  companies.sort((a, b) => (a.name || "").localeCompare(b.name || "", "fr", {
    sensitivity: "base"
  }));
  return {
    accounts,
    companies
  };
}
function summarizeLicense(licenseInfo) {
  if (!licenseInfo) return null;
  let total = licenseInfo.totalSlots ?? licenseInfo.totalLicenses ?? licenseInfo.total ?? null;
  let used = licenseInfo.usedSlots ?? licenseInfo.usedLicenses ?? licenseInfo.used ?? null;
  if (licenseInfo.slots && typeof licenseInfo.slots === "object") {
    if (total == null) total = licenseInfo.slots.total ?? null;
    if (used == null) used = licenseInfo.slots.used ?? null;
  }
  let expirationDate = licenseInfo.expirationDate || licenseInfo.expiration || null;
  if (!expirationDate && licenseInfo.validity?.endDate) {
    expirationDate = licenseInfo.validity.endDate;
  }
  return {
    total,
    used,
    expirationDate
  };
}
function normalizePaginatedResult(result) {
  if (!result) return {
    items: [],
    total: 0,
    page: 1,
    pagesCount: 0
  };
  if (Array.isArray(result)) return {
    items: result,
    total: result.length,
    page: 1,
    pagesCount: 1
  };
  const items = result.items || result.list || result.recommendations || [];
  return {
    items: Array.isArray(items) ? items : [],
    total: result.total ?? (Array.isArray(items) ? items.length : 0),
    page: result.page ?? 1,
    pagesCount: result.pagesCount ?? 1
  };
}
async function safeBitdefenderRpc(apiUrl, apiKey, apiName, method, params = {}) {
  try {
    const data = await bitdefenderRpcCall(apiUrl, apiKey, apiName, method, params);
    return {
      ok: true,
      data
    };
  } catch (error) {
    const message = error.message || String(error);
    const permissionDenied = /not allowed|forbidden|403|access denied|permission/i.test(message);
    return {
      ok: false,
      error: message,
      permissionDenied
    };
  }
}
function buildApiSection(id, label, exploited, result, mapper) {
  if (!result?.ok) {
    return {
      id,
      label,
      exploited,
      status: result?.permissionDenied ? "permission_denied" : "error",
      error: result?.error || "API error",
      items: [],
      total: 0
    };
  }
  const normalized = normalizePaginatedResult(result.data);
  const items = mapper ? normalized.items.map(mapper).filter(Boolean) : normalized.items;
  return {
    id,
    label,
    exploited,
    status: items.length > 0 ? "ok" : "empty",
    items,
    total: normalized.total || items.length,
    page: normalized.page,
    pagesCount: normalized.pagesCount
  };
}
function createAuthHeader(apiKey) {
  const encoded = Buffer.from(`${apiKey}:`).toString('base64');
  return `Basic ${encoded}`;
}
async function bitdefenderRpcCall(apiUrl, apiKey, apiName, method, params = {}) {
  const url = `${apiUrl}/v1.0/jsonrpc/${apiName}`;
  const requestBody = {
    id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    jsonrpc: "2.0",
    method: method,
    params: params
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': createAuthHeader(apiKey)
    },
    body: JSON.stringify(requestBody)
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`);
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || 'BitDefender API error');
  }
  return data.result;
}
router.get('/config', async (_req, res) => {
  try {
    const status = await getGlobalBitdefenderConfigStatus();
    res.json({
      success: true,
      ...status
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
router.post('/sync/:companyId', async (req, res) => {
  try {
    const {
      companyId
    } = req.params;
    let apiKey;
    let apiUrl;
    try {
      const creds = await getCredentialsFromRequest(req);
      apiKey = creds.apiKey;
      apiUrl = creds.apiUrl;
    } catch (credErr) {
      return res.status(400).json({
        success: false,
        error: credErr.message
      });
    }
    let allEndpoints = [];
    let currentPage = 1;
    const perPage = 100;
    let hasMorePages = true;
    while (hasMorePages) {
      try {
        const pageResult = await bitdefenderRpcCall(apiUrl, apiKey, 'network', 'getEndpointsList', {
          parentId: companyId,
          page: currentPage,
          perPage: perPage,
          filters: {
            depth: {
              allItemsRecursively: true
            }
          }
        });
        if (pageResult && Array.isArray(pageResult.items)) {
          const items = pageResult.items;
          if (items.length > 0) {
            allEndpoints = allEndpoints.concat(items);
            const total = pageResult.total || 0;
            const pagesCount = pageResult.pagesCount || 0;
            if (items.length < perPage) {
              hasMorePages = false;
            } else if (total > 0 && allEndpoints.length >= total) {
              hasMorePages = false;
            } else if (pagesCount > 0 && currentPage >= pagesCount) {
              hasMorePages = false;
            } else {
              currentPage++;
            }
          } else {
            hasMorePages = false;
          }
        } else {
          hasMorePages = false;
        }
        if (currentPage > 100) {
          hasMorePages = false;
        }
      } catch (error) {
        hasMorePages = false;
      }
    }
    let companyInfo = null;
    try {
      companyInfo = await bitdefenderRpcCall(apiUrl, apiKey, 'companies', 'getCompanyDetails', {
        companyId: companyId
      });
    } catch (error) {}
    let licenseInfo = null;
    try {
      licenseInfo = await bitdefenderRpcCall(apiUrl, apiKey, 'licensing', 'getLicenseInfo', {
        companyId: companyId
      });
    } catch (error) {}
    const physicalCount = allEndpoints.filter(e => e.machineType === 1).length;
    const virtualCount = allEndpoints.filter(e => e.machineType === 2 || e.machineType === 3).length;
    let formattedLicense = null;
    if (licenseInfo) {
      let totalSlots = null;
      let usedSlots = null;
      if (licenseInfo.totalSlots !== undefined && licenseInfo.totalSlots !== null) {
        totalSlots = licenseInfo.totalSlots;
      } else if (licenseInfo.slots !== undefined && licenseInfo.slots !== null) {
        if (typeof licenseInfo.slots === 'object' && licenseInfo.slots.total !== undefined) {
          totalSlots = licenseInfo.slots.total;
        } else if (typeof licenseInfo.slots === 'number') {
          totalSlots = licenseInfo.slots;
        }
      } else if (licenseInfo.total !== undefined && licenseInfo.total !== null) {
        totalSlots = licenseInfo.total;
      }
      if (licenseInfo.usedSlots !== undefined && licenseInfo.usedSlots !== null) {
        usedSlots = licenseInfo.usedSlots;
      } else if (licenseInfo.slots !== undefined && licenseInfo.slots !== null) {
        if (typeof licenseInfo.slots === 'object' && licenseInfo.slots.used !== undefined) {
          usedSlots = licenseInfo.slots.used;
        }
      } else if (licenseInfo.used !== undefined && licenseInfo.used !== null) {
        usedSlots = licenseInfo.used;
      }
      const totalLicenses = totalSlots;
      const usedLicenses = usedSlots;
      let availableLicenses = null;
      if (licenseInfo.availableLicenses !== undefined && licenseInfo.availableLicenses !== null) {
        availableLicenses = licenseInfo.availableLicenses;
      } else if (licenseInfo.available !== undefined && licenseInfo.available !== null) {
        availableLicenses = licenseInfo.available;
      } else if (licenseInfo.free !== undefined && licenseInfo.free !== null) {
        availableLicenses = licenseInfo.free;
      } else if (totalLicenses !== null && usedLicenses !== null) {
        availableLicenses = totalLicenses - usedLicenses;
      }
      let expirationDate = null;
      const dateFields = ['expirationDate', 'expiration', 'expiryDate', 'expires', 'validUntil', 'endDate', 'validUntilDate'];
      for (const field of dateFields) {
        if (licenseInfo[field] !== undefined && licenseInfo[field] !== null) {
          expirationDate = licenseInfo[field];
          break;
        }
      }
      if (!expirationDate && licenseInfo.validity) {
        if (licenseInfo.validity.endDate) {
          expirationDate = licenseInfo.validity.endDate;
        } else if (licenseInfo.validity.expiration) {
          expirationDate = licenseInfo.validity.expiration;
        }
      }
      formattedLicense = {
        totalLicenses: totalLicenses,
        usedLicenses: usedLicenses,
        availableLicenses: availableLicenses,
        expirationDate: expirationDate,
        raw: licenseInfo
      };
    }
    let companyName = null;
    if (companyInfo) {
      companyName = companyInfo.name || companyInfo.companyName || companyInfo.company || null;
    }
    const responseData = {
      success: true,
      companyId: companyId,
      data: {
        company: companyInfo ? {
          id: companyId,
          name: companyName,
          ...companyInfo
        } : null,
        license: formattedLicense,
        endpoints: {
          total: allEndpoints.length,
          physical: physicalCount,
          virtual: virtualCount,
          managed: allEndpoints.filter(e => e.isManaged).length,
          list: allEndpoints.map(endpoint => ({
            id: endpoint.id,
            name: endpoint.name || endpoint.label || 'Sans nom',
            type: endpoint.machineType === 2 || endpoint.machineType === 3 ? 'virtuel' : endpoint.machineType === 1 ? 'physique' : 'autre',
            machineType: endpoint.machineType,
            operatingSystem: endpoint.operatingSystemVersion || null,
            ip: endpoint.ip || null,
            fqdn: endpoint.fqdn || null,
            isManaged: endpoint.isManaged || false
          }))
        }
      }
    };
    res.json(responseData);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Error retrieving endpoints',
      details: err.message
    });
  }
});
router.get('/companies', async (req, res) => {
  try {
    let apiKey;
    let apiUrl;
    try {
      const creds = await getCredentialsFromRequest(req);
      apiKey = creds.apiKey;
      apiUrl = creds.apiUrl;
    } catch (credErr) {
      return res.status(400).json({
        success: false,
        error: credErr.message
      });
    }
    const {
      companies
    } = await fetchGravityZoneCompanies(apiUrl, apiKey);
    res.json({
      success: true,
      companies
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Error retrieving companies',
      details: err.message
    });
  }
});
router.post('/test', async (req, res) => {
  try {
    let apiKey;
    let apiUrl;
    try {
      const creds = await getCredentialsFromRequest(req);
      apiKey = creds.apiKey;
      apiUrl = creds.apiUrl;
    } catch (credErr) {
      return res.status(400).json({
        success: false,
        error: credErr.message
      });
    }
    const {
      accounts,
      companies
    } = await fetchGravityZoneCompanies(apiUrl, apiKey);
    const firstRealCompany = companies.find(c => c.id && !String(c.id).startsWith("name_"));
    let license = null;
    if (firstRealCompany?.id) {
      try {
        const licenseInfo = await bitdefenderRpcCall(apiUrl, apiKey, "licensing", "getLicenseInfo", {
          companyId: firstRealCompany.id
        });
        license = {
          companyId: firstRealCompany.id,
          companyName: firstRealCompany.name,
          ...summarizeLicense(licenseInfo)
        };
      } catch {
        license = null;
      }
    }
    res.json({
      success: true,
      message: "Successfully connected to Bitdefender GravityZone API",
      tenant: {
        apiUrl,
        apiKeyPreview: `${apiKey.substring(0, 8)}…`,
        accountsCount: accounts.length,
        companiesCount: companies.length,
        companies: companies.map(c => ({
          id: c.id,
          name: c.name,
          country: c.country || null,
          isFromAccount: Boolean(c.isFromAccount)
        })),
        accounts: accounts.slice(0, 20).map(a => ({
          email: a.email || null,
          companyId: a.companyId || null,
          companyName: a.companyName || null,
          role: a.role || a.userRole || null
        })),
        license,
        testedAt: new Date().toISOString()
      },
      bitdefenderInfo: {
        apiUrl,
        apiKey: `${apiKey.substring(0, 8)}…`,
        companiesAvailable: companies.length
      }
    });
  } catch (err) {
    let errorMessage = 'BitDefender API connection error';
    if (err.message.includes('401') || err.message.includes('Unauthorized')) {
      errorMessage = 'Invalid or expired API key';
    } else if (err.message.includes('403') || err.message.includes('Forbidden')) {
      errorMessage = 'Access denied - Check your API key permissions';
    } else if (err.message.includes('429')) {
      errorMessage = 'Rate limit exceeded - Too many requests';
    }
    res.status(500).json({
      success: false,
      error: errorMessage,
      details: err.message
    });
  }
});
router.get('/statistics/:companyId', async (req, res) => {
  try {
    const {
      companyId
    } = req.params;
    const {
      startDate,
      endDate
    } = req.query;
    let apiKey;
    let apiUrl;
    try {
      const creds = await getCredentialsFromRequest(req);
      apiKey = creds.apiKey;
      apiUrl = creds.apiUrl;
    } catch (credErr) {
      return res.status(400).json({
        success: false,
        error: credErr.message
      });
    }
    let startTimestamp = null;
    let endTimestamp = null;
    if (startDate) {
      const start = new Date(startDate);
      startTimestamp = Math.floor(start.getTime() / 1000);
    }
    if (endDate) {
      const end = new Date(endDate);
      endTimestamp = Math.floor(end.getTime() / 1000);
    }
    let allEndpoints = [];
    try {
      let currentPage = 1;
      const perPage = 100;
      let hasMorePages = true;
      while (hasMorePages) {
        try {
          const pageResult = await bitdefenderRpcCall(apiUrl, apiKey, 'network', 'getEndpointsList', {
            parentId: companyId,
            page: currentPage,
            perPage: perPage,
            filters: {
              depth: {
                allItemsRecursively: true
              }
            }
          });
          if (pageResult && Array.isArray(pageResult.items)) {
            const items = pageResult.items;
            if (items.length > 0) {
              allEndpoints = allEndpoints.concat(items);
              const total = pageResult.total || 0;
              const pagesCount = pageResult.pagesCount || 0;
              if (items.length < perPage || total > 0 && allEndpoints.length >= total || pagesCount > 0 && currentPage >= pagesCount) {
                hasMorePages = false;
              } else {
                currentPage++;
              }
            } else {
              hasMorePages = false;
            }
          } else {
            hasMorePages = false;
          }
          if (currentPage > 100) {
            hasMorePages = false;
          }
        } catch (error) {
          hasMorePages = false;
        }
      }
    } catch (error) {}
    const statistics = {
      endpoints: {
        total: allEndpoints.length,
        managed: 0,
        unmanaged: 0,
        byType: {
          physical: 0,
          virtual: 0,
          other: 0
        },
        byOS: {},
        byStatus: {
          online: 0,
          offline: 0,
          unknown: 0
        }
      },
      compliance: {
        compliantEndpoints: 0,
        endpointsWithCriticalVulns: 0,
        protectionRate: 0
      },
      availability: {
        onlineRate: 0,
        managedRate: 0
      }
    };
    allEndpoints.forEach(endpoint => {
      if (endpoint.machineType === 1) {
        statistics.endpoints.byType.physical++;
      } else if (endpoint.machineType === 2 || endpoint.machineType === 3) {
        statistics.endpoints.byType.virtual++;
      } else {
        statistics.endpoints.byType.other++;
      }
      if (endpoint.isManaged) {
        statistics.endpoints.managed++;
      } else {
        statistics.endpoints.unmanaged++;
      }
      const os = endpoint.operatingSystemVersion || endpoint.operatingSystem || 'Unknown';
      const osName = os.split(' ')[0] || 'Unknown';
      statistics.endpoints.byOS[osName] = (statistics.endpoints.byOS[osName] || 0) + 1;
      const status = (endpoint.status || endpoint.onlineStatus || '').toLowerCase();
      if (status.includes('online') || status.includes('en ligne') || status === '1' || endpoint.isOnline) {
        statistics.endpoints.byStatus.online++;
      } else if (status.includes('offline') || status.includes('hors ligne') || status === '0' || !endpoint.isOnline) {
        statistics.endpoints.byStatus.offline++;
      } else {
        statistics.endpoints.byStatus.unknown++;
      }
      const isCompliant = endpoint.isCompliant || endpoint.policyStatus && endpoint.policyStatus === 'compliant' || endpoint.status && endpoint.status === 'protected' || endpoint.isManaged;
      if (isCompliant) {
        statistics.compliance.compliantEndpoints++;
      }
      if (endpoint.criticalVulnerabilities && endpoint.criticalVulnerabilities > 0) {
        statistics.compliance.endpointsWithCriticalVulns++;
      } else if (endpoint.vulnerabilities && Array.isArray(endpoint.vulnerabilities)) {
        const criticalVulns = endpoint.vulnerabilities.filter(v => v.severity && v.severity.toLowerCase().includes('critical') || v.cvssScore && v.cvssScore >= 9.0);
        if (criticalVulns.length > 0) {
          statistics.compliance.endpointsWithCriticalVulns++;
        }
      }
    });
    if (statistics.endpoints.total > 0) {
      statistics.compliance.protectionRate = Math.round(statistics.compliance.compliantEndpoints / statistics.endpoints.total * 100);
      statistics.availability.onlineRate = Math.round(statistics.endpoints.byStatus.online / statistics.endpoints.total * 100);
      statistics.availability.managedRate = Math.round(statistics.endpoints.managed / statistics.endpoints.total * 100);
    }
    res.json({
      success: true,
      companyId: companyId,
      period: {
        startDate: startDate || null,
        endDate: endDate || null
      },
      statistics: statistics
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Error retrieving statistics',
      details: err.message
    });
  }
});
router.get('/reports/:companyId', async (req, res) => {
  try {
    const {
      companyId
    } = req.params;
    const {
      type,
      page = 1,
      perPage = 100
    } = req.query;
    let apiKey;
    let apiUrl;
    try {
      const creds = await getCredentialsFromRequest(req);
      apiKey = creds.apiKey;
      apiUrl = creds.apiUrl;
    } catch (credErr) {
      return res.status(400).json({
        success: false,
        error: credErr.message
      });
    }
    const params = {};
    try {
      const reportsResult = await bitdefenderRpcCall(apiUrl, apiKey, 'reports', 'getReportsList', params);
      let reports = [];
      if (Array.isArray(reportsResult)) {
        reports = reportsResult;
      } else if (reportsResult && Array.isArray(reportsResult.items)) {
        reports = reportsResult.items;
      } else if (reportsResult && reportsResult.reports && Array.isArray(reportsResult.reports)) {
        reports = reportsResult.reports;
      } else if (reportsResult && reportsResult.data && Array.isArray(reportsResult.data)) {
        reports = reportsResult.data;
      }
      if (type) {
        const typeNum = parseInt(type);
        if (!isNaN(typeNum) && typeNum > 0) {
          reports = reports.filter(report => report.type === typeNum);
        }
      }
      return res.json({
        success: true,
        reports: reports,
        page: reportsResult?.page || parseInt(page),
        pagesCount: reportsResult?.pagesCount || 1,
        perPage: reportsResult?.perPage || parseInt(perPage),
        total: reportsResult?.total || reports.length
      });
    } catch (apiError) {
      return res.json({
        success: true,
        reports: [],
        page: parseInt(page),
        pagesCount: 0,
        perPage: parseInt(perPage),
        total: 0
      });
    }
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Error retrieving reports',
      details: err.message
    });
  }
});
router.get('/endpoints/:companyId/enriched', async (req, res) => {
  try {
    const {
      companyId
    } = req.params;
    const {
      startDate,
      endDate
    } = req.query;
    let apiKey;
    let apiUrl;
    try {
      const creds = await getCredentialsFromRequest(req);
      apiKey = creds.apiKey;
      apiUrl = creds.apiUrl;
    } catch (credErr) {
      return res.status(400).json({
        success: false,
        error: credErr.message
      });
    }
    let startTimestamp = null;
    let endTimestamp = null;
    if (startDate) {
      const start = new Date(startDate);
      startTimestamp = Math.floor(start.getTime() / 1000);
    } else {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      startTimestamp = Math.floor(thirtyDaysAgo.getTime() / 1000);
    }
    if (endDate) {
      const end = new Date(endDate);
      endTimestamp = Math.floor(end.getTime() / 1000);
    } else {
      endTimestamp = Math.floor(Date.now() / 1000);
    }
    let allEndpoints = [];
    let currentPage = 1;
    const perPage = 100;
    let hasMorePages = true;
    while (hasMorePages) {
      try {
        const pageResult = await bitdefenderRpcCall(apiUrl, apiKey, 'network', 'getEndpointsList', {
          parentId: companyId,
          page: currentPage,
          perPage: perPage,
          filters: {
            depth: {
              allItemsRecursively: true
            }
          }
        });
        if (pageResult && Array.isArray(pageResult.items)) {
          const items = pageResult.items;
          if (items.length > 0) {
            allEndpoints = allEndpoints.concat(items);
            const total = pageResult.total || 0;
            const pagesCount = pageResult.pagesCount || 0;
            if (items.length < perPage || total > 0 && allEndpoints.length >= total || pagesCount > 0 && currentPage >= pagesCount) {
              hasMorePages = false;
            } else {
              currentPage++;
            }
          } else {
            hasMorePages = false;
          }
        } else {
          hasMorePages = false;
        }
        if (currentPage > 100) {
          hasMorePages = false;
        }
      } catch (error) {
        hasMorePages = false;
      }
    }
    const enrichedEndpoints = await Promise.all(allEndpoints.map(async endpoint => {
      let isInfected = false;
      let malwareDetected = false;
      let endpointState = null;
      let lastSeen = endpoint.lastSeen || endpoint.lastSeenDate || endpoint.lastSuccessfulScan?.date || endpoint.lastSuccessfulScanDate || null;
      let agentInfo = null;
      let modules = null;
      let policy = null;
      if (endpoint.id) {
        try {
          const endpointDetails = await bitdefenderRpcCall(apiUrl, apiKey, 'network', 'getManagedEndpointDetails', {
            endpointId: endpoint.id
          });
          if (endpointDetails) {
            if (endpointDetails.malwareStatus) {
              isInfected = endpointDetails.malwareStatus.infected || false;
              malwareDetected = endpointDetails.malwareStatus.detection || false;
            }
            if (endpointDetails.state !== undefined && endpointDetails.state !== null) {
              endpointState = endpointDetails.state;
            }
            if (endpointDetails.lastSeen || endpointDetails.lastSeenDate) {
              lastSeen = endpointDetails.lastSeen || endpointDetails.lastSeenDate;
            } else if (endpointDetails.lastSuccessfulScan?.date || endpointDetails.lastSuccessfulScanDate) {
              lastSeen = endpointDetails.lastSuccessfulScan?.date || endpointDetails.lastSuccessfulScanDate;
            }
            if (endpointDetails.agent) {
              agentInfo = {
                engineVersion: endpointDetails.agent.engineVersion || null,
                productVersion: endpointDetails.agent.productVersion || null,
                lastUpdate: endpointDetails.agent.lastUpdate || null,
                licensed: endpointDetails.agent.licensed || 0,
                signatureOutdated: endpointDetails.agent.signatureOutdated || false,
                productOutdated: endpointDetails.agent.productOutdated || false
              };
            }
            if (endpointDetails.modules) {
              modules = endpointDetails.modules;
            }
            if (endpointDetails.policy) {
              policy = {
                id: endpointDetails.policy.id || null,
                name: endpointDetails.policy.name || null,
                applied: endpointDetails.policy.applied || false
              };
            }
          }
        } catch (error) {}
      }
      return {
        id: endpoint.id,
        name: endpoint.name || endpoint.label || 'Sans nom',
        type: endpoint.machineType === 2 || endpoint.machineType === 3 ? 'virtuel' : endpoint.machineType === 1 ? 'physique' : 'autre',
        machineType: endpoint.machineType,
        operatingSystem: endpoint.operatingSystemVersion || endpoint.operatingSystem || null,
        ip: endpoint.ip || null,
        fqdn: endpoint.fqdn || null,
        isManaged: endpoint.isManaged || false,
        lastSuccessfulScan: endpoint.lastSuccessfulScan || null,
        lastSuccessfulScanDate: endpoint.lastSuccessfulScanDate || null,
        isInfected: isInfected,
        malwareDetected: malwareDetected,
        endpointState: endpointState,
        lastSeen: lastSeen,
        agent: agentInfo,
        modules: modules,
        policy: policy
      };
    }));
    return res.json({
      success: true,
      companyId: companyId,
      startDate: startTimestamp,
      endDate: endTimestamp,
      endpoints: enrichedEndpoints,
      summary: {
        total: enrichedEndpoints.length,
        managed: enrichedEndpoints.filter(e => e.isManaged).length,
        infected: enrichedEndpoints.filter(e => e.isInfected).length,
        malwareDetected: enrichedEndpoints.filter(e => e.malwareDetected).length,
        online: enrichedEndpoints.filter(e => e.endpointState === 1).length,
        offline: enrichedEndpoints.filter(e => e.endpointState === 2).length
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Error retrieving enriched endpoints',
      details: err.message
    });
  }
});
router.get('/policies/:companyId', async (req, res) => {
  try {
    const {
      companyId
    } = req.params;
    const {
      page = 1,
      perPage = 100
    } = req.query;
    let apiKey;
    let apiUrl;
    try {
      const creds = await getCredentialsFromRequest(req);
      apiKey = creds.apiKey;
      apiUrl = creds.apiUrl;
    } catch (credErr) {
      return res.status(400).json({
        success: false,
        error: credErr.message
      });
    }
    try {
      const policiesResult = await bitdefenderRpcCall(apiUrl, apiKey, 'policies', 'getPoliciesList', {
        page: parseInt(page),
        perPage: Math.min(parseInt(perPage), 100)
      });
      let policies = [];
      if (policiesResult && Array.isArray(policiesResult.items)) {
        policies = policiesResult.items;
      } else if (Array.isArray(policiesResult)) {
        policies = policiesResult;
      }
      const policiesWithDetails = await Promise.all(policies.map(async policy => {
        let details = null;
        try {
          details = await bitdefenderRpcCall(apiUrl, apiKey, 'policies', 'getPolicyDetails', {
            policyId: policy.id
          });
        } catch (error) {}
        let activeModules = [];
        if (details && details.settings) {
          const settings = details.settings;
          if (settings.modules && typeof settings.modules === 'object') {
            Object.keys(settings.modules).forEach(moduleName => {
              if (settings.modules[moduleName] === true) {
                activeModules.push(moduleName);
              }
            });
          }
          if (activeModules.length === 0) {
            const moduleFields = ['advancedThreatControl', 'antimalware', 'contentControl', 'deviceControl', 'firewall', 'powerUser'];
            moduleFields.forEach(field => {
              if (settings[field] === true) {
                activeModules.push(field);
              }
            });
          }
          if (settings.enabledModules && Array.isArray(settings.enabledModules)) {
            settings.enabledModules.forEach(moduleName => {
              if (!activeModules.includes(moduleName)) {
                activeModules.push(moduleName);
              }
            });
          }
        }
        return {
          id: policy.id,
          name: policy.name,
          companyId: policy.companyId,
          companyName: policy.companyName,
          details: details ? {
            createdBy: details.createdBy || null,
            createDate: details.createDate || null,
            lastModifyDate: details.lastModifyDate || null,
            hasSettings: !!details.settings,
            activeModules: activeModules,
            settings: details.settings || null
          } : null
        };
      }));
      return res.json({
        success: true,
        companyId: companyId,
        policies: policiesWithDetails,
        page: policiesResult?.page || parseInt(page),
        pagesCount: policiesResult?.pagesCount || 1,
        perPage: policiesResult?.perPage || parseInt(perPage),
        total: policiesResult?.total || policiesWithDetails.length
      });
    } catch (apiError) {
      return res.json({
        success: true,
        policies: [],
        page: parseInt(page),
        pagesCount: 0,
        perPage: parseInt(perPage),
        total: 0
      });
    }
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Error retrieving policies',
      details: err.message
    });
  }
});
router.put('/antivirus/:clientId', async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const {
      item_key,
      name,
      data
    } = req.body;
    if (!clientId || !item_key || !name || !data) {
      return res.status(400).json({
        success: false,
        error: 'Missing parameters: clientId, item_key, name, data'
      });
    }
    const clientCheck = await pool.query('SELECT id FROM v_b_clients WHERE id::text = $1', [clientId]);
    if (clientCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Client not found'
      });
    }
    const existingCheck = await pool.query('SELECT id FROM v_b_clients_m_antivirus WHERE client_id = $1::integer AND item_key = $2', [clientId, item_key]);
    let result;
    if (existingCheck.rows.length > 0) {
      result = await pool.query(`UPDATE v_b_clients_m_antivirus 
         SET name = $1, data = $2, updated_at = NOW()
         WHERE client_id = $3::integer AND item_key = $4
         RETURNING id, client_id, item_key, name, data, updated_at`, [name, JSON.stringify(data), clientId, item_key]);
    } else {
      result = await pool.query(`INSERT INTO v_b_clients_m_antivirus (client_id, item_key, name, data, created_at, updated_at)
         VALUES ($1::integer, $2, $3, $4, NOW(), NOW())
         RETURNING id, client_id, item_key, name, data, created_at, updated_at`, [clientId, item_key, name, JSON.stringify(data)]);
    }
    if (result.rows.length > 0) {
      const record = result.rows[0];
      res.json({
        success: true,
        message: 'Antivirus data saved successfully',
        data: {
          id: record.id,
          client_id: record.client_id,
          item_key: record.item_key,
          name: record.name,
          data: record.data,
          updated_at: record.updated_at || record.created_at
        }
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Error saving data'
      });
    }
  } catch (err) {
    console.error('Error saving antivirus data:', err);
    res.status(500).json({
      success: false,
      error: 'Error saving antivirus data',
      details: err.message
    });
  }
});
router.delete('/antivirus/:clientId', async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const item_key = req.query.item_key || req.body?.item_key;
    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: 'clientId required'
      });
    }
    if (!item_key) {
      return res.status(400).json({
        success: false,
        error: 'item_key required to delete a specific antivirus record'
      });
    }
    const result = await pool.query(`DELETE FROM v_b_clients_m_antivirus
       WHERE client_id = $1::integer AND item_key = $2
       RETURNING id`, [clientId, item_key]);
    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Enregistrement antivirus not found'
      });
    }
    res.json({
      success: true,
      message: 'Antivirus data deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting antivirus data:', err);
    res.status(500).json({
      success: false,
      error: 'Error deleting antivirus data',
      details: err.message
    });
  }
});
router.get('/antivirus/:clientId', async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const result = await pool.query(`SELECT id, client_id, item_key, name, data, updated_at, created_at
       FROM v_b_clients_m_antivirus
       WHERE client_id = $1::integer
       ORDER BY created_at DESC`, [clientId]);
    res.json({
      success: true,
      data: result.rows.map(row => ({
        id: row.id,
        client_id: row.client_id,
        item_key: row.item_key,
        name: row.name,
        data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
        updated_at: row.updated_at,
        created_at: row.created_at
      }))
    });
  } catch (err) {
    console.error('Error fetching antivirus data:', err);
    res.status(500).json({
      success: false,
      error: 'Error retrieving antivirus data',
      details: err.message
    });
  }
});
router.get('/gravityzone/:companyId/dashboard', async (req, res) => {
  try {
    const {
      companyId
    } = req.params;
    let apiKey;
    let apiUrl;
    try {
      const creds = await getCredentialsFromRequest(req);
      apiKey = creds.apiKey;
      apiUrl = creds.apiUrl;
    } catch (credErr) {
      return res.status(400).json({
        success: false,
        error: credErr.message
      });
    }
    const [companyRes, licenseRes, endpointsRes, policiesRes, reportsRes, incidentsRes, quarantineRes, missingPatchesRes, installedPatchesRes, phasrRes, pushSettingsRes, pushStatsRes, packagesRes, maintenanceRes, blocklistRes, integrationsRes] = await Promise.all([safeBitdefenderRpc(apiUrl, apiKey, "companies", "getCompanyDetails", {
      companyId
    }), safeBitdefenderRpc(apiUrl, apiKey, "licensing", "getLicenseInfo", {
      companyId
    }), safeBitdefenderRpc(apiUrl, apiKey, "network", "getEndpointsList", {
      parentId: companyId,
      page: 1,
      perPage: 50,
      filters: {
        depth: {
          allItemsRecursively: true
        }
      }
    }), safeBitdefenderRpc(apiUrl, apiKey, "policies", "getPoliciesList", {
      page: 1,
      perPage: 50
    }), safeBitdefenderRpc(apiUrl, apiKey, "reports", "getReportsList", {}), safeBitdefenderRpc(apiUrl, apiKey, "incidents", "getIncidentsList", {
      companyId,
      page: 1,
      perPage: 30
    }), safeBitdefenderRpc(apiUrl, apiKey, "quarantine", "getQuarantineItemsList", {
      companyId,
      page: 1,
      perPage: 30
    }), safeBitdefenderRpc(apiUrl, apiKey, "patchManagement", "getMissingPatches", {
      companyId,
      page: 1,
      perPage: 30
    }), safeBitdefenderRpc(apiUrl, apiKey, "patchManagement", "getInstalledPatches", {
      companyId,
      page: 1,
      perPage: 30
    }), safeBitdefenderRpc(apiUrl, apiKey, "phasr", "getPhasrRecommendations", {
      companyId
    }), safeBitdefenderRpc(apiUrl, apiKey, "push", "getPushEventSettings", {}), safeBitdefenderRpc(apiUrl, apiKey, "push", "getPushEventStats", {}), safeBitdefenderRpc(apiUrl, apiKey, "packages", "getPackagesList", {
      page: 1,
      perPage: 30
    }), safeBitdefenderRpc(apiUrl, apiKey, "maintenanceWindows", "getMaintenanceWindowsList", {
      companyId
    }), safeBitdefenderRpc(apiUrl, apiKey, "incidents", "getBlocklistItems", {
      page: 1,
      perPage: 30
    }), safeBitdefenderRpc(apiUrl, apiKey, "integrations", "getAmazonEC2ExternalIdForCrossAccountRole", {})]);
    const license = licenseRes.ok ? summarizeLicense(licenseRes.data) : null;
    const endpointsNormalized = endpointsRes.ok ? normalizePaginatedResult(endpointsRes.data) : {
      items: [],
      total: 0
    };
    const endpoints = endpointsNormalized.items.map(ep => ({
      id: ep.id,
      name: ep.name || ep.label || "Sans nom",
      ip: ep.ip || null,
      fqdn: ep.fqdn || null,
      type: ep.machineType === 2 || ep.machineType === 3 ? "virtuel" : ep.machineType === 1 ? "physique" : "autre",
      isManaged: Boolean(ep.isManaged),
      os: ep.operatingSystemVersion || ep.operatingSystem || null
    }));
    const policiesAll = policiesRes.ok ? normalizePaginatedResult(policiesRes.data).items : [];
    const policies = policiesAll.filter(p => !p.companyId || p.companyId === companyId).map(p => ({
      id: p.id,
      name: p.name,
      companyId: p.companyId || null,
      companyName: p.companyName || null
    }));
    const reports = reportsRes.ok ? normalizePaginatedResult(reportsRes.data).items.map(r => ({
      id: r.id,
      name: r.name || r.reportName || "Rapport",
      type: r.type ?? null,
      schedule: r.schedule || r.scheduling || null,
      lastRun: r.lastRun || r.lastGenerated || null
    })) : [];
    const sections = {
      company: companyRes.ok ? {
        status: "ok",
        data: {
          id: companyId,
          name: companyRes.data?.name || null,
          country: companyRes.data?.country || companyRes.data?.countryCode || null,
          type: companyRes.data?.type ?? null,
          managePatchManagement: companyRes.data?.managePatchManagement ?? null
        }
      } : {
        status: companyRes.permissionDenied ? "permission_denied" : "error",
        error: companyRes.error
      },
      license: licenseRes.ok ? {
        status: license ? "ok" : "empty",
        data: license
      } : {
        status: licenseRes.permissionDenied ? "permission_denied" : "error",
        error: licenseRes.error
      },
      endpoints: {
        exploited: true,
        status: endpointsRes.ok ? endpoints.length ? "ok" : "empty" : endpointsRes.permissionDenied ? "permission_denied" : "error",
        error: endpointsRes.ok ? null : endpointsRes.error,
        items: endpoints,
        total: endpointsNormalized.total || endpoints.length
      },
      policies: {
        exploited: true,
        status: policiesRes.ok ? policies.length ? "ok" : "empty" : policiesRes.permissionDenied ? "permission_denied" : "error",
        error: policiesRes.ok ? null : policiesRes.error,
        items: policies,
        total: policies.length
      },
      reports: {
        exploited: true,
        status: reportsRes.ok ? reports.length ? "ok" : "empty" : reportsRes.permissionDenied ? "permission_denied" : "error",
        error: reportsRes.ok ? null : reportsRes.error,
        items: reports,
        total: reports.length
      },
      incidents: buildApiSection("incidents", "Incidents", false, incidentsRes, item => ({
        id: item.id || item.incidentId,
        name: item.name || item.threatName || item.fileName || "Incident",
        severity: item.severity || item.priority || null,
        status: item.status || item.state || null,
        endpoint: item.endpointName || item.computerName || null,
        detectedAt: item.detectionTime || item.createdAt || null
      })),
      quarantine: buildApiSection("quarantine", "Quarantaine", false, quarantineRes, item => ({
        id: item.id,
        fileName: item.fileName || item.name || "File",
        threat: item.threatName || item.detectionName || null,
        endpoint: item.endpointName || item.computerName || null,
        quarantinedAt: item.quarantineDate || item.date || null
      })),
      patchManagement: {
        exploited: false,
        status: "preview",
        missing: buildApiSection("missingPatches", "Patches manquants", false, missingPatchesRes, item => ({
          id: item.id || item.patchId,
          name: item.name || item.patchName || "Patch",
          severity: item.severity || null,
          product: item.productName || item.product || null,
          endpoint: item.endpointName || null
        })),
        installed: buildApiSection("installedPatches", "Installed patches", false, installedPatchesRes, item => ({
          id: item.id || item.patchId,
          name: item.name || item.patchName || "Patch",
          installedAt: item.installDate || item.installedDate || null,
          endpoint: item.endpointName || null
        }))
      },
      phasr: buildApiSection("phasr", "PHASR", false, phasrRes, item => ({
        id: item.id || item.recommendationId,
        name: item.name || item.title || item.recommendationName || "Recommandation",
        status: item.status || item.state || null,
        resource: item.resourceName || item.resource || null,
        severity: item.severity || item.riskLevel || null
      })),
      investigation: {
        exploited: false,
        status: "info",
        message: "The Investigation API can collect investigation packages (collectInvestigationPackage, getInvestigationFileUrl). No active investigation is listed automatically.",
        methods: ["collectInvestigationPackage", "startRetrieveInvestigationFileFromEndpoint", "getInvestigationFileUrl"]
      },
      push: {
        exploited: false,
        settings: pushSettingsRes.ok ? {
          status: "ok",
          data: pushSettingsRes.data
        } : {
          status: pushSettingsRes.permissionDenied ? "permission_denied" : "error",
          error: pushSettingsRes.error
        },
        stats: pushStatsRes.ok ? {
          status: "ok",
          data: pushStatsRes.data
        } : {
          status: pushStatsRes.permissionDenied ? "permission_denied" : "error",
          error: pushStatsRes.error
        }
      },
      packages: buildApiSection("packages", "Packages", false, packagesRes, item => ({
        id: item.id,
        name: item.name || "Package",
        type: item.type ?? item.productType ?? null,
        os: item.operatingSystem || item.os || null,
        modules: item.modules || null
      })),
      integrations: integrationsRes.ok ? {
        status: "ok",
        exploited: false,
        data: integrationsRes.data,
        label: "Integrations (e.g. Amazon EC2)"
      } : {
        status: integrationsRes.permissionDenied ? "permission_denied" : "error",
        exploited: false,
        error: integrationsRes.error,
        hint: "Check « Integrations » API rights on the GravityZone key."
      },
      maintenance: buildApiSection("maintenance", "Maintenance windows", false, maintenanceRes, item => ({
        id: item.id,
        name: item.name || "Window",
        type: item.type || item.windowType || null,
        schedule: item.schedule || item.recurrence || null,
        enabled: item.enabled ?? item.isEnabled ?? null
      })),
      blocklist: buildApiSection("blocklist", "Blocklist EDR", false, blocklistRes, item => ({
        id: item.id,
        hash: item.hash || null,
        hashType: item.hashType || null,
        fileName: item.filename || item.fileName || null,
        source: item.sourceInfo || item.source || null
      }))
    };
    res.json({
      success: true,
      companyId,
      fetchedAt: new Date().toISOString(),
      sections
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Error retrieving GravityZone dashboard",
      details: err.message
    });
  }
});
export default router;
