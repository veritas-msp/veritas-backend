// ───────────────────────────────────────────────
// 📦 Route OVH — Intégration avec l'API OVH pour la gestion des domaines
// ───────────────────────────────────────────────

import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import crypto from 'crypto';
import { getSettingsMap } from '../../utils/settingsHelper.js';

const router = express.Router();


// Toutes les routes OVH nécessitent une authentification
router.use(verifyJWT);

// ───────────────────────────────────────────────
// 🔧 Fonction utilitaire : Récupérer les settings OVH
// ───────────────────────────────────────────────
async function getOvhSettings() {
  try {
    const settings = await getSettingsMap(['OVH_APPLICATION_KEY', 'OVH_APPLICATION_SECRET', 'OVH_CONSUMER_KEY']);
    return {
      applicationKey: settings.OVH_APPLICATION_KEY || '',
      applicationSecret: settings.OVH_APPLICATION_SECRET || '',
      consumerKey: settings.OVH_CONSUMER_KEY || ''
    };
  } catch (error) {
    return null;
  }
}

async function getOvhCredentialsFromRequest(req) {
  const bodyKey = (req.body?.OVH_APPLICATION_KEY || req.body?.applicationKey || '').trim();
  const bodySecret = (req.body?.OVH_APPLICATION_SECRET || req.body?.applicationSecret || '').trim();
  const bodyConsumer = (req.body?.OVH_CONSUMER_KEY || req.body?.consumerKey || '').trim();

  if (bodyKey && bodySecret && bodyConsumer) {
    return {
      applicationKey: bodyKey,
      applicationSecret: bodySecret,
      consumerKey: bodyConsumer,
      source: 'inline',
    };
  }

  const settings = await getOvhSettings();
  if (!settings?.applicationKey || !settings?.applicationSecret || !settings?.consumerKey) {
    throw new Error(
      'Paramètres OVH non configurés. Veuillez configurer Application Key, Application Secret et Consumer Key.'
    );
  }

  return { ...settings, source: 'settings' };
}

// ───────────────────────────────────────────────
// 🔐 Fonction utilitaire : Créer la signature OVH
// ───────────────────────────────────────────────
function createOvhSignature(method, url, body, timestamp, applicationSecret, consumerKey) {
  // Format OVH: $1$ + SHA1(AS + CK + METHOD + URL + BODY + TS)
  // AS = Application Secret, CK = Consumer Key
  const toSign = `${applicationSecret}+${consumerKey}+${method}+${url}+${body}+${timestamp}`;
  const hash = crypto.createHash('sha1').update(toSign).digest('hex');
  return `$1$${hash}`;
}

