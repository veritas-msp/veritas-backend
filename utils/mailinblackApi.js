import fetch from 'node-fetch';
export const DEFAULT_MAILINBLACK_API_URL = 'https://api.mailinblack.com';
function normalizeApiUrl(apiUrl) {
  let raw = (apiUrl || DEFAULT_MAILINBLACK_API_URL).trim().replace(/\/+$/, '');
  raw = raw.replace(/\/auth\/api(\/v[\d.]+)?(\/.*)?$/i, '');
  raw = raw.replace(/\/protect\/api(\/v[\d.]+)?(\/.*)?$/i, '');
  raw = raw.replace(/\/admin\/api(\/v[\d.]+)?(\/.*)?$/i, '');
  raw = raw.replace(/\/v1$/i, '');
  raw = raw.replace(/\/(admin|protect|auth)\/api$/i, '');
  raw = raw.replace(/\/(admin|protect|auth)$/i, '');
  return raw.replace(/\/+$/, '');
}
function resolveApiBaseUrls(apiUrl) {
  const raw = (apiUrl || DEFAULT_MAILINBLACK_API_URL).trim();
  const instanceRoot = normalizeApiUrl(raw);
  const bases = [];
  const add = value => {
    if (value && !bases.includes(value)) bases.push(value);
  };
  add(instanceRoot);
  add(DEFAULT_MAILINBLACK_API_URL);
  if (raw.includes('app.mailinblack.com')) {
    add('https://app.mailinblack.com');
  }
  return bases;
}
function resolveClientId(session, credentials = {}) {
  return session?.clientId || credentials?.authClientId || credentials?.clientId || null;
}
async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text
    };
  }
}
function extractErrorMessage(body, status) {
  if (!body) return `HTTP ${status}`;
  if (typeof body === 'string') return body;
  return body.error?.message || body.error || body.message || body.details || `HTTP ${status}`;
}
function parseList(payload, depth = 0) {
  if (!payload || depth > 4) return [];
  if (Array.isArray(payload)) return payload;
  const directKeys = ['items', 'content', 'data', 'results', 'list', 'customers', 'clients', 'senders', 'spools', 'domains', 'users', 'elements', 'records', 'values', 'rows'];
  for (const key of directKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = parseList(candidate, depth + 1);
      if (nested.length) return nested;
    }
  }
  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}
function normalizeListItem(item, normalizer) {
  if (item == null) return null;
  if (typeof item === 'string' || typeof item === 'number') {
    const value = String(item).trim();
    if (!value) return null;
    return normalizer({
      id: value,
      name: value,
      domain: value,
      email: value,
      fqdn: value
    });
  }
  return normalizer(item);
}
function normalizePaginated(payload) {
  const items = parseList(payload);
  const total = payload?.total ?? payload?.totalElements ?? payload?.totalCount ?? payload?.count ?? items.length;
  return {
    items,
    total
  };
}
function resolveAuthBaseUrls(apiUrl) {
  const bases = [];
  const add = value => {
    if (value && !bases.includes(value)) bases.push(value);
  };
  add(DEFAULT_MAILINBLACK_API_URL);
  const raw = (apiUrl || DEFAULT_MAILINBLACK_API_URL).trim().replace(/\/+$/, '');
  const instanceRoot = normalizeApiUrl(raw);
  add(instanceRoot);
  if (raw.includes('app.mailinblack.com')) {
    add('https://app.mailinblack.com');
  }
  return bases;
}
function looksLikeSessionToken(value) {
  const key = (value || '').trim();
  if (!key || key.length < 32) return false;
  if (key.startsWith('eyJ')) return true;
  if (/^[a-f0-9]{32,}$/i.test(key) && !key.includes('.')) return false;
  return key.includes('.') || key.length >= 64;
}
async function postMailinblackAuth(authBase, path, body) {
  const url = `${authBase.replace(/\/+$/, '')}/auth/api/v2.0/${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const parsed = await parseResponseBody(response);
  return {
    response,
    parsed,
    url
  };
}
function buildAuthFailureMessage(lastStatus, lastBody, lastUrl = '') {
  if (lastStatus === 401) {
    return "API key rejected. Verify that it was generated in Manager Space → " + "Integration → API Keys (read-only access, with Management and Protect products enabled).";
  }
  if (lastStatus === 405) {
    return "HTTP 405 — method rejected by Mailinblack. Use only the instance root " + "(for example https://app.mailinblack.com/mibc-fr-XX or https://api.mailinblack.com), without pasting " + "the /auth/api/... path into the URL. Enter the API key in “API Key”; the client ID is optional " + "and populated automatically after signing in.";
  }
  if (lastStatus) {
    const base = extractErrorMessage(lastBody, lastStatus);
    return lastUrl ? `${base} (${lastUrl})` : base;
  }
  return 'Unable to connect to Mailinblack — check the API URL and API key.';
}
export async function mailinblackAuthenticate(credentials = {}) {
  const {
    apiUrl,
    authKey,
    apiKey,
    authClientId,
    clientId: presetClientId,
    login,
    password
  } = credentials;
  const key = (authKey || apiKey || '').trim();
  const authBases = resolveAuthBaseUrls(apiUrl);
  const clientIdForAuth = authClientId || presetClientId || null;
  if (login?.trim() && password) {
    let lastStatus = null;
    let lastBody = null;
    for (const authBase of authBases) {
      const {
        response,
        parsed
      } = await postMailinblackAuth(authBase, 'login', {
        login: login.trim(),
        password
      });
      if (response.ok && parsed?.token) {
        return {
          token: parsed.token,
          clientId: parsed.clientId || clientIdForAuth || null,
          userId: parsed.userId || null
        };
      }
      lastStatus = response.status;
      lastBody = parsed;
    }
    const err = new Error(buildAuthFailureMessage(lastStatus, lastBody));
    err.status = lastStatus;
    err.body = lastBody;
    throw err;
  }
  if (!key) {
    throw new Error('Mailinblack API key is required — generate one in Manager Space → Integration → API Keys.');
  }
  if (looksLikeSessionToken(key)) {
    return {
      token: key,
      clientId: clientIdForAuth,
      userId: null
    };
  }
  const executeBodies = [{
    apiKey: key
  }, {
    key
  }, {
    api_key: key
  }, {
    authKey: key
  }, ...(clientIdForAuth ? [{
    apiKey: key,
    clientId: clientIdForAuth
  }, {
    key,
    clientId: clientIdForAuth
  }, {
    authKey: key,
    clientId: clientIdForAuth
  }, {
    clientId: clientIdForAuth,
    apiKey: key
  }] : [])];
  let lastStatus = null;
  let lastBody = null;
  let lastUrl = null;
  for (const authBase of authBases) {
    for (const executeBody of executeBodies) {
      try {
        const {
          response,
          parsed,
          url
        } = await postMailinblackAuth(authBase, 'api-keys/execute', executeBody);
        if (response.ok && parsed?.token) {
          return {
            token: parsed.token,
            clientId: parsed.clientId || clientIdForAuth || null,
            userId: parsed.userId || null
          };
        }
        lastStatus = response.status;
        lastBody = parsed;
        lastUrl = url;
      } catch {}
    }
  }
  const err = new Error(buildAuthFailureMessage(lastStatus, lastBody, lastUrl));
  err.status = lastStatus;
  err.body = lastBody;
  throw err;
}
export async function mailinblackV2Request(apiUrl, session, module, path, {
  method = 'GET',
  body = null,
  query = {}
} = {}) {
  const bases = resolveApiBaseUrls(apiUrl);
  let lastError = null;
  for (const base of bases) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value != null && value !== '') params.set(key, String(value));
    });
    const qs = params.toString();
    const url = `${base}/${module}/api/v2.0/${path}${qs ? `?${qs}` : ''}`;
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-auth-token': session.token,
      Authorization: `Bearer ${session.token}`
    };
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body || {})
      });
      const parsed = await parseResponseBody(response);
      if (!response.ok) {
        const message = extractErrorMessage(parsed, response.status);
        const err = new Error(message);
        err.status = response.status;
        err.body = parsed;
        err.permissionDenied = response.status === 401 || response.status === 403;
        err.requestUrl = url;
        if (response.status === 404 || response.status === 405) {
          lastError = err;
          continue;
        }
        throw err;
      }
      if (parsed && parsed.success === false) {
        const err = new Error(extractErrorMessage(parsed, response.status));
        err.status = response.status;
        err.body = parsed;
        throw err;
      }
      return parsed;
    } catch (err) {
      if (err?.status === 404 || err?.status === 405) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  if (lastError) throw lastError;
  throw new Error('Unable to call the Mailinblack API');
}
async function safeMailinblackCall(fn) {
  try {
    const data = await fn();
    return {
      ok: true,
      data,
      permissionDenied: false,
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      data: null,
      permissionDenied: Boolean(err.permissionDenied || err.status === 401 || err.status === 403),
      error: err.message
    };
  }
}
export async function mailinblackProtectRequest(apiUrl, apiKey, action, params = {}, method = 'POST') {
  const session = await mailinblackAuthenticate({
    apiUrl,
    authKey: apiKey
  });
  const path = action.includes('/') ? action : action;
  try {
    return mailinblackV2Request(apiUrl, session, 'protect', path, {
      method,
      body: params
    });
  } catch {
    const base = normalizeApiUrl(apiUrl);
    const legacyUrl = `${base}/protect/${action}`;
    const response = await fetch(legacyUrl, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-auth-token': session.token,
        Authorization: `Bearer ${session.token}`
      },
      body: method === 'GET' ? undefined : JSON.stringify(params)
    });
    const body = await parseResponseBody(response);
    if (!response.ok) throw new Error(extractErrorMessage(body, response.status));
    return body;
  }
}
export async function mailinblackProtectCheck(apiUrl, credentials) {
  const creds = typeof credentials === 'string' ? {
    apiUrl,
    authKey: credentials
  } : {
    apiUrl,
    ...credentials
  };
  const session = await mailinblackAuthenticate(creds);
  const probe = await safeMailinblackCall(() => mailinblackV2Request(apiUrl, session, 'protect', 'senders', {
    method: 'GET',
    query: {
      page: 0,
      size: 1
    }
  }));
  if (!probe.ok) {
    const domainsProbe = await safeMailinblackCall(() => mailinblackV2Request(apiUrl, session, 'admin', 'domains', {
      method: 'GET',
      query: {
        page: 0,
        size: 1
      }
    }));
    if (!domainsProbe.ok) {
      const denied = probe.permissionDenied || domainsProbe.permissionDenied;
      const raw = probe.error || domainsProbe.error || 'Mailinblack connection failed';
      throw new Error(denied ? 'Access denied to the Protect/Admin APIs. Verify that the API key has Management and Protect permissions (read-only access is sufficient).' : raw);
    }
  }
  return {
    success: true,
    session
  };
}
export function normalizeMailinblackCustomer(item, session = null) {
  if (!item || typeof item !== 'object') return null;
  const id = item.id ?? item.customerId ?? item.clientId ?? item.uuid ?? item.reference ?? session?.clientId;
  if (id == null) return null;
  return {
    id: String(id),
    name: item.name || item.companyName || item.company || item.label || item.customerName || 'Mailinblack customer',
    domain: item.domain || item.primaryDomain || item.mainDomain || null,
    usersCount: item.usersCount ?? item.users ?? item.licenses ?? item.licenseCount ?? item.nbUsers ?? null,
    domainsCount: item.domainsCount ?? item.domains ?? item.domainCount ?? (item.domain ? 1 : null),
    status: item.status || item.installationStatus || item.state || null,
    expiration: item.expirationDate || item.expiration || item.renewalDate || null,
    raw: item
  };
}
function normalizeSender(item) {
  if (!item || typeof item !== 'object') return null;
  const id = item.id ?? item.senderId ?? item.email ?? item.address ?? item.mail ?? item.name;
  if (!id) return null;
  const email = item.email || item.address || item.sender || item.mail || item.name || '—';
  return {
    id: String(id),
    email,
    domain: item.domain || item.senderDomain || null,
    status: item.status || item.state || item.verdict || null,
    authorized: item.authorized ?? item.isAuthorized ?? item.trusted ?? null,
    lastSeen: item.lastSeen || item.lastActivity || item.updatedAt || item.lastUseDate || null
  };
}
function normalizeSpool(item) {
  if (!item || typeof item !== 'object') return null;
  const id = item.id ?? item.spoolId ?? item.messageId ?? item.uuid;
  if (!id) return null;
  return {
    id: String(id),
    subject: item.subject || item.title || item.object || '—',
    sender: item.sender || item.from || item.senderEmail || item.senderAddress || null,
    recipient: item.recipient || item.to || item.recipientEmail || null,
    status: item.status || item.state || item.verdict || null,
    receivedAt: item.receivedAt || item.date || item.createdAt || item.receptionDate || null,
    threat: item.threat || item.category || item.reason || item.detection || null
  };
}
function normalizeDomain(item) {
  if (typeof item === 'string' || typeof item === 'number') {
    const name = String(item).trim();
    if (!name) return null;
    return {
      id: name,
      name
    };
  }
  if (!item || typeof item !== 'object') return null;
  const name = item.name || item.domain || item.fqdn || item.domainName || item.label;
  if (!name) return null;
  return {
    id: String(item.id ?? name),
    name: String(name),
    status: item.status || item.state || item.installationStatus || null,
    expiration: item.expirationDate || item.expiration || item.expiryDate || item.renewalDate || null,
    autoRenew: item.autoRenew ?? item.autorenew ?? item.autoRenewal ?? null,
    dnsManaged: item.dnsManaged ?? item.managed ?? item.hasDnsZone ?? null
  };
}
function normalizeUser(item) {
  if (!item || typeof item !== 'object') return null;
  const id = item.id ?? item.userId ?? item.email ?? item.mail ?? item.login;
  if (!id) return null;
  return {
    id: String(id),
    email: item.email || item.mail || item.login || item.username || '—',
    name: item.name || item.displayName || item.fullName || item.firstName || null,
    status: item.status || item.state || item.accountStatus || null,
    role: item.role || item.profile || item.type || null
  };
}
function buildSectionFromResult(result, normalizer, columnsMeta = {}) {
  const {
    preItems,
    ...meta
  } = columnsMeta;
  const items = preItems ?? (result.ok ? parseList(result.data).map(item => normalizer ? normalizeListItem(item, normalizer) : item).filter(Boolean) : []);
  const total = result.ok ? normalizePaginated(result.data).total || items.length : 0;
  return {
    status: result.ok ? items.length ? 'ok' : 'empty' : result.permissionDenied ? 'permission_denied' : 'error',
    error: result.ok ? null : result.error,
    items,
    total,
    ...meta
  };
}
const MAILINBLACK_LIST_QUERY_VARIANTS = [{
  page: 0,
  size: 200
}, {
  pageNumber: 0,
  pageSize: 200
}, {
  offset: 0,
  limit: 200
}, {}];
async function mailinblackFetchListSection(apiUrl, session, credentials, module, path, normalizer, {
  exploited = true
} = {}) {
  let lastResult = {
    ok: false,
    permissionDenied: false,
    error: 'No data returned'
  };
  for (const baseQuery of MAILINBLACK_LIST_QUERY_VARIANTS) {
    const query = {
      ...baseQuery
    };
    const result = await safeMailinblackCall(() => mailinblackV2Request(apiUrl, session, module, path, {
      method: 'GET',
      query
    }));
    lastResult = result;
    if (!result.ok) continue;
    let items = parseList(result.data).map(item => normalizeListItem(item, normalizer)).filter(Boolean);
    const expectedTotal = normalizePaginated(result.data).total;
    const pageSize = baseQuery.size || baseQuery.pageSize || baseQuery.limit || 200;
    if (items.length > 0 && expectedTotal > items.length && baseQuery.page != null) {
      for (let page = 1; page < 10; page += 1) {
        const nextQuery = {
          ...baseQuery,
          page,
          pageNumber: page
        };
        const nextResult = await safeMailinblackCall(() => mailinblackV2Request(apiUrl, session, module, path, {
          method: 'GET',
          query: nextQuery
        }));
        if (!nextResult.ok) break;
        const nextItems = parseList(nextResult.data).map(item => normalizeListItem(item, normalizer)).filter(Boolean);
        if (!nextItems.length) break;
        items = [...items, ...nextItems];
        if (nextItems.length < pageSize) break;
      }
    }
    if (items.length > 0) {
      return buildSectionFromResult({
        ok: true,
        data: result.data
      }, normalizer, {
        exploited,
        preItems: items
      });
    }
  }
  return buildSectionFromResult(lastResult, normalizer, {
    exploited
  });
}
export async function mailinblackListCustomers(apiUrl, credentials) {
  const session = await mailinblackAuthenticate(credentials);
  const legacyAttempts = [() => mailinblackV2Request(apiUrl, session, 'protect', 'customers', {
    method: 'GET'
  }), () => mailinblackProtectRequest(apiUrl, credentials.authKey || credentials.apiKey, 'customers', {}, 'GET')];
  for (const attempt of legacyAttempts) {
    const result = await safeMailinblackCall(attempt);
    if (result.ok) {
      const list = parseList(result.data?.customers ? result.data : result.data);
      const normalized = list.map(item => normalizeMailinblackCustomer(item, session)).filter(Boolean);
      if (normalized.length) {
        const seen = new Set();
        return normalized.filter(entry => {
          if (seen.has(entry.id)) return false;
          seen.add(entry.id);
          return true;
        });
      }
    }
  }
  if (session.clientId) {
    const summary = await mailinblackGetCustomer(apiUrl, credentials, session.clientId);
    if (summary) return [summary];
  }
  return [];
}
export async function mailinblackGetCustomer(apiUrl, credentials, customerId) {
  const session = await mailinblackAuthenticate(credentials);
  const legacy = await safeMailinblackCall(() => mailinblackProtectRequest(apiUrl, credentials.authKey || credentials.apiKey, `customers/${customerId}`, {}, 'GET'));
  if (legacy.ok) {
    const raw = legacy.data?.customer || legacy.data?.data || legacy.data;
    const normalized = normalizeMailinblackCustomer(raw, session);
    if (normalized) return normalized;
  }
  const [domainsRes, usersRes] = await Promise.all([safeMailinblackCall(() => mailinblackV2Request(apiUrl, session, 'admin', 'domains', {
    method: 'GET',
    query: {
      page: 0,
      size: 200
    }
  })), safeMailinblackCall(() => mailinblackV2Request(apiUrl, session, 'admin', 'users', {
    method: 'GET',
    query: {
      page: 0,
      size: 200
    }
  }))]);
  const domains = domainsRes.ok ? parseList(domainsRes.data).map(item => normalizeListItem(item, normalizeDomain)).filter(Boolean) : [];
  const users = usersRes.ok ? parseList(usersRes.data).map(item => normalizeListItem(item, normalizeUser)).filter(Boolean) : [];
  return normalizeMailinblackCustomer({
    id: customerId || session.clientId,
    clientId: session.clientId,
    name: credentials.label || 'Mailinblack customer',
    domain: domains[0]?.name || null,
    usersCount: users.length,
    domainsCount: domains.length,
    status: 'active'
  }, session);
}
export async function mailinblackBuildDashboard(apiUrl, credentials, customerId = null) {
  const session = await mailinblackAuthenticate(credentials);
  const effectiveCustomerId = customerId || session.clientId || credentials?.authClientId || null;
  const [senders, spools, detectSpools, domains, users, customerRes] = await Promise.all([mailinblackFetchListSection(apiUrl, session, credentials, 'protect', 'senders', normalizeSender, {
    exploited: true
  }), mailinblackFetchListSection(apiUrl, session, credentials, 'protect', 'spools', normalizeSpool, {
    exploited: true
  }), mailinblackFetchListSection(apiUrl, session, credentials, 'protect', 'detect/spools', normalizeSpool, {
    exploited: false
  }), mailinblackFetchListSection(apiUrl, session, credentials, 'admin', 'domains', normalizeDomain, {
    exploited: true
  }), mailinblackFetchListSection(apiUrl, session, credentials, 'admin', 'users', normalizeUser, {
    exploited: true
  }), effectiveCustomerId ? safeMailinblackCall(() => mailinblackGetCustomer(apiUrl, credentials, effectiveCustomerId)) : Promise.resolve({
    ok: false,
    data: null,
    permissionDenied: false,
    error: null
  })]);
  const customer = customerRes.ok && customerRes.data ? {
    status: 'ok',
    data: customerRes.data,
    error: null
  } : {
    status: effectiveCustomerId ? 'ok' : 'empty',
    data: effectiveCustomerId ? normalizeMailinblackCustomer({
      id: effectiveCustomerId,
      clientId: session.clientId || effectiveCustomerId,
      name: credentials.label || 'Mailinblack customer',
      domain: domains.items?.[0]?.name || null,
      usersCount: users.total || users.items?.length || 0,
      domainsCount: domains.total || domains.items?.length || 0,
      status: 'active'
    }, session) : null,
    error: customerRes.error
  };
  return {
    fetchedAt: new Date().toISOString(),
    session: {
      clientId: session.clientId || credentials?.authClientId || null,
      userId: session.userId
    },
    customerId: effectiveCustomerId,
    sections: {
      customer,
      senders,
      spools,
      detectSpools,
      domains,
      users
    }
  };
}
export function formatMailinblackSyncPayload(customer, mappingMode, mailinblackTenantId, extra = {}) {
  if (!customer) return null;
  const dashboard = extra.dashboard || null;
  const domainsSection = dashboard?.sections?.domains;
  const usersSection = dashboard?.sections?.users;
  return {
    solution: 'Mailinblack Protect',
    providerId: 'mailinblack',
    logiciel: 'Mailinblack Protect',
    nom: customer.name,
    name: customer.name,
    mappingMode,
    mailinblackTenantId: mappingMode === 'dedicated' ? mailinblackTenantId : null,
    customerId: customer.id,
    customerName: customer.name,
    domain: customer.domain || '',
    utilisateursProteges: usersSection?.total ?? customer.usersCount ?? (usersSection?.items?.length != null ? usersSection.items.length : 0),
    domainesSurveilles: domainsSection?.total ?? customer.domainsCount ?? (domainsSection?.items?.length != null ? domainsSection.items.length : 0),
    expiration: customer.expiration || '',
    syncData: {
      customer,
      dashboard,
      status: customer.status || null,
      lastSync: new Date().toISOString()
    }
  };
}