// ───────────────────────────────────────────────
// 📡 Fonction utilitaire : Appel API OVH
// ───────────────────────────────────────────────
async function callOvhApi(endpoint, method = 'GET', body = null, settingsOverride = null) {
  const settings = settingsOverride || await getOvhSettings();
  
  if (!settings || !settings.applicationKey || !settings.applicationSecret || !settings.consumerKey) {
    throw new Error('Paramètres OVH non configurés. Veuillez configurer Application Key, Application Secret et Consumer Key dans les paramètres.');
  }

  const baseUrl = 'https://eu.api.ovh.com/1.0';
  const fullUrl = `${baseUrl}${endpoint}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyString = body ? JSON.stringify(body) : '';
  
  // Pour la signature, utiliser l'URL complète avec le protocole
  const signature = createOvhSignature(
    method,
    fullUrl,
    bodyString,
    timestamp,
    settings.applicationSecret,
    settings.consumerKey
  );

  const headers = {
    'X-Ovh-Application': settings.applicationKey,
    'X-Ovh-Consumer': settings.consumerKey,
    'X-Ovh-Signature': signature,
    'X-Ovh-Timestamp': timestamp,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  const fetchOptions = {
    method: method,
    headers: headers
  };

  if (body && method !== 'GET') {
    fetchOptions.body = bodyString;
  }

  const fetch = (await import('node-fetch')).default;
  const response = await fetch(fullUrl, fetchOptions);

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch {
      errorData = { message: errorText || `HTTP ${response.status}` };
    }
    
    // Gestion spécifique de l'erreur de permissions
    if (errorData.message && (errorData.message.includes('not been granted') || errorData.message.includes('Invalid credential'))) {
      throw new Error(
        `Permissions insuffisantes pour ${method} ${endpoint}. ` +
        `Le Consumer Key doit avoir les permissions GET. ` +
        `Options : ` +
        `1) GET /domain/* (recommandé) : https://eu.api.ovh.com/createToken/index.cgi?GET=/domain/* ` +
        `2) GET /* (tous les droits GET) : https://eu.api.ovh.com/createToken/index.cgi?GET=/*`
      );
    }
    
    throw new Error(errorData.message || errorData.error || `HTTP ${response.status}: ${response.statusText}`);
  }

  // Si la réponse est vide (204 No Content), retourner un objet vide
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return {};
  }

  return await response.json();
}

async function getOvhConfigStatus() {
  const settings = await getOvhSettings();
  const configured = Boolean(
    settings?.applicationKey && settings?.applicationSecret && settings?.consumerKey
  );
  return {
    configured,
    endpoint: 'https://eu.api.ovh.com/1.0',
  };
}

async function listOvhDnsZones() {
  try {
    const zones = await callOvhApi('/domain/zone');
    return Array.isArray(zones) ? zones : [];
  } catch {
    return [];
  }
}

const OVH_DOMAINS_CACHE_TTL_MS = 2 * 60 * 1000;
const ovhDomainsCache = {
  light: { data: null, expiresAt: 0 },
  full: { data: null, expiresAt: 0 },
};

function readOvhDomainsCache(mode) {
  const entry = ovhDomainsCache[mode];
  if (!entry?.data || Date.now() > entry.expiresAt) return null;
  return entry.data;
}

function writeOvhDomainsCache(mode, data) {
  ovhDomainsCache[mode] = {
    data,
    expiresAt: Date.now() + OVH_DOMAINS_CACHE_TTL_MS,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, list.length));
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function fetchOvhDomainServiceInfos(domainName) {
  try {
    return await callOvhApi(`/domain/${encodeURIComponent(domainName)}/serviceInfos`);
  } catch {
    return null;
  }
}

function buildDomainFromServiceInfos(domainName, serviceInfos, dnsZones = null) {
  const renew = serviceInfos?.renew || {};
  const expiration =
    serviceInfos?.expiration || serviceInfos?.expir || renew?.expiration || null;
  const normalizedExpiration = normalizeExpirationDate(expiration);
  const domainLower = String(domainName).toLowerCase();
  let hasDnsZone = false;

  if (Array.isArray(dnsZones)) {
    const zoneSet = new Set(dnsZones.map((zone) => String(zone).toLowerCase()));
    hasDnsZone =
      zoneSet.has(domainLower) ||
      [...zoneSet].some((zone) => domainLower === zone || domainLower.endsWith(`.${zone}`));
  }

  return {
    domain: domainName,
    name: domainName,
    nom: domainName,
    registrar: 'OVH',
    providerId: 'ovh',
    expiration: normalizedExpiration,
    expirationDate: normalizedExpiration,
    autoRenew: Boolean(renew.automatic),
    manualPayment: Boolean(renew.manualPayment),
    deleteAtExpiration: Boolean(renew.deleteAtExpiration),
    renewalMode: formatRenewalMode(renew),
    renewalPeriod: renew.period ?? serviceInfos?.renewPeriod ?? null,
    serviceId: serviceInfos?.serviceId ?? null,
    serviceStatus: serviceInfos?.status ?? null,
    creationDate: normalizeExpirationDate(serviceInfos?.creation),
    dnsZone: hasDnsZone ? domainName : null,
    hasDnsZone,
    syncData: serviceInfos
      ? { serviceInfos, lastSync: new Date().toISOString() }
      : null,
  };
}

async function fetchOvhDomainLightDetails(domainName, dnsZones = null) {
  const serviceInfos = await fetchOvhDomainServiceInfos(domainName);
  return buildDomainFromServiceInfos(domainName, serviceInfos, dnsZones);
}

async function fetchAllOvhDomainsLight({ useCache = true } = {}) {
  if (useCache) {
    const cached = readOvhDomainsCache('light');
    if (cached) return cached;
  }

  const domainList = await callOvhApi('/domain');
  if (!Array.isArray(domainList)) {
    throw new Error('Format de réponse inattendu de l\'API OVH');
  }

  const dnsZones = await listOvhDnsZones();
  const domainsWithDetails = await mapWithConcurrency(domainList, 6, async (domainName) => {
    try {
      return await fetchOvhDomainLightDetails(domainName, dnsZones);
    } catch {
      return buildDomainFromServiceInfos(domainName, null, dnsZones);
    }
  });

  writeOvhDomainsCache('light', domainsWithDetails);
  return domainsWithDetails;
}

function normalizeExpirationDate(raw) {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function formatRenewalMode(renew = {}) {
  if (renew.automatic) return 'automatic';
  if (renew.manualPayment) return 'manual';
  return 'unknown';
}

export async function fetchOvhDomainDetails(domainName, dnsZones = null) {
  const zones = dnsZones ?? (await listOvhDnsZones());
  const zoneSet = new Set(zones.map((zone) => String(zone).toLowerCase()));

  const [domainInfo, serviceInfosResult] = await Promise.allSettled([
    callOvhApi(`/domain/${encodeURIComponent(domainName)}`),
    callOvhApi(`/domain/${encodeURIComponent(domainName)}/serviceInfos`),
  ]);

  const domainData = domainInfo.status === 'fulfilled' ? domainInfo.value : {};
  const serviceInfos =
    serviceInfosResult.status === 'fulfilled' ? serviceInfosResult.value : null;

  const renew = serviceInfos?.renew || {};
  const expiration =
    serviceInfos?.expiration || serviceInfos?.expir || renew?.expiration || null;
  const normalizedExpiration = normalizeExpirationDate(expiration);
  const domainLower = String(domainName).toLowerCase();
  const hasDnsZone =
    zoneSet.has(domainLower) ||
    [...zoneSet].some(
      (zone) => domainLower === zone || domainLower.endsWith(`.${zone}`)
    );

  return {
    domain: domainName,
    name: domainName,
    nom: domainName,
    registrar: 'OVH',
    providerId: 'ovh',
    expiration: normalizedExpiration,
    expirationDate: normalizedExpiration,
    autoRenew: Boolean(renew.automatic),
    manualPayment: Boolean(renew.manualPayment),
    deleteAtExpiration: Boolean(renew.deleteAtExpiration),
    renewalMode: formatRenewalMode(renew),
    renewalPeriod: renew.period ?? serviceInfos?.renewPeriod ?? null,
    serviceId: serviceInfos?.serviceId ?? null,
    serviceStatus: serviceInfos?.status ?? null,
    creationDate: normalizeExpirationDate(serviceInfos?.creation),
    dnsZone: hasDnsZone ? domainName : null,
    hasDnsZone,
    whoisOwner: domainData.whoisOwner || null,
    nameServers: Array.isArray(domainData.nameServers) ? domainData.nameServers : [],
    owo: domainData.owo ?? null,
    syncData: {
      domain: domainData,
      serviceInfos,
      lastSync: new Date().toISOString(),
    },
  };
}

async function fetchAllOvhDomainsWithDetails({ useCache = true } = {}) {
  if (useCache) {
    const cached = readOvhDomainsCache('full');
    if (cached) return cached;
  }

  const domainList = await callOvhApi('/domain');
  if (!Array.isArray(domainList)) {
    throw new Error('Format de réponse inattendu de l\'API OVH');
  }

  const dnsZones = await listOvhDnsZones();
  const domainsWithDetails = await mapWithConcurrency(domainList, 6, async (domainName) => {
    try {
      return await fetchOvhDomainDetails(domainName, dnsZones);
    } catch {
      return buildDomainFromServiceInfos(domainName, null, dnsZones);
    }
  });

  writeOvhDomainsCache('full', domainsWithDetails);
  return domainsWithDetails;
}

// ───────────────────────────────────────────────
// ⚙️ GET /config — Statut de la configuration globale
// ───────────────────────────────────────────────
router.get('/config', async (_req, res) => {
  try {
    const status = await getOvhConfigStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/test', async (req, res) => {
  try {
    const credentials = await getOvhCredentialsFromRequest(req);
    const domains = await callOvhApi('/domain', 'GET', null, credentials);
    const domainList = Array.isArray(domains) ? domains : [];

    res.json({
      success: true,
      message: 'Connexion à l\'API OVH réussie',
      tenant: {
        endpoint: 'https://eu.api.ovh.com/1.0',
        applicationKeyPreview: `${credentials.applicationKey.substring(0, 6)}…`,
        domainsCount: domainList.length,
        domains: domainList.slice(0, 50),
        testedAt: new Date().toISOString(),
      },
      domainsCount: domainList.length,
      endpoint: 'https://eu.api.ovh.com/1.0',
    });
  } catch (error) {
    let statusCode = 500;
    if (error.message && error.message.includes('non configurés')) {
      statusCode = 400;
    } else if (error.message && error.message.includes('Permissions insuffisantes')) {
      statusCode = 403;
    }
    
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Erreur de connexion à l\'API OVH',
      details: error.message
    });
  }
});

// ───────────────────────────────────────────────
// 📋 GET /ovh/domains — Récupérer la liste des domaines
// ───────────────────────────────────────────────
router.get('/domains', async (req, res) => {
  try {
    // Vérifier d'abord que les paramètres sont configurés
    const settings = await getOvhSettings();
    if (!settings || !settings.applicationKey || !settings.applicationSecret || !settings.consumerKey) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres OVH non configurés',
        details: 'Veuillez configurer Application Key, Application Secret et Consumer Key dans les paramètres d\'administration.'
      });
    }

    const light =
      req.query.light === '1' ||
      req.query.light === 'true' ||
      req.query.mode === 'light';
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const domainsWithDetails = light
      ? await fetchAllOvhDomainsLight({ useCache: !refresh })
      : await fetchAllOvhDomainsWithDetails({ useCache: !refresh });

    res.json({
      success: true,
      domains: domainsWithDetails,
      total: domainsWithDetails.length,
      mode: light ? 'light' : 'full',
      cached: !refresh,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Impossible de récupérer les domaines OVH',
      details: error.message
    });
  }
});

// ───────────────────────────────────────────────
// 🔄 GET /ovh/domain/:domainName — Récupérer les informations d'un domaine spécifique
// ───────────────────────────────────────────────
router.get('/domain/:domainName', async (req, res) => {
  try {
    const { domainName } = req.params;
    
    // Vérifier d'abord que les paramètres sont configurés
    const settings = await getOvhSettings();
    if (!settings || !settings.applicationKey || !settings.applicationSecret || !settings.consumerKey) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres OVH non configurés',
        details: 'Veuillez configurer Application Key, Application Secret et Consumer Key dans les paramètres d\'administration.'
      });
    }

    const domain = await fetchOvhDomainDetails(domainName);

    res.json({
      success: true,
      domain,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || `Impossible de récupérer les informations du domaine ${req.params.domainName}`,
      details: error.message
    });
  }
});

// ───────────────────────────────────────────────
// 🔄 POST /ovh/domains/sync-all — Synchroniser tous les domaines OVH pour tous les clients
// ───────────────────────────────────────────────
router.post('/domains/sync-all', async (req, res) => {
  try {
    // Vérifier d'abord que les paramètres sont configurés
    const settings = await getOvhSettings();
    if (!settings || !settings.applicationKey || !settings.applicationSecret || !settings.consumerKey) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres OVH non configurés',
        details: 'Veuillez configurer Application Key, Application Secret et Consumer Key dans les paramètres d\'administration.'
      });
    }

    // Récupérer tous les clients
    const clientsResult = await pool.query('SELECT id, name FROM v_b_clients ORDER BY name');
    const clients = clientsResult.rows;

    // Récupérer la liste des domaines depuis OVH
    const domainList = await callOvhApi('/domain');
    
    if (!Array.isArray(domainList)) {
      return res.status(500).json({
        success: false,
        error: 'Format de réponse inattendu de l\'API OVH'
      });
    }

    let syncedCount = 0;
    let errorCount = 0;

    // Pour chaque domaine OVH, récupérer les détails et sauvegarder
    for (const domainName of domainList) {
      try {
        // Récupérer les informations du domaine et l'expiration
        const [domainInfo, expirationInfo] = await Promise.allSettled([
          callOvhApi(`/domain/${encodeURIComponent(domainName)}`),
          callOvhApi(`/domain/${encodeURIComponent(domainName)}/serviceInfos`).catch(() => null)
        ]);
        
        const domainData = domainInfo.status === 'fulfilled' ? domainInfo.value : {};
        const expirationData = expirationInfo.status === 'fulfilled' && expirationInfo.value ? expirationInfo.value : null;
        const expiration = expirationData?.expiration || expirationData?.expir || null;

        // Trouver le client associé (par défaut, on peut utiliser le premier client ou créer une logique de mapping)
        // Pour l'instant, on va créer un domaine pour chaque client qui a le module NDD activé
        // ou créer un domaine global si aucun client spécifique n'est trouvé
        
        // Vérifier si le domaine existe déjà
        const existingDomain = await pool.query(
          `SELECT id, client_id FROM v_b_clients_m_ndd 
           WHERE data->>'nom' = $1 OR data->>'name' = $1 OR item_key = $1`,
          [domainName]
        );

        const domainDataToSave = {
          nom: domainName,
          name: domainName,
          registrar: 'OVH',
          expiration: expiration,
          expirationDate: expiration
        };

        if (existingDomain.rows.length > 0) {
          // Mettre à jour le domaine existant
          await pool.query(
            `UPDATE v_b_clients_m_ndd 
             SET data = $1, updated_at = NOW()
             WHERE id = $2`,
            [JSON.stringify(domainDataToSave), existingDomain.rows[0].id]
          );
        } else {
          // Créer un nouveau domaine pour chaque client qui a le module NDD activé
          // Ou créer un domaine global si aucun client spécifique
          const clientsWithNDD = await pool.query(
            `SELECT DISTINCT client_id FROM v_b_clients_m_ndd`
          );
          
          if (clientsWithNDD.rows.length > 0) {
            // Créer le domaine pour le premier client avec NDD (ou une logique plus complexe)
            const clientId = clientsWithNDD.rows[0].client_id;
            await pool.query(
              `INSERT INTO v_b_clients_m_ndd (client_id, item_key, data, is_active, created_at, updated_at)
               VALUES ($1, $2, $3, true, NOW(), NOW())`,
              [clientId, domainName, JSON.stringify(domainDataToSave)]
            );
          } else {
            // Si aucun client n'a de module NDD, créer pour le premier client
            if (clients.length > 0) {
              await pool.query(
                `INSERT INTO v_b_clients_m_ndd (client_id, item_key, data, is_active, created_at, updated_at)
                 VALUES ($1, $2, $3, true, NOW(), NOW())`,
                [clients[0].id, domainName, JSON.stringify(domainDataToSave)]
              );
            }
          }
        }

        syncedCount++;
      } catch (domainError) {
        console.error(`Erreur lors de la synchronisation du domaine ${domainName}:`, domainError);
        errorCount++;
      }
    }

    res.json({
      success: true,
      message: `Synchronisation terminée: ${syncedCount} domaine(s) synchronisé(s)${errorCount > 0 ? `, ${errorCount} erreur(s)` : ''}`,
      syncedCount,
      errorCount,
      totalDomains: domainList.length
    });
  } catch (error) {
    console.error('Erreur lors de la synchronisation des domaines OVH:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Impossible de synchroniser les domaines OVH',
      details: error.message
    });
  }
});

export default router;

