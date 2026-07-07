import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import fetch from "node-fetch";
import { getSettingsMap } from "../../utils/settingsHelper.js";

const router = express.Router();

// ───────────────────────────────────────────────
// 🔐 Configuration Microsoft Graph API
// ───────────────────────────────────────────────

// Cache pour les tokens d'accès (évite de demander un nouveau token à chaque requête)
// IMPORTANT: Le cache doit être indexé par tenantId pour éviter de mélanger les tokens entre différents clients
// Structure: { [tenantId]: { token: string, expiresAt: number } }
let tokenCache = {};

/**
 * Récupère les paramètres Office 365 depuis la base de données (globaux)
 */
export async function getOffice365Settings() {
  try {
    const map = await getSettingsMap(); // récupère toutes les clés déchiffrées
    const settings = {};
    Object.entries(map).forEach(([k, v]) => {
      if (k.startsWith('office365_')) {
        const cleanKey = k.replace('office365_', '');
        settings[cleanKey] = v;
      }
    });

    return settings;
  } catch (error) {
    return null;
  }
}

/**
 * Récupère les credentials Office 365 spécifiques à un client
 * @param {number} clientId - ID du client
 * @returns {Object|null} Credentials du client ou null si non configurés
 */
export async function getClientOffice365Credentials(clientId) {
  if (!clientId) return null;
  
  try {
    const result = await pool.query(
      `SELECT tenant_id, client_id_azure, client_secret_encrypted, iv, auth_tag
       FROM v_b_clients_azure 
       WHERE client_id = $1`,
      [clientId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const cred = result.rows[0];
    
    // Déchiffrer le secret
    const { decrypt } = await import("../../utils/encryption.js");
    const clientSecret = decrypt(
      cred.client_secret_encrypted,
      cred.iv,
      cred.auth_tag
    );
    
    return {
      tenantId: cred.tenant_id,
      clientId: cred.client_id_azure,
      clientSecret: clientSecret
    };
  } catch (error) {
    return null;
  }
}

/**
 * Obtient un token d'accès Microsoft Graph via Client Credentials Flow
 * Utilise un cache indexé par tenantId pour éviter de mélanger les tokens entre différents clients
 * IMPORTANT: Chaque tenantId doit avoir son propre token
 */
export async function getMicrosoftGraphToken(tenantId, clientId, clientSecret) {
  try {
    // Vérifier si le token en cache pour CE tenantId est encore valide
    const cachedToken = tokenCache[tenantId];
    if (cachedToken && cachedToken.token && cachedToken.expiresAt && Date.now() < cachedToken.expiresAt - 300000) {
      return cachedToken.token;
    }

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    
    const params = new URLSearchParams({
      client_id: clientId,
      scope: "https://graph.microsoft.com/.default",
      client_secret: clientSecret,
      grant_type: "client_credentials"
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erreur d'authentification Microsoft: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // Mettre en cache le token avec sa date d'expiration pour CE tenantId spécifique
    // Les tokens Microsoft expirent généralement après 3600 secondes (1 heure)
    const expiresIn = data.expires_in || 3600;
    tokenCache[tenantId] = {
      token: data.access_token,
      expiresAt: Date.now() + (expiresIn * 1000)
    };
    
    return data.access_token;
  } catch (error) {
    // Réinitialiser le cache pour ce tenantId en cas d'erreur
    if (tokenCache[tenantId]) {
      delete tokenCache[tenantId];
    }
    throw error;
  }
}

/**
 * Formate les bytes en format lisible (KB, MB, GB, TB)
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

/**
 * Parse le CSV retourné par les Reports API de Microsoft Graph
 * Gère les valeurs entre guillemets et les virgules dans les valeurs
 */
function parseCSV(csvText) {
  if (!csvText || typeof csvText !== 'string') return [];
  
  const lines = csvText.split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];
  
  // Parser la première ligne (headers) en gérant les guillemets
  const parseCSVLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };
  
  const headers = parseCSVLine(lines[0]).map(h => h.replace(/^"|"$/g, ''));
  const data = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]).map(v => v.replace(/^"|"$/g, ''));
    if (values.length === headers.length) {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = values[index];
      });
      data.push(obj);
    }
  }
  
  return data;
}

/**
 * Détecte si un compte est probablement un compte de service (sync, bot, automation, etc.)
 * Basé sur les conventions courantes Azure AD / Entra ID. Critères : contient (nom, UPN ou email).
 */
function isLikelyServiceAccount(displayName, userPrincipalName, mail) {
  const dn = (displayName || '').toString();
  const upn = (userPrincipalName || '').toString();
  const m = (mail || '').toString();
  const combined = `${dn} ${upn} ${m}`.toLowerCase();
  const patterns = [
    /aad_/i, /msol_/i, /sync_/i, /svc_/i, /service_/i,
    /\$@/,  // UPN avec $ (compte technique)
    /_srv/i, /_service/i, /_sync/i,
    /compte de service|service account|compte service/i,
    /bot\./i, /bot@/i, /connector/i, /automation/i,
    /azure ad sync|ad sync|dirsync|aadconnect|dir sync/i,
    /directory synchronization|synchronization service|on-premises/i,  // ex. On-Premises Directory Synchronization Service Account
    /healthmailbox|systemmailbox|federatedemail/i  // boîtes système Exchange
  ];
  return patterns.some(p => p.test(combined));
}

/**
 * Récupère une valeur dans un objet (ex. ligne de rapport CSV) en essayant plusieurs clés.
 * Supporte les variantes de noms (casse, espaces) pour les rapports Microsoft.
 */
function getReportRowValue(row, possibleKeys) {
  if (!row || typeof row !== 'object') return null;
  for (const key of possibleKeys) {
    if (row[key] != null && row[key] !== '') return row[key];
  }
  const keysLower = Object.keys(row).reduce((acc, k) => { acc[k.toLowerCase().trim()] = k; return acc; }, {});
  for (const key of possibleKeys) {
    const k = key.toLowerCase().trim();
    if (keysLower[k] != null && row[keysLower[k]] != null && row[keysLower[k]] !== '') return row[keysLower[k]];
  }
  return null;
}

// ───────────────────────────────────────────────
// 🗂️ Helpers de traduction Secure Score
// ───────────────────────────────────────────────
const secureScorePhraseDictionary = [
  { pattern: /Multi-factor authentication/gi, replacement: "authentification multifacteur" },
  { pattern: /multi factor authentication/gi, replacement: "authentification multifacteur" },
  { pattern: /Multi-Factor Authentication/gi, replacement: "authentification multifacteur" },
  { pattern: /Enable/gi, replacement: "Activer" },
  { pattern: /Require/gi, replacement: "Exiger" },
  { pattern: /Turn on/gi, replacement: "Activer" },
  { pattern: /Turn off/gi, replacement: "Désactiver" },
  { pattern: /Configure/gi, replacement: "Configurer" },
  { pattern: /Review/gi, replacement: "Vérifier" },
  { pattern: /Ensure/gi, replacement: "S'assurer" },
  { pattern: /Disallow/gi, replacement: "Interdire" },
  { pattern: /Prevent/gi, replacement: "Empêcher" },
  { pattern: /Block/gi, replacement: "Bloquer" },
  { pattern: /Require/gi, replacement: "Exiger" },
  { pattern: /Allow/gi, replacement: "Autoriser" },
  { pattern: /Users/gi, replacement: "utilisateurs" },
  { pattern: /Admins/gi, replacement: "administrateurs" },
  { pattern: /Accounts/gi, replacement: "comptes" },
  { pattern: /Password/gi, replacement: "mot de passe" },
  { pattern: /Passwords/gi, replacement: "mots de passe" },
  { pattern: /Sign-in/gi, replacement: "connexion" },
  { pattern: /Sign in/gi, replacement: "connexion" },
  { pattern: /Devices/gi, replacement: "appareils" },
  { pattern: /Device/gi, replacement: "appareil" },
  { pattern: /Policy/gi, replacement: "stratégie" },
  { pattern: /Policies/gi, replacement: "stratégies" },
  { pattern: /Legacy/gi, replacement: "héritées" },
  { pattern: /connections/gi, replacement: "connexions" },
  { pattern: /applications/gi, replacement: "applications" }
];

const secureScoreCategoryDictionary = {
  Identity: "Identité",
  Data: "Données",
  Device: "Appareils",
  Applications: "Applications",
  Apps: "Applications",
  Infrastructure: "Infrastructure",
  Security: "Sécurité",
  General: "Général"
};

function translateSecureScoreText(text) {
  if (!text || typeof text !== "string") return text;
  let translated = text;
  secureScorePhraseDictionary.forEach(({ pattern, replacement }) => {
    translated = translated.replace(pattern, replacement);
  });
  // Nettoyer les espaces multiples
  translated = translated.replace(/\s+/g, " ").trim();
  // Lettre majuscule initiale si phrase non vide
  if (translated.length > 0) {
    translated = translated.charAt(0).toUpperCase() + translated.slice(1);
  }
  return translated;
}

function translateRecommendationState(state) {
  const normalized = (state || "").toLowerCase();
  switch (normalized) {
    case "completed":
    case "resolved":
      return "Terminé";
    case "inprogress":
    case "in-progress":
      return "En cours";
    case "active":
      return "Actif";
    case "acknowledged":
      return "Reconnu";
    case "todo":
    case "notstarted":
      return "À traiter";
    default:
      return "Inconnu";
  }
}

function translateCategoryLabel(category) {
  if (!category) return "Général";
  const key = category.trim();
  return secureScoreCategoryDictionary[key] || secureScoreCategoryDictionary[key.charAt(0).toUpperCase() + key.slice(1)] || category;
}

function computeRecommendationPriority(profile) {
  // Utiliser le champ priority direct si disponible (depuis /directory/recommendations)
  const priorityDirect = (profile.priority || "").toLowerCase();
  if (priorityDirect === "high" || priorityDirect === "élevée" || priorityDirect === "élevé") {
    return { label: "Élevée", level: 3 };
  } else if (priorityDirect === "medium" || priorityDirect === "moyenne" || priorityDirect === "moyen") {
    return { label: "Moyenne", level: 2 };
  } else if (priorityDirect === "low" || priorityDirect === "faible") {
    return { label: "Faible", level: 1 };
  }
  
  // Sinon, utiliser la logique existante
  const rank = typeof profile.rank === "number" ? profile.rank : null;
  const maxScore = typeof profile.maxScore === "number" ? profile.maxScore : 0;
  const tier = (profile.tier || "").toLowerCase();

  let level = 0;

  if (rank !== null) {
    if (rank <= 20) level = 3;
    else if (rank <= 60) level = 2;
    else level = 1;
  } else if (tier === "core") {
    level = 3;
  } else if (tier === "advanced") {
    level = 2;
  } else if (maxScore >= 15) {
    level = 3;
  } else if (maxScore >= 8) {
    level = 2;
  } else if (maxScore > 0) {
    level = 1;
  }

  let label = "Non classée";
  if (level === 3) label = "Élevée";
  else if (level === 2) label = "Moyenne";
  else if (level === 1) label = "Faible";

  return { label, level };
}

/**
 * Transforme la réponse Graph (/directory/recommendations ou /security/secureScoreControlProfiles)
 * en liste de recommandations triée (points, priorité).
 */
function mapSecureScoreProfilesToRecommendations(secureScoreProfiles) {
  if (!secureScoreProfiles?.value || !Array.isArray(secureScoreProfiles.value)) {
    return [];
  }
  const isDirectoryRecommendations =
    secureScoreProfiles.value.length > 0 &&
    (secureScoreProfiles.value[0].displayName !== undefined ||
      secureScoreProfiles.value[0].status !== undefined);

  const filteredRecommendations = secureScoreProfiles.value.slice();

  return filteredRecommendations
    .map((rec) => {
      const priorityInfo = computeRecommendationPriority(rec);

      if (isDirectoryRecommendations) {
        return {
          id: rec.id,
          title: rec.displayName || rec.title || "Recommandation",
          titleFr: translateSecureScoreText(rec.displayName || rec.title || "Recommandation"),
          rank: typeof rec.rank === "number" ? rec.rank : null,
          priorityLabel: priorityInfo.label,
          priorityLevel: priorityInfo.level,
          category: rec.category || rec.featureAreas?.[0] || "Général",
          categoryFr: translateCategoryLabel(rec.category || rec.featureAreas?.[0] || "Général"),
          actionType: rec.actionType || null,
          service: rec.service || null,
          licenseRequirement: rec.licenseRequirement || "Non spécifié",
          maxScore: rec.maxScore || 0,
          currentScore: rec.currentScore || 0,
          state: rec.status || rec.state || "unknown",
          stateLabel: translateRecommendationState(rec.status || rec.state),
          implementationStatus: rec.implementationStatus || null,
          remediation: rec.insights || rec.remediation || null,
          remediationFr: translateSecureScoreText(rec.insights || rec.remediation || ""),
          remediationImpact: rec.remediationImpact || null,
          userImpact: rec.userImpact || null,
          userImpactFr: translateSecureScoreText(rec.userImpact || ""),
          threats: rec.threats || [],
          tier: rec.tier || null,
          lastModifiedDateTime: rec.lastModifiedDateTime || rec.createdDateTime || null,
          vendorInformation: rec.vendorInformation || null,
          priority: rec.priority || null,
          recommendationType: rec.recommendationType || null,
        };
      }
      return {
        id: rec.id,
        title: rec.title || rec.name || "Recommandation",
        titleFr: translateSecureScoreText(rec.title || rec.name || "Recommandation"),
        rank: typeof rec.rank === "number" ? rec.rank : null,
        priorityLabel: priorityInfo.label,
        priorityLevel: priorityInfo.level,
        category: rec.controlCategory || rec.category || "Général",
        categoryFr: translateCategoryLabel(rec.controlCategory || rec.category || "Général"),
        actionType: rec.actionType || null,
        service: rec.service || null,
        licenseRequirement: rec.licenseRequirement || "Non spécifié",
        maxScore: rec.maxScore || 0,
        currentScore: rec.currentScore || 0,
        state: rec.state || "unknown",
        stateLabel: translateRecommendationState(rec.state),
        implementationStatus: rec.implementationStatus || null,
        remediation: rec.remediation || null,
        remediationFr: translateSecureScoreText(rec.remediation || ""),
        remediationImpact: rec.remediationImpact || null,
        userImpact: rec.userImpact || null,
        userImpactFr: translateSecureScoreText(rec.userImpact || ""),
        threats: rec.threats || [],
        tier: rec.tier || null,
        lastModifiedDateTime: rec.lastModifiedDateTime || rec.createdDateTime || null,
        vendorInformation: rec.vendorInformation || null,
      };
    })
    .sort((a, b) => {
      const scoreDiff = (b.maxScore || 0) - (a.maxScore || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const priorityDiff = (b.priorityLevel || 0) - (a.priorityLevel || 0);
      if (priorityDiff !== 0) return priorityDiff;
      const rankA = a.rank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.rank ?? Number.MAX_SAFE_INTEGER;
      return rankA - rankB;
    });
}

function getLatestSecureScoreWithControls(secureScoresPayload) {
  if (!secureScoresPayload?.value || !Array.isArray(secureScoresPayload.value)) {
    return null;
  }
  const scored = secureScoresPayload.value
    .filter((score) => Array.isArray(score?.controlScores) && score.controlScores.length > 0)
    .sort((a, b) => {
      const dateA = new Date(a?.createdDateTime || 0);
      const dateB = new Date(b?.createdDateTime || 0);
      return dateB - dateA;
    });
  return scored[0] || null;
}

function extractActionableControlIds(latestSecureScore) {
  if (!latestSecureScore?.controlScores || !Array.isArray(latestSecureScore.controlScores)) {
    return new Set();
  }

  const actionableControlIds = new Set();
  latestSecureScore.controlScores.forEach((control) => {
    const controlId = control?.controlName || control?.controlId || control?.id || null;
    if (!controlId) return;

    const currentScore = Number(
      control?.score ?? control?.currentScore ?? control?.controlScore ?? 0
    );
    const maxScore = Number(
      control?.maxScore ?? control?.controlMaxScore ?? control?.max ?? 0
    );

    // "Pour gagner des points" => garder uniquement les contrôles encore améliorables.
    if (Number.isFinite(maxScore) && maxScore > 0 && currentScore < maxScore) {
      actionableControlIds.add(String(controlId));
      return;
    }

    const status = String(
      control?.state || control?.status || control?.implementationStatus || ""
    ).toLowerCase();
    if (status.includes("todo") || status.includes("inprogress") || status.includes("active")) {
      actionableControlIds.add(String(controlId));
    }
  });

  return actionableControlIds;
}

/**
 * Appel générique à Microsoft Graph API avec support de la pagination et retry automatique
 */
async function callMicrosoftGraph(endpoint, accessToken, options = {}) {
  const { getAllPages = false, isReport = false, maxRetries = 3, useBeta = false } = options;
    const apiVersion = useBeta ? 'beta' : 'v1.0';
    const graphUrl = `https://graph.microsoft.com/${apiVersion}${endpoint}`;
    
    let allData = [];
    let nextLink = graphUrl;
    
  // Fonction helper pour faire un appel avec retry
  const makeRequestWithRetry = async (url, retryCount = 0) => {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": isReport ? "text/csv" : "application/json"
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Erreur Microsoft Graph API: ${response.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorMessage;
        } catch {
          errorMessage += ` - ${errorText}`;
        }
        
        // Gérer les erreurs "Please retry later" et rate limit (429) avec retry
        const isRetryableError = errorMessage.includes('Please retry later') || 
                                errorMessage.includes('retry') || 
                                response.status === 429 ||
                                response.status === 503 ||
                                response.status === 502;
        
        if (isRetryableError && retryCount < maxRetries) {
          // Calculer le délai avec backoff exponentiel (2^retryCount secondes, max 30s)
          const delay = Math.min(Math.pow(2, retryCount) * 1000, 30000);
          
          
          // Attendre avant de réessayer
          await new Promise(resolve => setTimeout(resolve, delay));
          
          // Réessayer
          return makeRequestWithRetry(url, retryCount + 1);
        }
        
        // Ne pas logger comme erreur critique si c'est un rate limit ou "retry later" (même après retries)
        
        throw new Error(errorMessage);
      }
      
      return response;
    } catch (error) {
      // Si c'est une erreur de retry et qu'on a encore des tentatives, relancer
      if (retryCount < maxRetries && (error.message.includes('Please retry later') || error.message.includes('retry') || error.message.includes('429'))) {
        const delay = Math.min(Math.pow(2, retryCount) * 1000, 30000);
        await new Promise(resolve => setTimeout(resolve, delay));
        return makeRequestWithRetry(url, retryCount + 1);
      }
      throw error;
    }
  };
  
  try {
    do {
      const response = await makeRequestWithRetry(nextLink);

      // Si c'est un rapport (CSV), parser le CSV
      if (isReport) {
        const csvText = await response.text();
        const parsedData = parseCSV(csvText);
        if (getAllPages) {
          allData = allData.concat(parsedData);
        } else {
          return { value: parsedData };
        }
        break; // Les rapports ne sont pas paginés
      } else {
        // Sinon, traiter comme du JSON
        const data = await response.json();

        if (getAllPages && data && typeof data === "object") {
          const pageValues = Array.isArray(data.value) ? data.value : [];
          allData = allData.concat(pageValues);
          nextLink = data["@odata.nextLink"] || null;
        } else {
          return data;
        }
      }
    } while (nextLink && getAllPages && !isReport);
    
    // Retourner la structure avec toutes les données paginées
    return { value: allData };
  } catch (error) {
    throw error;
  }
}

// ───────────────────────────────────────────────
// 📋 Routes API
// ───────────────────────────────────────────────

/**
 * GET /api/office365/test
 * Teste la connexion à Microsoft Graph API
 */
router.get("/test", verifyJWT, async (req, res) => {
  try {
    // Essayer d'abord les credentials spécifiques au client si clientId est fourni
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;

    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);

      // Si le client n'a pas de configuration spécifique, retourner une erreur
      // au lieu d'utiliser les settings globaux
      if (!credentials) {
        return res.status(400).json({
          success: false,
          error: `Configuration Azure non trouvée pour le client ${clientId}. Veuillez configurer les credentials Azure spécifiques à ce client.`
        });
      }
    } else {
      // Pour les appels sans clientId spécifié, utiliser les settings globaux
      const settings = await getOffice365Settings();
      if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
        credentials = {
          tenantId: settings.tenant_id,
          clientId: settings.client_id,
          clientSecret: settings.client_secret
        };
      }
    }

    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés. Veuillez configurer tenant_id, client_id et client_secret."
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Tester avec un appel simple (récupérer les informations de l'organisation)
    const orgInfo = await callMicrosoftGraph("/organization", accessToken);

    res.json({
      success: true,
      message: "Connexion à Microsoft Graph API réussie",
      organization: orgInfo.value?.[0]?.displayName || "Organisation inconnue"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors du test de connexion"
    });
  }
});

/**
 * GET /api/office365/licences
 * Récupère toutes les licences Office 365
 */
router.get("/licences", verifyJWT, async (req, res) => {
  try {
    // Essayer d'abord les credentials spécifiques au client si clientId est fourni
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;

    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);

      // Si le client n'a pas de configuration spécifique, retourner une erreur
      // au lieu d'utiliser les settings globaux
      if (!credentials) {
        return res.status(400).json({
          success: false,
          error: `Configuration Azure non trouvée pour le client ${clientId}. Veuillez configurer les credentials Azure spécifiques à ce client.`
        });
      }
    } else {
      // Pour les appels sans clientId spécifié, utiliser les settings globaux
      if (!credentials) {
        const settings = await getOffice365Settings();
        if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
          credentials = {
            tenantId: settings.tenant_id,
            clientId: settings.client_id,
            clientSecret: settings.client_secret
          };
        }
      }
    }
    
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés"
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Récupérer les subscribed SKUs (licences)
    const subscribedSkus = await callMicrosoftGraph("/subscribedSkus", accessToken);

    // Transformer les données pour correspondre au format attendu par le frontend
    const licences = subscribedSkus.value.map(sku => {
      const consumed = sku.consumedUnits || 0;
      const total = sku.prepaidUnits?.enabled || 0;
      const available = Math.max(0, total - consumed);

      return {
        nom: sku.skuPartNumber || sku.displayName || "Licence inconnue",
        total: total,
        utilisees: consumed,
        disponibles: available,
        // Informations supplémentaires
        skuId: sku.skuId,
        displayName: sku.displayName,
        servicePlans: sku.servicePlans || []
      };
    });

    res.json({
      success: true,
      licences: licences
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des licences"
    });
  }
});

/**
 * GET /api/office365/users
 * Récupère les utilisateurs Office 365 avec pagination
 */
router.get("/users", verifyJWT, async (req, res) => {
  try {
    // Essayer d'abord les credentials spécifiques au client si clientId est fourni
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;
    
    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);
    }
    
    // Si pas de credentials client, utiliser les paramètres globaux
    if (!credentials) {
      const settings = await getOffice365Settings();
      if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
        credentials = {
          tenantId: settings.tenant_id,
          clientId: settings.client_id,
          clientSecret: settings.client_secret
        };
      }
    }
    
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés"
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    const pageSize = parseInt(req.query.pageSize) || 100;
    const skip = (parseInt(req.query.page) - 1) * pageSize || 0;
    
    // Construire l'URL avec les paramètres de pagination
    let endpoint = `/users?$top=${pageSize}&$skip=${skip}&$select=displayName,mail,userPrincipalName,jobTitle,department,assignedLicenses`;
    
    if (req.query.filter) {
      endpoint += `&$filter=${encodeURIComponent(req.query.filter)}`;
    }

    const usersData = await callMicrosoftGraph(endpoint, accessToken);

    // Transformer les données pour correspondre au format attendu
    const users = usersData.value.map(user => {
      // Récupérer les noms des licences assignées
      const licenseNames = user.assignedLicenses?.map(license => {
        // Note: Pour obtenir les noms réels des licences, il faudrait faire un appel supplémentaire
        // Pour l'instant, on retourne juste les SKU IDs
        return license.skuId;
      }) || [];

      return {
        name: user.displayName || user.userPrincipalName || "Utilisateur sans nom",
        email: user.mail || user.userPrincipalName || "",
        department: user.department || "",
        title: user.jobTitle || "",
        licenses: licenseNames.join(", "),
        userPrincipalName: user.userPrincipalName
      };
    });

    res.json({
      success: true,
      users: users,
      total: usersData["@odata.count"] || users.length,
      page: parseInt(req.query.page) || 1,
      pageSize: pageSize
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des utilisateurs"
    });
  }
});

/**
 * GET /api/office365/data
 * Récupère toutes les données Office 365 (licences + utilisateurs) en une seule requête
 */
router.get("/data", verifyJWT, async (req, res) => {
  try {
    // Essayer d'abord les credentials spécifiques au client si clientId est fourni
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;

    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);
      
      // Si le client n'a pas de configuration spécifique, retourner une erreur
      // au lieu d'utiliser les settings globaux
      if (!credentials) {
        return res.status(400).json({
          success: false,
          error: `Configuration Azure non trouvée pour le client ${clientId}. Veuillez configurer les credentials Azure spécifiques à ce client.`
        });
      }
    } else {
      // Pour les appels sans clientId spécifié, utiliser les settings globaux
      const settings = await getOffice365Settings();
      if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
        credentials = {
          tenantId: settings.tenant_id,
          clientId: settings.client_id,
          clientSecret: settings.client_secret
        };
      }
    }
    
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés"
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Récupérer les licences et les utilisateurs en parallèle
    // Utiliser getAllPages pour récupérer tous les utilisateurs (pas seulement les 999 premiers)
    // Ajouter signInActivity pour obtenir la date de dernière connexion
    // Essayer aussi de récupérer les utilisateurs actifs via Reports API comme fallback
    // Essayer de récupérer le score d'adoption (peut ne pas être disponible via l'API)
    const [subscribedSkus, usersData, activeUsersReport, signInsData, adoptionScore] = await Promise.all([
      callMicrosoftGraph("/subscribedSkus", accessToken),
      callMicrosoftGraph("/users?$select=displayName,mail,userPrincipalName,jobTitle,department,assignedLicenses,signInActivity,accountEnabled,createdDateTime", accessToken, { getAllPages: true }).catch(err => {
        return callMicrosoftGraph("/users?$select=displayName,mail,userPrincipalName,jobTitle,department,assignedLicenses,accountEnabled,createdDateTime", accessToken, { getAllPages: true });
      }),
      callMicrosoftGraph("/reports/getOffice365ActiveUserDetail(period='D90')", accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph("/auditLogs/signIns?$top=2000&$orderby=createdDateTime desc", accessToken).catch(() => null)
    ]);

    // Créer un mapping des SKU IDs vers les noms de licences pour enrichir les données utilisateurs
    const skuIdToName = {};
    subscribedSkus.value.forEach(sku => {
      skuIdToName[sku.skuId] = sku.skuPartNumber || sku.displayName || "Licence inconnue";
    });

    // Transformer les licences (exclure les licences illimitées)
    const licences = subscribedSkus.value
      .filter(sku => {
        // Filtrer les licences illimitées (>= 10000 ou très grandes valeurs)
        const total = sku.prepaidUnits?.enabled || 0;
        return total < 10000 && total > 0;
      })
      .map(sku => {
        const consumed = sku.consumedUnits || 0;
        const total = sku.prepaidUnits?.enabled || 0;
        const available = Math.max(0, total - consumed);

        return {
          nom: sku.skuPartNumber || sku.displayName || "Licence inconnue",
          total: total,
          utilisees: consumed,
          disponibles: available,
          skuId: sku.skuId,
          displayName: sku.displayName,
          servicePlans: sku.servicePlans || []
        };
      });

    // Créer un mapping des emails/UPN vers la date de dernière connexion (rapport Office 365)
    const emailToLastLogin = {};
    const reportUpnKeys = ['User Principal Name', 'UserPrincipalName', 'User'];
    const reportDateKeys = ['Last Activity Date (UTC)', 'Last Activity Date', 'LastActivityDate'];
    const reportOtherDateKeys = ['Report Refresh Date', 'Exchange Last Activity Date', 'SharePoint Last Activity Date', 'OneDrive Last Activity Date', 'Teams Last Activity Date', 'Yammer Last Activity Date', 'Skype For Business Last Activity Date'];
    if (activeUsersReport && activeUsersReport.value) {
      activeUsersReport.value.forEach(row => {
        const email = (getReportRowValue(row, reportUpnKeys) || '').toString().trim();
        if (!email) return;
        let lastActivity = getReportRowValue(row, reportDateKeys);
        if (lastActivity != null && typeof lastActivity === 'string') lastActivity = lastActivity.trim();
        for (const key of reportOtherDateKeys) {
          const val = row[key];
          if (val) {
            const d = new Date(val);
            if (!isNaN(d.getTime())) {
              const current = lastActivity ? new Date(lastActivity) : null;
              if (!current || d > current) lastActivity = val;
            }
          }
        }
        if (email && lastActivity) {
          emailToLastLogin[email.toLowerCase()] = lastActivity;
        }
      });
    }

    // Fallback : dernière connexion depuis auditLogs/signIns (connexions réussies)
    const signInToLastLogin = {};
    if (signInsData && signInsData.value && Array.isArray(signInsData.value)) {
      signInsData.value.forEach(signIn => {
        if (!signIn.status || signIn.status.errorCode !== 0) return;
        const upn = (signIn.userPrincipalName || signIn.userId || '').toString().trim();
        if (!upn || !signIn.createdDateTime) return;
        if (!signInToLastLogin[upn.toLowerCase()]) signInToLastLogin[upn.toLowerCase()] = signIn.createdDateTime;
      });
    }

    // Transformer les utilisateurs avec les noms de licences et la date de dernière connexion
    const usersListData = Array.isArray(usersData?.value) ? usersData.value : [];
    const users = usersListData.map(user => {
      const licenseNames = user.assignedLicenses
        ?.map(license => skuIdToName[license.skuId] || license.skuId)
        .filter(Boolean)
        .join(", ") || "";

      let lastLoginDate = null;
      if (user.signInActivity && user.signInActivity.lastSignInDateTime) {
        lastLoginDate = user.signInActivity.lastSignInDateTime;
      }
      if (lastLoginDate == null || lastLoginDate === '') {
        const userEmail = (user.mail || user.userPrincipalName || '').toString().toLowerCase().trim();
        const upn = (user.userPrincipalName || '').toString().toLowerCase().trim();
        lastLoginDate = emailToLastLogin[userEmail] || emailToLastLogin[upn] || signInToLastLogin[userEmail] || signInToLastLogin[upn];
      }
      if (lastLoginDate != null && lastLoginDate !== '') {
        const d = new Date(lastLoginDate);
        lastLoginDate = !isNaN(d.getTime()) ? d.toISOString() : null;
      } else {
        lastLoginDate = null;
      }

      const isServiceAccount = isLikelyServiceAccount(user.displayName, user.userPrincipalName, user.mail);
      return {
        name: user.displayName || user.userPrincipalName || "Utilisateur sans nom",
        email: user.mail || user.userPrincipalName || "",
        department: user.department || "",
        title: user.jobTitle || "",
        licenses: licenseNames,
        userPrincipalName: user.userPrincipalName,
        lastLoginDate,
        accountEnabled: user.accountEnabled !== false, // Par défaut true si non spécifié
        createdDate: user.createdDateTime || null,
        isServiceAccount: !!isServiceAccount
      };
    });

    // Traiter le score d'adoption si disponible
    let adoptionScoreData = null;
    if (adoptionScore && adoptionScore.value) {
      // Le format peut varier, essayer différentes structures
      const scoreEntry = Array.isArray(adoptionScore.value) ? adoptionScore.value[0] : adoptionScore.value;
      if (scoreEntry) {
        adoptionScoreData = {
          totalScore: parseInt(scoreEntry['Total Score'] || scoreEntry['TotalScore'] || scoreEntry.totalScore || scoreEntry.score || 0),
          maxScore: parseInt(scoreEntry['Max Score'] || scoreEntry['MaxScore'] || scoreEntry.maxScore || 700),
          peopleExperiences: parseInt(scoreEntry['People Experiences'] || scoreEntry['PeopleExperiences'] || scoreEntry.peopleExperiences || 0),
          technologyExperiences: parseInt(scoreEntry['Technology Experiences'] || scoreEntry['TechnologyExperiences'] || scoreEntry.technologyExperiences || 0),
          reportDate: scoreEntry['Report Date'] || scoreEntry['ReportDate'] || scoreEntry.reportDate || null
        };
      }
    }

    // Construire la payload renvoyée au frontend
    const payload = {
      success: true,
      licences: licences,
      users: users,
      adoptionScore: adoptionScoreData,
      lastUpdate: new Date().toISOString()
    };

    // Si un clientId est fourni, sauvegarder un snapshot dans v_b_clients_m_o365
    if (clientId) {
      try {
        const snapshotData = {
          tenantId: credentials.tenantId || null,
          licences,
          users,
          adoptionScore: adoptionScoreData,
          lastUpdate: payload.lastUpdate
        };

        // Supprimer les anciens snapshots pour ce client / tenant, puis insérer le nouveau
        await pool.query(
          `DELETE FROM v_b_clients_m_o365 
           WHERE client_id = $1 
             AND ($2::text IS NULL OR item_key = $2)`,
          [clientId, credentials.tenantId || null]
        );

        await pool.query(
          `INSERT INTO v_b_clients_m_o365 (client_id, item_key, name, data, is_active)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            clientId,
            credentials.tenantId || null,
            'Microsoft 365',
            snapshotData,
            true
          ]
        );
      } catch (dbError) {
        console.error('Erreur lors de la sauvegarde des données Office 365 dans v_b_clients_m_o365:', dbError);
        // On ne bloque pas la réponse pour une erreur de persistance
      }
    }

    res.json(payload);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des données"
    });
  }
});

/**
 * GET /api/office365/exchange
 * Récupère les données Exchange Online
 */
router.get("/exchange", verifyJWT, async (req, res) => {
  try {
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;
    
    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);
      
      // Si le client n'a pas de configuration spécifique, retourner une erreur
      // au lieu d'utiliser les settings globaux
      if (!credentials) {
        return res.status(400).json({
          success: false,
          error: `Configuration Azure non trouvée pour le client ${clientId}. Veuillez configurer les credentials Azure spécifiques à ce client.`
        });
      }
    } else {
      if (!credentials) {
        const settings = await getOffice365Settings();
        if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
          credentials = {
            tenantId: settings.tenant_id,
            clientId: settings.client_id,
            clientSecret: settings.client_secret
          };
        }
      }
    }
    
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés"
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Récupérer les statistiques d'emails via Reports API uniquement (pas de lecture de contenu)
    // Toujours utiliser D90 pour récupérer le maximum de données, puis filtrer selon les dates du rapport
    const period = 'D90'; // Toujours D90 pour avoir le maximum de données
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;
    
    const [emailActivity, emailAppUsage, mailboxUsage, emailActivityUserDetail, activeUsersReport, usersWithMailboxSettings] = await Promise.all([
      callMicrosoftGraph(`/reports/getEmailActivityCounts(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getEmailAppUsageUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getMailboxUsageDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getEmailActivityUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getOffice365ActiveUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      // Récupérer les utilisateurs avec leurs paramètres de boîte aux lettres pour obtenir les quotas
      // Note: mailboxSettings nécessite des permissions spéciales et peut ne pas être disponible pour tous les utilisateurs
      callMicrosoftGraph("/users?$select=id,displayName,mail,userPrincipalName", accessToken, { getAllPages: true }).catch(() => null)
    ]);

    // Calculer les statistiques agrégées
    let totalSent = 0;
    let totalReceived = 0;
    let totalRead = 0;
    let totalMailboxSize = 0;
    let totalMailboxes = 0;
    let dailyActivity = []; // Pour le graphique

    if (emailActivity && emailActivity.value) {
      emailActivity.value.forEach(day => {
        // Les colonnes peuvent varier selon la version de l'API
        const sent = parseInt(day.Send || day.send || day['Send Count'] || 0);
        const received = parseInt(day.Receive || day.receive || day['Receive Count'] || 0);
        const read = parseInt(day.Read || day.read || day['Read Count'] || 0);
        
        // Préparer les données pour le graphique
        const date = day.ReportDate || day['Report Date'] || day.reportDate || day.date || '';
        const dayDate = new Date(date);
        
        // Totaux éventuellement filtrés par période ; graphique = toutes les dates
        if (startDate && endDate) {
          const dayDateOnly = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate());
          const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
          const endDateOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
          if (dayDateOnly >= startDateOnly && dayDateOnly <= endDateOnly) {
            totalSent += sent;
            totalReceived += received;
            totalRead += read;
          }
        } else {
          totalSent += sent;
          totalReceived += received;
          totalRead += read;
        }
        // Graphique : toujours toutes les dates disponibles (pas de filtre)
        dailyActivity.push({
          date: date,
          sent: sent,
          received: received,
          read: read
        });
      });
      
      // Trier par date (du plus ancien au plus récent)
      dailyActivity.sort((a, b) => {
        const dateA = new Date(a.date);
        const dateB = new Date(b.date);
        return dateA - dateB;
      });
    }

    // Créer un mapping des utilisateurs avec leurs quotas depuis mailboxSettings
    const userQuotaMap = new Map();
    if (usersWithMailboxSettings && usersWithMailboxSettings.value) {
      usersWithMailboxSettings.value.forEach(user => {
        if (user.mailboxSettings && user.userPrincipalName) {
          const emailKey = user.userPrincipalName.toLowerCase();
          // mailboxSettings peut contenir storageQuota (en bytes) ou issueWarningQuota
          // Essayer aussi prohibitSendReceiveQuota qui est souvent le quota maximum
          const quota = user.mailboxSettings.prohibitSendReceiveQuota || 
                       user.mailboxSettings.storageQuota || 
                       user.mailboxSettings.issueWarningQuota || 
                       null;
          userQuotaMap.set(emailKey, {
            displayName: user.displayName || user.mail || user.userPrincipalName.split('@')[0],
            email: user.userPrincipalName,
            quota: quota ? parseInt(quota) : null
          });
        }
      });
    }
    
    // Utiliser les données de mailboxUsage depuis Reports API (pas besoin de Mail.Read)
    let totalItemCount = 0;
    let averageMailboxSize = 0;
    let averageItemCount = 0;
    const mailboxQuotas = []; // Liste détaillée des quotas par utilisateur
    
    if (mailboxUsage && mailboxUsage.value) {
      mailboxUsage.value.forEach(mailbox => {
        const storageUsed = parseInt(
          mailbox['Storage Used (Byte)'] || 
          mailbox['Storage Used'] || 
          mailbox.storageUsedInBytes || 
          mailbox['StorageUsed'] ||
          mailbox['StorageUsedInBytes'] ||
          0
        );
        
        // Essayer d'abord depuis le rapport, puis depuis mailboxSettings
        let storageQuota = parseInt(
          mailbox['Storage Quota (Byte)'] ||
          mailbox['Storage Quota'] ||
          mailbox.storageQuotaInBytes ||
          mailbox['StorageQuota'] ||
          mailbox['StorageQuotaInBytes'] ||
          0
        );
        
        const itemCount = parseInt(
          mailbox['Item Count'] || 
          mailbox.itemCount || 
          mailbox['ItemCount'] ||
          0
        );
        
        const userPrincipalName = mailbox['User Principal Name'] || 
                                  mailbox['UserPrincipalName'] || 
                                  mailbox.userPrincipalName || 
                                  'Inconnu';
        
        // Enrichir avec les données depuis userQuotaMap
        const emailKey = userPrincipalName.toLowerCase();
        const userInfo = userQuotaMap.get(emailKey);
        
        const displayName = userInfo?.displayName || 
                           mailbox['Display Name'] || 
                           mailbox['DisplayName'] || 
                           mailbox.displayName || 
                           userPrincipalName.split('@')[0];
        
        // Si pas de quota depuis le rapport, utiliser celui de mailboxSettings
        if (storageQuota === 0 && userInfo?.quota) {
          storageQuota = userInfo.quota;
        }
        
        totalMailboxes++;
        totalMailboxSize += storageUsed;
        totalItemCount += itemCount;
        
        // Ajouter à la liste des quotas
        mailboxQuotas.push({
          displayName: displayName,
          user: displayName,
          email: userInfo?.email || userPrincipalName,
          storageUsed: storageUsed,
          storageQuota: storageQuota,
          usagePercent: storageQuota > 0 ? Math.round((storageUsed / storageQuota) * 100) : 0,
          quotaPercent: storageQuota > 0 ? Math.round((storageUsed / storageQuota) * 100) : 0,
          itemCount: itemCount
        });
      });
      
      // Calculer les moyennes
      if (totalMailboxes > 0) {
        averageMailboxSize = Math.round(totalMailboxSize / totalMailboxes);
        averageItemCount = Math.round(totalItemCount / totalMailboxes);
      }
      
      // Trier par taille utilisée (du plus grand au plus petit)
      mailboxQuotas.sort((a, b) => b.storageUsed - a.storageUsed);
    }

    // Calculer les moyennes et taux
    const daysCount = dailyActivity.length || 1;
    const avgSent = Math.round(totalSent / daysCount);
    const avgReceived = Math.round(totalReceived / daysCount);
    const avgRead = Math.round(totalRead / daysCount);
    const readRate = totalReceived > 0 ? ((totalRead / totalReceived) * 100).toFixed(1) : 0;

    // Calculer les statistiques par jour de la semaine
    const weeklyStats = {
      monday: { sent: 0, received: 0, read: 0, count: 0 },
      tuesday: { sent: 0, received: 0, read: 0, count: 0 },
      wednesday: { sent: 0, received: 0, read: 0, count: 0 },
      thursday: { sent: 0, received: 0, read: 0, count: 0 },
      friday: { sent: 0, received: 0, read: 0, count: 0 },
      saturday: { sent: 0, received: 0, read: 0, count: 0 },
      sunday: { sent: 0, received: 0, read: 0, count: 0 }
    };

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    
    if (dailyActivity && dailyActivity.length > 0) {
      dailyActivity.forEach(day => {
        const date = new Date(day.date);
        if (!isNaN(date.getTime())) {
          const dayOfWeek = dayNames[date.getDay()];
          if (weeklyStats[dayOfWeek]) {
            weeklyStats[dayOfWeek].sent += day.sent || 0;
            weeklyStats[dayOfWeek].received += day.received || 0;
            weeklyStats[dayOfWeek].read += day.read || 0;
            weeklyStats[dayOfWeek].count++;
          }
        }
      });
    }

    // Calculer les moyennes par jour de la semaine
    const weeklyStatsFormatted = {
      lundi: {
        sent: weeklyStats.monday.count > 0 ? Math.round(weeklyStats.monday.sent / weeklyStats.monday.count) : 0,
        received: weeklyStats.monday.count > 0 ? Math.round(weeklyStats.monday.received / weeklyStats.monday.count) : 0,
        read: weeklyStats.monday.count > 0 ? Math.round(weeklyStats.monday.read / weeklyStats.monday.count) : 0
      },
      mardi: {
        sent: weeklyStats.tuesday.count > 0 ? Math.round(weeklyStats.tuesday.sent / weeklyStats.tuesday.count) : 0,
        received: weeklyStats.tuesday.count > 0 ? Math.round(weeklyStats.tuesday.received / weeklyStats.tuesday.count) : 0,
        read: weeklyStats.tuesday.count > 0 ? Math.round(weeklyStats.tuesday.read / weeklyStats.tuesday.count) : 0
      },
      mercredi: {
        sent: weeklyStats.wednesday.count > 0 ? Math.round(weeklyStats.wednesday.sent / weeklyStats.wednesday.count) : 0,
        received: weeklyStats.wednesday.count > 0 ? Math.round(weeklyStats.wednesday.received / weeklyStats.wednesday.count) : 0,
        read: weeklyStats.wednesday.count > 0 ? Math.round(weeklyStats.wednesday.read / weeklyStats.wednesday.count) : 0
      },
      jeudi: {
        sent: weeklyStats.thursday.count > 0 ? Math.round(weeklyStats.thursday.sent / weeklyStats.thursday.count) : 0,
        received: weeklyStats.thursday.count > 0 ? Math.round(weeklyStats.thursday.received / weeklyStats.thursday.count) : 0,
        read: weeklyStats.thursday.count > 0 ? Math.round(weeklyStats.thursday.read / weeklyStats.thursday.count) : 0
      },
      vendredi: {
        sent: weeklyStats.friday.count > 0 ? Math.round(weeklyStats.friday.sent / weeklyStats.friday.count) : 0,
        received: weeklyStats.friday.count > 0 ? Math.round(weeklyStats.friday.received / weeklyStats.friday.count) : 0,
        read: weeklyStats.friday.count > 0 ? Math.round(weeklyStats.friday.read / weeklyStats.friday.count) : 0
      },
      samedi: {
        sent: weeklyStats.saturday.count > 0 ? Math.round(weeklyStats.saturday.sent / weeklyStats.saturday.count) : 0,
        received: weeklyStats.saturday.count > 0 ? Math.round(weeklyStats.saturday.received / weeklyStats.saturday.count) : 0,
        read: weeklyStats.saturday.count > 0 ? Math.round(weeklyStats.saturday.read / weeklyStats.saturday.count) : 0
      },
      dimanche: {
        sent: weeklyStats.sunday.count > 0 ? Math.round(weeklyStats.sunday.sent / weeklyStats.sunday.count) : 0,
        received: weeklyStats.sunday.count > 0 ? Math.round(weeklyStats.sunday.received / weeklyStats.sunday.count) : 0,
        read: weeklyStats.sunday.count > 0 ? Math.round(weeklyStats.sunday.read / weeklyStats.sunday.count) : 0
      }
    };

    // Calculer le top 5 des utilisateurs
    // Le rapport getEmailActivityUserDetail peut retourner des IDs hashés ou des emails réels
    let topUsers = [];
    
    // Créer un mapping des utilisateurs depuis usersWithMailboxSettings (déjà récupéré)
    let allUsersMap = new Map();
    if (usersWithMailboxSettings && usersWithMailboxSettings.value) {
      usersWithMailboxSettings.value.forEach(u => {
        const emailKey = (u.userPrincipalName || u.mail || '').toLowerCase();
        if (emailKey) {
          allUsersMap.set(emailKey, {
            displayName: u.displayName || u.mail || u.userPrincipalName,
            userPrincipalName: u.userPrincipalName || u.mail
          });
        }
      });
    }
    
    // Utiliser getEmailActivityUserDetail pour les statistiques
    if (emailActivityUserDetail && emailActivityUserDetail.value) {
      const userMap = new Map();
      
      emailActivityUserDetail.value.forEach(user => {
        const identifier = user['User Principal Name'] || user['UserPrincipalName'] || user.userPrincipalName || '';
        const displayName = user['Display Name'] || user['DisplayName'] || user.displayName || '';
        const sent = parseInt(user['Send Count'] || user['Send'] || user.send || user.sendCount || 0);
        const received = parseInt(user['Receive Count'] || user['Receive'] || user.receive || user.receiveCount || 0);
        const read = parseInt(user['Read Count'] || user['Read'] || user.read || user.readCount || 0);
        
        // Vérifier si c'est un ID hashé (longue chaîne hex) ou un email réel
        const isHashedId = /^[0-9A-F]{32,}$/i.test(identifier);
        
        if (isHashedId) {
          // C'est un ID hashé, essayer de le mapper via le rapport activeUsersReport
          let mappedUser = null;
          if (activeUsersReport && activeUsersReport.value) {
            const matched = activeUsersReport.value.find(activeUser => {
              const activeUserId = activeUser['User Id'] || activeUser['UserId'] || '';
              return activeUserId === identifier || activeUserId.toLowerCase() === identifier.toLowerCase();
            });
            if (matched) {
              const matchedEmail = matched['User Principal Name'] || matched['UserPrincipalName'] || '';
              if (matchedEmail && matchedEmail.includes('@')) {
                const userInfo = allUsersMap.get(matchedEmail.toLowerCase());
                if (userInfo) {
                  mappedUser = userInfo;
                }
              }
            }
          }
          
          if (!userMap.has(identifier)) {
            userMap.set(identifier, {
              displayName: mappedUser?.displayName || displayName || `Utilisateur ${identifier.substring(0, 8)}...`,
              userPrincipalName: mappedUser?.userPrincipalName || identifier,
              email: mappedUser?.userPrincipalName || identifier,
              sent: 0,
              received: 0,
              read: 0,
              total: 0
            });
          }
          
          const userStat = userMap.get(identifier);
          userStat.sent += sent;
          userStat.received += received;
          userStat.read += read;
          userStat.total = userStat.sent + userStat.received;
        } else if (identifier.includes('@')) {
          // C'est un email réel, on peut l'enrichir avec les noms
          const emailKey = identifier.toLowerCase();
          if (!userMap.has(emailKey)) {
            const userInfo = allUsersMap.get(emailKey) || {
              displayName: displayName || emailKey.split('@')[0],
              userPrincipalName: identifier
            };
            
            userMap.set(emailKey, {
              displayName: userInfo.displayName,
              userPrincipalName: userInfo.userPrincipalName,
              email: identifier,
              sent: 0,
              received: 0,
              read: 0,
              total: 0
            });
          }
          
          const userStat = userMap.get(emailKey);
          userStat.sent += sent;
          userStat.received += received;
          userStat.read += read;
          userStat.total = userStat.sent + userStat.received;
        }
      });
      
      // Trier par total (envoyés + reçus) et prendre le top 5
      topUsers = Array.from(userMap.values())
        .filter(user => user.total > 0) // Filtrer les utilisateurs avec au moins une activité
        .sort((a, b) => b.total - a.total)
        .slice(0, 5)
        .map(user => ({
          name: user.displayName || user.email.split('@')[0] || user.email,
          email: user.userPrincipalName || user.email,
          sent: user.sent,
          received: user.received,
          read: user.read,
          total: user.total
        }));
    }

    res.json({
      success: true,
      emailActivity: {
        sent: totalSent,
        received: totalReceived,
        read: totalRead,
        period: period,
        dailyActivity: dailyActivity, // Données quotidiennes pour le graphique
        averages: {
          sent: avgSent,
          received: avgReceived,
          read: avgRead
        },
        readRate: parseFloat(readRate),
        weeklyStats: weeklyStatsFormatted
      },
      mailboxes: {
        total: totalMailboxes,
        totalSize: formatBytes(totalMailboxSize),
        averageSize: formatBytes(averageMailboxSize),
        totalItems: totalItemCount,
        averageItems: averageItemCount,
        quotas: mailboxQuotas // Liste détaillée des quotas par utilisateur
      },
      appUsage: emailAppUsage || null,
      topUsers: topUsers,
      lastUpdate: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des données Exchange"
    });
  }
});

/**
 * GET /api/office365/teams
 * Récupère les données Microsoft Teams
 */
router.get("/teams", verifyJWT, async (req, res) => {
  try {
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;
    
    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);
      
      // Si le client n'a pas de configuration spécifique, retourner une erreur
      // au lieu d'utiliser les settings globaux
      if (!credentials) {
        return res.status(400).json({
          success: false,
          error: `Configuration Azure non trouvée pour le client ${clientId}. Veuillez configurer les credentials Azure spécifiques à ce client.`
        });
      }
    } else {
      const settings = await getOffice365Settings();
      if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
        credentials = {
          tenantId: settings.tenant_id,
          clientId: settings.client_id,
          clientSecret: settings.client_secret
        };
      }
    }
    
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés"
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Toujours récupérer D90 (période la plus longue) puis filtrer par les dates de monitoring
    const period = 'D90';
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;
    
    const parseNumber = (value) => {
      if (value === null || value === undefined) return 0;
      if (typeof value === "number") {
        return isNaN(value) ? 0 : value;
      }
      if (typeof value === "string") {
        const cleaned = value.replace(/,/g, "").trim();
        if (cleaned === "") return 0;
        const parsed = parseFloat(cleaned);
        return isNaN(parsed) ? 0 : parsed;
      }
      return 0;
    };

    const normalizeBoolean = (value) => {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        return normalized === "true" || normalized === "yes" || normalized === "1";
      }
      if (typeof value === "number") return value === 1;
      return false;
    };

    const getDateKey = (value) => {
      if (!value) return null;
      try {
        const date = new Date(value);
        if (isNaN(date.getTime())) return null;
        return date.toISOString().split("T")[0];
      } catch {
        return null;
      }
    };
    
    // Récupérer les données Teams
    const [teams, teamsActivity, teamsDeviceUsage, callRecords] = await Promise.all([
      callMicrosoftGraph("/teams", accessToken, { getAllPages: true }).catch((err) => {
        return null;
      }),
      callMicrosoftGraph(`/reports/getTeamsUserActivityUserDetail(period='${period}')`, accessToken, { isReport: true }).catch((err) => {
        return null;
      }),
      callMicrosoftGraph(`/reports/getTeamsDeviceUsageUserDetail(period='${period}')`, accessToken, { isReport: true }).catch((err) => {
        return null;
      }),
      callMicrosoftGraph("/communications/callRecords", accessToken, { getAllPages: true }).catch((err) => {
        return null;
      })
    ]);
    
    // Logs réduits pour optimiser la synchronisation

    // Calculer les statistiques
    let totalTeams = 0;
    let activeUsers = new Set();
    let totalMessages = 0;
    let totalMeetings = 0;
    let totalCalls = 0;
    let totalCallDuration = 0;
    let teamChatMessages = 0;
    let privateChatMessages = 0;
    let urgentMessages = 0;
    let postMessages = 0;
    let replyMessages = 0;
    let meetingsOrganized = 0;
    let meetingsAttended = 0;
    let adHocMeetingsOrganized = 0;
    let adHocMeetingsAttended = 0;
    let scheduledOneTimeOrganized = 0;
    let scheduledOneTimeAttended = 0;
    let scheduledRecurringOrganized = 0;
    let scheduledRecurringAttended = 0;
    let callCountFromActivity = 0;
    let callDurationFromActivity = 0;
    let audioDurationSeconds = 0;
    let videoDurationSeconds = 0;
    let screenShareDurationSeconds = 0;
    let hasOtherActionCount = 0;
    let licensedUsers = 0;
    let deletedUsers = 0;
    let reportPeriod = null;
    let reportRefreshDate = null;
    const dailyActivityMap = new Map();

    if (teams && teams.value) {
      totalTeams = teams.value.length;
    }

    // Préparer les compteurs de membres et de canaux par équipe (non bloquant)
    const teamMemberCounts = new Map();
    const teamChannelCounts = new Map();
    if (teams && teams.value && teams.value.length > 0) {
      const teamsForCounts = teams.value.slice(0, 50);
      try {
        await Promise.all(
          teamsForCounts.map(async (team) => {
            try {
              const [members, channels] = await Promise.all([
                callMicrosoftGraph(`/teams/${team.id}/members`, accessToken, { getAllPages: true }).catch(() => null),
                callMicrosoftGraph(`/teams/${team.id}/channels`, accessToken, { getAllPages: true }).catch(() => null)
              ]);
              teamMemberCounts.set(team.id, Array.isArray(members?.value) ? members.value.length : 0);
              teamChannelCounts.set(team.id, Array.isArray(channels?.value) ? channels.value.length : 0);
            } catch {
              teamMemberCounts.set(team.id, 0);
              teamChannelCounts.set(team.id, 0);
            }
          })
        );
      } catch {
        // En cas d'erreur globale, laisser les maps vides → comptes à 0, on renvoie quand même la liste
      }
    }

    // Traiter les données détaillées par utilisateur
    if (teamsActivity && teamsActivity.value) {
      if (teamsActivity.value.length > 0) {
        reportRefreshDate = teamsActivity.value[0]['Report Refresh Date'] || teamsActivity.value[0]['ReportRefreshDate'] || null;
        reportPeriod = teamsActivity.value[0]['Report Period'] || teamsActivity.value[0]['ReportPeriod'] || null;
      }

      let entriesMatchingPeriod = 0;
      
      teamsActivity.value.forEach(user => {
        // Les colonnes CSV peuvent avoir des espaces : "Team Chat Message Count", "Meeting Count", "User Principal Name"
        // Essayer toutes les variantes possibles
        const userPrincipalName = user['User Principal Name'] || user['UserPrincipalName'] || user.userPrincipalName || user['User'] || user['User Name'] || '';
        const lastActivityDate = user['Last Activity Date'] || user['LastActivityDate'] || user.lastActivityDate || null;
        const dateKey = getDateKey(lastActivityDate);
        const isLicensed = normalizeBoolean(user['Is Licensed'] || user['IsLicensed'] || user.isLicensed);
        const isDeleted = normalizeBoolean(user['Is Deleted'] || user['IsDeleted'] || user.isDeleted);
        const hasOtherAction = normalizeBoolean(user['Has Other Action'] || user['HasOtherAction'] || user.hasOtherAction);
        if (isLicensed) licensedUsers++;
        if (isDeleted) deletedUsers++;
        if (hasOtherAction) hasOtherActionCount++;
        
        // Essayer toutes les variantes pour les messages (Team Chat + Private Chat)
        let matchesMonitoringPeriod = true;
        if (startDate && endDate) {
          if (!lastActivityDate || lastActivityDate === '') {
            matchesMonitoringPeriod = false;
          } else {
          try {
            const activityDate = new Date(lastActivityDate);
              matchesMonitoringPeriod = activityDate >= startDate && activityDate <= endDate;
          } catch {
              matchesMonitoringPeriod = false;
            }
          }
        }

        if (matchesMonitoringPeriod) {
          entriesMatchingPeriod++;
        }
        
        const teamChatMessageCount = parseNumber(
          user['Team Chat Message Count'] || 
          user['TeamChatMessageCount'] || 
          user['Team Chat Messages'] ||
          user['TeamChatMessages'] ||
          user.teamChatMessageCount || 
          user.teamChatMessages ||
          user['Team Chat'] ||
          user['TeamChat']
        );
        
        const privateChatMessageCount = parseNumber(
          user['Private Chat Message Count'] ||
          user['PrivateChatMessageCount'] ||
          user['Private Chat Messages'] ||
          user['PrivateChatMessages'] ||
          user.privateChatMessageCount ||
          user.privateChatMessages ||
          user['Private Chat'] ||
          user['PrivateChat']
        );
        
        // Essayer toutes les variantes pour les réunions
        const meetingCount = parseNumber(
          user['Meeting Count'] || 
          user['MeetingCount'] || 
          user['Meetings'] ||
          user.meetingCount || 
          user.meetings ||
          user['Total Meetings'] ||
          user['TotalMeetings'] ||
          user['Meeting']
        );
        
        const meetingsOrganizedCount = parseNumber(
          user['Meetings Organized Count'] ||
          user['MeetingsOrganizedCount'] ||
          user['Meetings Organized'] ||
          user.meetingsOrganized ||
          user['Organized Meetings']
        );
        
        const meetingsAttendedCount = parseNumber(
          user['Meetings Attended Count'] ||
          user['MeetingsAttendedCount'] ||
          user['Meetings Attended'] ||
          user.meetingsAttended ||
          user['Attended Meetings']
        );
        
        const adHocMeetingsOrganizedCount = parseNumber(
          user['Ad Hoc Meetings Organized Count'] ||
          user['AdHocMeetingsOrganizedCount'] ||
          user['Ad Hoc Meetings Organized'] ||
          user['AdHocMeetingsOrganized'] ||
          user.adHocMeetingsOrganized
        );
        
        const adHocMeetingsAttendedCount = parseNumber(
          user['Ad Hoc Meetings Attended Count'] ||
          user['AdHocMeetingsAttendedCount'] ||
          user['Ad Hoc Meetings Attended'] ||
          user['AdHocMeetingsAttended'] ||
          user.adHocMeetingsAttended
        );
        
        const scheduledOneTimeOrganizedCount = parseNumber(
          user['Scheduled One-time Meetings Organized Count'] ||
          user['Scheduled One-time Meetings Organized'] ||
          user['ScheduledOnetimeMeetingsOrganizedCount'] ||
          user['ScheduledOneTimeMeetingsOrganized'] ||
          user.scheduledOneTimeMeetingsOrganized
        );
        
        const scheduledOneTimeAttendedCount = parseNumber(
          user['Scheduled One-time Meetings Attended Count'] ||
          user['Scheduled One-time Meetings Attended'] ||
          user['ScheduledOnetimeMeetingsAttendedCount'] ||
          user['ScheduledOneTimeMeetingsAttended'] ||
          user.scheduledOneTimeMeetingsAttended
        );
        
        const scheduledRecurringOrganizedCount = parseNumber(
          user['Scheduled Recurring Meetings Organized Count'] ||
          user['Scheduled Recurring Meetings Organized'] ||
          user['ScheduledRecurringMeetingsOrganizedCount'] ||
          user['ScheduledRecurringMeetingsOrganized'] ||
          user.scheduledRecurringMeetingsOrganized
        );
        
        const scheduledRecurringAttendedCount = parseNumber(
          user['Scheduled Recurring Meetings Attended Count'] ||
          user['Scheduled Recurring Meetings Attended'] ||
          user['ScheduledRecurringMeetingsAttendedCount'] ||
          user['ScheduledRecurringMeetingsAttended'] ||
          user.scheduledRecurringMeetingsAttended
        );
        
        const urgentMessagesCount = parseNumber(
          user['Urgent Messages'] ||
          user['UrgentMessages'] ||
          user.urgentMessages
        );
        
        const postMessagesCount = parseNumber(
          user['Post Messages'] ||
          user['PostMessages'] ||
          user.postMessages
        );
        
        const replyMessagesCount = parseNumber(
          user['Reply Messages'] ||
          user['ReplyMessages'] ||
          user.replyMessages
        );
        
        const callCount = parseNumber(
          user['Call Count'] || 
          user['Calls'] ||
          user['Total Calls'] ||
          user['CallCount'] ||
          user.callCount
        );
        
        const audioDuration = parseNumber(
          user['Audio Duration In Seconds'] ||
          user['Audio Duration'] ||
          user['AudioDurationInSeconds'] ||
          user.audioDurationInSeconds
        );
        
        const videoDuration = parseNumber(
          user['Video Duration In Seconds'] ||
          user['Video Duration'] ||
          user['VideoDurationInSeconds'] ||
          user.videoDurationInSeconds
        );
        
        const screenShareDuration = parseNumber(
          user['Screen Share Duration In Seconds'] ||
          user['Screen Share Duration'] ||
          user['ScreenShareDurationInSeconds'] ||
          user.screenShareDurationInSeconds
        );
        
        // Ajouter les messages et interactions
        if (dateKey) {
          if (!dailyActivityMap.has(dateKey)) {
            dailyActivityMap.set(dateKey, {
              date: dateKey,
              channelMessages: 0,
              chatMessages: 0,
              oneOnOneCalls: 0,
              totalMeetings: 0
            });
          }
          const dailyEntry = dailyActivityMap.get(dateKey);
          dailyEntry.channelMessages += teamChatMessageCount;
          dailyEntry.chatMessages += privateChatMessageCount;
          dailyEntry.oneOnOneCalls += callCount;
          dailyEntry.totalMeetings += meetingCount;
        }

        if (!matchesMonitoringPeriod) {
          return;
        }

        teamChatMessages += teamChatMessageCount;
        privateChatMessages += privateChatMessageCount;
        urgentMessages += urgentMessagesCount;
        postMessages += postMessagesCount;
        replyMessages += replyMessagesCount;
        totalMessages += teamChatMessageCount + privateChatMessageCount;
        totalMeetings += meetingCount;
        meetingsOrganized += meetingsOrganizedCount;
        meetingsAttended += meetingsAttendedCount;
        adHocMeetingsOrganized += adHocMeetingsOrganizedCount;
        adHocMeetingsAttended += adHocMeetingsAttendedCount;
        scheduledOneTimeOrganized += scheduledOneTimeOrganizedCount;
        scheduledOneTimeAttended += scheduledOneTimeAttendedCount;
        scheduledRecurringOrganized += scheduledRecurringOrganizedCount;
        scheduledRecurringAttended += scheduledRecurringAttendedCount;
        callCountFromActivity += callCount;
        audioDurationSeconds += audioDuration;
        videoDurationSeconds += videoDuration;
        screenShareDurationSeconds += screenShareDuration;
        callDurationFromActivity += audioDuration + videoDuration + screenShareDuration;
        
        // Ajouter à la liste des utilisateurs actifs si activité
        if (teamChatMessageCount > 0 || privateChatMessageCount > 0 || meetingCount > 0 || callCount > 0) {
          if (userPrincipalName) {
            activeUsers.add(userPrincipalName);
          }
        }
      });

      if (startDate && endDate) {
      }
    }

    // Récupérer les données d'appels depuis les rapports Teams
    // L'API /communications/callRecords nécessite des permissions spéciales et peut ne pas être disponible
    if (callRecords && callRecords.value && callRecords.value.length > 0) {
      // Log pour déboguer
      
      // Filtrer les appels par période de monitoring si les dates sont fournies
      let filteredCalls = callRecords.value;
      if (startDate && endDate) {
        filteredCalls = callRecords.value.filter(call => {
          const callStartDate = call.startDateTime || call.startDate;
          if (!callStartDate) return false;
          
          try {
            const callDate = new Date(callStartDate);
            return callDate >= startDate && callDate <= endDate;
          } catch {
            return false;
          }
        });
      }
      
      totalCalls = filteredCalls.length;
      filteredCalls.forEach(call => {
        let callDurationSeconds = 0;
        
        // Calculer la durée à partir de startDateTime et endDateTime (méthode principale)
        if (call.startDateTime && call.endDateTime) {
          try {
            const startDate = new Date(call.startDateTime);
            const endDate = new Date(call.endDateTime);
            if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime()) && endDate > startDate) {
              callDurationSeconds = Math.floor((endDate - startDate) / 1000); // Durée en secondes
            }
          } catch (e) {
          }
        }
        
        // Si la durée n'a pas pu être calculée depuis les dates, essayer les autres champs
        if (callDurationSeconds === 0) {
        const duration = call.duration || call.callDuration || call.durationInSeconds || call.callDurationInSeconds || 0;
        if (typeof duration === 'string' && duration.startsWith('PT')) {
          // Parser ISO 8601 duration (PT1H30M45S = 1 heure 30 minutes 45 secondes)
          const hoursMatch = duration.match(/(\d+)H/);
          const minutesMatch = duration.match(/(\d+)M/);
          const secondsMatch = duration.match(/(\d+)S/);
          const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;
          const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
          const seconds = secondsMatch ? parseInt(secondsMatch[1]) : 0;
            callDurationSeconds = (hours * 3600) + (minutes * 60) + seconds;
        } else {
            callDurationSeconds = parseInt(duration || 0);
          }
        }
        
        totalCallDuration += callDurationSeconds;
      });
    } else {
      // Log si aucun appel trouvé
      if (totalCalls === 0) {
      }
    }

    const effectiveCallCount = totalCalls > 0 ? totalCalls : callCountFromActivity;
    const effectiveCallDuration = totalCallDuration > 0 ? totalCallDuration : callDurationFromActivity;

    // Formater la durée des appels
    const formatDuration = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    };

    const callsStats = {
      total: effectiveCallCount,
      totalDuration: formatDuration(effectiveCallDuration),
      averageDuration: effectiveCallCount > 0 ? formatDuration(Math.floor(effectiveCallDuration / effectiveCallCount)) : "0h 0m",
      audioDuration: formatDuration(audioDurationSeconds),
      videoDuration: formatDuration(videoDurationSeconds),
      screenShareDuration: formatDuration(screenShareDurationSeconds),
      totalDurationSeconds: effectiveCallDuration,
      audioDurationSeconds,
      videoDurationSeconds,
      screenShareDurationSeconds
    };

    let dailyActivity = Array.from(dailyActivityMap.values()).sort((a, b) => new Date(a.date) - new Date(b.date));
    // Graphique : on garde toutes les dates (pas de filtre par startDate/endDate)

    const messagesStats = {
      total: teamChatMessages + privateChatMessages,
      teamChat: teamChatMessages,
      privateChat: privateChatMessages,
      urgent: urgentMessages,
      posts: postMessages,
      replies: replyMessages
    };

    const meetingsStats = {
      total: totalMeetings,
      organized: meetingsOrganized,
      attended: meetingsAttended,
      adHoc: {
        organized: adHocMeetingsOrganized,
        attended: adHocMeetingsAttended
      },
      scheduledOneTime: {
        organized: scheduledOneTimeOrganized,
        attended: scheduledOneTimeAttended
      },
      scheduledRecurring: {
        organized: scheduledRecurringOrganized,
        attended: scheduledRecurringAttended
      }
    };

    const usageStats = {
      activeUsers: activeUsers.size,
      licensedUsers,
      deletedUsers,
      otherActions: hasOtherActionCount,
      reportPeriod,
      reportRefreshDate
    };

    const activityStats = {
      totalMessages: messagesStats.total,
      totalMeetings: meetingsStats.total,
      activeUsers: activeUsers.size,
      messages: messagesStats,
      meetings: meetingsStats,
      calls: callsStats,
      usage: usageStats
    };

    const licensedActivity =
      dailyActivity.length > 0
        ? {
            totalChannelMessages: teamChatMessages,
            totalChatMessages: privateChatMessages,
            totalMeetings,
            totalCalls: callCountFromActivity,
            dailyActivity
          }
        : null;

    res.json({
      success: true,
      teams: {
        total: totalTeams,
        activeUsers: activeUsers.size,
        teamsList: teams?.value?.slice(0, 50).map(team => ({
          id: team.id,
          displayName: team.displayName,
          description: team.description,
          memberCount: teamMemberCounts.get(team.id) ?? 0,
          channelCount: teamChannelCounts.get(team.id) ?? 0
        })) || []
      },
      activity: activityStats,
      calls: callsStats,
      licensedActivity,
      lastUpdate: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des données Teams"
    });
  }
});

/**
 * GET /api/office365/onedrive
 * Récupère les données OneDrive for Business
 */
router.get("/onedrive", verifyJWT, async (req, res) => {
  try {
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;
    
    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);
      
      // Si le client n'a pas de configuration spécifique, retourner une erreur
      // au lieu d'utiliser les settings globaux
      if (!credentials) {
        return res.status(400).json({
          success: false,
          error: `Configuration Azure non trouvée pour le client ${clientId}. Veuillez configurer les credentials Azure spécifiques à ce client.`
        });
      }
    } else {
      const settings = await getOffice365Settings();
      if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
        credentials = {
          tenantId: settings.tenant_id,
          clientId: settings.client_id,
          clientSecret: settings.client_secret
        };
      }
    }
    
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés"
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Toujours utiliser D90 pour récupérer le maximum de données, puis filtrer selon les dates du rapport
    const period = 'D90';
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;
    
    // Récupérer les données OneDrive (toutes les données disponibles)
    const [onedriveUsage, onedriveActivity, onedriveActivityFileCounts] = await Promise.all([
      callMicrosoftGraph(`/reports/getOneDriveUsageAccountDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getOneDriveActivityUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      // Number of files by activity type
      callMicrosoftGraph(`/reports/getOneDriveActivityFileCounts(period='${period}')`, accessToken, { isReport: true }).catch(() => null)
    ]);

    // Calculer les statistiques
    let totalStorageUsed = 0;
    let totalFiles = 0;
    let totalSharedFiles = 0;
    let totalExternalShares = 0;
    let usersNearQuota = [];
    let totalStorage = 0;

    if (onedriveUsage && onedriveUsage.value) {
      onedriveUsage.value.forEach(account => {
        const storageUsed = parseInt(account['Storage Used (Byte)'] || account.storageUsedInBytes || account['Storage Used'] || 0);
        const fileCount = parseInt(account['File Count'] || account.fileCount || account['Files'] || 0);
        const ownerName = account['Owner Display Name'] || account.ownerDisplayName || account['Owner'] || '';
        const ownerEmail = account['Owner Principal Name'] || account.ownerPrincipalName || account['Owner Email'] || '';
        
        totalStorageUsed += storageUsed;
        totalFiles += fileCount;
        totalStorage += storageUsed;
        
        // Détecter les utilisateurs proches du quota (supposons 1TB par défaut)
        const quotaBytes = 1024 * 1024 * 1024 * 1024; // 1TB
        const usagePercent = (storageUsed / quotaBytes) * 100;
        
        if (usagePercent >= 90) {
          usersNearQuota.push({
            name: ownerName,
            email: ownerEmail,
            usagePercent: Math.round(usagePercent),
            used: formatBytes(storageUsed),
            files: fileCount
          });
        }
      });
    }

    // Filtrer et traiter les données d'activité OneDrive
    let filteredActivity = onedriveActivity?.value || [];
    if (onedriveActivity && onedriveActivity.value && startDate && endDate) {
      filteredActivity = onedriveActivity.value.filter(activity => {
        // Essayer différentes colonnes de date
        const activityDate = activity['Last Activity Date'] || 
                            activity['LastActivityDate'] || 
                            activity['Report Date'] ||
                            activity['ReportDate'] ||
                            activity.lastActivityDate ||
                            activity.reportDate;
        
        if (!activityDate || activityDate === '') return false;
        
        try {
          const date = new Date(activityDate);
          // Normaliser les dates (ignorer l'heure)
          const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
          const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
          const endDateOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
          
          return dateOnly >= startDateOnly && dateOnly <= endDateOnly;
        } catch {
          return false;
        }
      });
    }
    
    if (filteredActivity.length > 0) {
      filteredActivity.forEach(activity => {
        const sharedExternally = activity['Shared Externally'] || activity.sharedExternally || 'False';
        const sharedCount = parseInt(activity['Shared Count'] || activity.sharedCount || activity['Shares'] || 0);
        
        if (sharedExternally === 'True' || sharedExternally === true) {
          totalExternalShares += sharedCount;
        }
        totalSharedFiles += sharedCount;
      });
    }

    // Traiter Number of files by activity type avec filtre de période
    const filesByActivityType = {
      viewedOrEdited: 0,
      synced: 0,
      sharedInternally: 0,
      sharedExternally: 0
    };
    
    let filteredFileCounts = onedriveActivityFileCounts?.value || [];
    if (onedriveActivityFileCounts && onedriveActivityFileCounts.value && startDate && endDate) {
      filteredFileCounts = onedriveActivityFileCounts.value.filter(entry => {
        // Essayer différentes colonnes de date
        const reportDate = entry['Report Date'] || 
                          entry['ReportDate'] ||
                          entry['Date'] ||
                          entry.reportDate ||
                          entry.date;
        
        if (!reportDate || reportDate === '') return false;
        
        try {
          const date = new Date(reportDate);
          // Normaliser les dates (ignorer l'heure)
          const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
          const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
          const endDateOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
          
          return dateOnly >= startDateOnly && dateOnly <= endDateOnly;
        } catch {
          return false;
        }
      });
    }
    
    if (filteredFileCounts.length > 0) {
      filteredFileCounts.forEach(entry => {
        const viewedOrEdited = parseInt(
          entry['Viewed Or Edited File Count'] ||
          entry['Viewed or Edited File Count'] ||
          entry['ViewedOrEditedFileCount'] ||
          entry['Viewed Or Edited'] ||
          entry.viewedOrEdited ||
          0
        );
        const synced = parseInt(
          entry['Synced File Count'] ||
          entry['SyncedFileCount'] ||
          entry['Synced'] ||
          entry.synced ||
          0
        );
        const sharedInternal = parseInt(
          entry['Shared Internally File Count'] ||
          entry['SharedInternallyFileCount'] ||
          entry['Shared Internally'] ||
          entry.sharedInternally ||
          0
        );
        const sharedExternal = parseInt(
          entry['Shared Externally File Count'] ||
          entry['SharedExternallyFileCount'] ||
          entry['Shared Externally'] ||
          entry.sharedExternally ||
          0
        );
        
        filesByActivityType.viewedOrEdited += viewedOrEdited;
        filesByActivityType.synced += synced;
        filesByActivityType.sharedInternally += sharedInternal;
        filesByActivityType.sharedExternally += sharedExternal;
      });
    }

    res.json({
      success: true,
      storage: {
        totalUsed: formatBytes(totalStorageUsed),
        totalFiles: totalFiles,
        averagePerUser: onedriveUsage?.value?.length > 0 
          ? formatBytes(Math.floor(totalStorageUsed / onedriveUsage.value.length))
          : "0 B"
      },
      sharing: {
        totalShared: totalSharedFiles,
        externalShares: totalExternalShares,
        internalShares: totalSharedFiles - totalExternalShares,
        // Number of files by activity type
        byActivityType: {
          viewedOrEdited: filesByActivityType.viewedOrEdited,
          synced: filesByActivityType.synced,
          sharedInternally: filesByActivityType.sharedInternally,
          sharedExternally: filesByActivityType.sharedExternally
        }
      },
      usersNearQuota: usersNearQuota,
      lastUpdate: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des données OneDrive"
    });
  }
});

/**
 * GET /api/office365/sharepoint
 * Récupère les données SharePoint Online
 */
router.get("/sharepoint", verifyJWT, async (req, res) => {
  try {
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;
    
    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);
      
      // Si le client n'a pas de configuration spécifique, retourner une erreur
      // au lieu d'utiliser les settings globaux
      if (!credentials) {
        return res.status(400).json({
          success: false,
          error: `Configuration Azure non trouvée pour le client ${clientId}. Veuillez configurer les credentials Azure spécifiques à ce client.`
        });
      }
    } else {
      const settings = await getOffice365Settings();
      if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
        credentials = {
          tenantId: settings.tenant_id,
          clientId: settings.client_id,
          clientSecret: settings.client_secret
        };
      }
    }
    
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés"
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    const period = 'D90';
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;
    const hasDateFilter = Boolean(startDate && endDate);

    const parseNumber = (value) => {
      if (value === null || value === undefined) return 0;
      if (typeof value === "number") {
        return isNaN(value) ? 0 : value;
      }
      if (typeof value === "string") {
        const cleaned = value.replace(/,/g, "").trim();
        if (cleaned === "") return 0;
        const parsed = parseFloat(cleaned);
        return isNaN(parsed) ? 0 : parsed;
      }
      return 0;
    };

    const [sharepointUsageDetail, sharepointSiteCounts, sharepointSites] = await Promise.all([
      callMicrosoftGraph(
        `/reports/getSharePointSiteUsageDetail(period='${period}')`,
        accessToken,
        { isReport: true }
      ).catch(() => null),
      callMicrosoftGraph(
        `/reports/getSharePointSiteUsageSiteCounts(period='${period}')`,
        accessToken,
        { isReport: true }
      ).catch(() => null),
      callMicrosoftGraph("/sites?$select=id,displayName,webUrl,createdDateTime,lastModifiedDateTime", accessToken, { getAllPages: true }).catch((err) => {
        return null;
      })
    ]);

    const siteStats = new Map();

    if (sharepointUsageDetail && sharepointUsageDetail.value) {
      sharepointUsageDetail.value.forEach(usage => {
        const siteId = usage['Site Id'] || usage['SiteId'] || usage.siteId || null;
        if (!siteId) return;

        const reportDateRaw = usage['Report Date'] || usage['ReportDate'] || usage.reportDate || usage.date || null;
        const lastActivityRaw = usage['Last Activity Date'] || usage.lastActivityDate || usage['LastActivityDate'] || null;

        let reportDate = null;
        if (reportDateRaw) {
          const parsed = new Date(reportDateRaw);
          if (!isNaN(parsed)) {
            reportDate = parsed;
          }
        }

        if (reportDate && hasDateFilter) {
          const dateOnly = new Date(reportDate.getFullYear(), reportDate.getMonth(), reportDate.getDate());
          const startOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
          const endOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
          if (dateOnly < startOnly || dateOnly > endOnly) {
            return;
          }
        }

        let lastActivityDate = null;
        if (lastActivityRaw) {
          const parsedLast = new Date(lastActivityRaw);
          if (!isNaN(parsedLast)) {
            lastActivityDate = parsedLast;
          }
        }

        const existing = siteStats.get(siteId);
        const shouldUpdate = !existing || (reportDate && (!existing.reportDate || reportDate > existing.reportDate));

        if (shouldUpdate) {
          siteStats.set(siteId, {
            reportDate,
            lastActivityDate
          });
        }
      });
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const activityWindowStart = hasDateFilter
      ? new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
      : thirtyDaysAgo;
    const activityWindowEnd = hasDateFilter
      ? new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate())
      : now;

    let activeSitesFromDetail = 0;
    let latestReportDateFromDetail = null;

    siteStats.forEach(site => {
      if (site.reportDate && (!latestReportDateFromDetail || site.reportDate > latestReportDateFromDetail)) {
        latestReportDateFromDetail = site.reportDate;
      }
      if (
        site.lastActivityDate &&
        site.lastActivityDate >= activityWindowStart &&
        site.lastActivityDate <= activityWindowEnd
      ) {
        activeSitesFromDetail++;
      }
    });

    let totalSites = 0;
    let activeSites = 0;
    let inactiveSites = 0;
    let statsLastUpdate = null;

    if (sharepointSiteCounts && sharepointSiteCounts.value) {
      let latestCountsEntry = null;

      sharepointSiteCounts.value.forEach(entry => {
        const reportDateRaw =
          entry['Report Date'] ||
          entry['ReportDate'] ||
          entry.reportDate ||
          entry['Date'] ||
          null;

        if (!reportDateRaw) {
          return;
        }

        const parsedReportDate = new Date(reportDateRaw);
        if (isNaN(parsedReportDate)) {
          return;
        }

        if (hasDateFilter) {
          const reportDateOnly = new Date(
            parsedReportDate.getFullYear(),
            parsedReportDate.getMonth(),
            parsedReportDate.getDate()
          );
          const startOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
          const endOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
          if (reportDateOnly < startOnly || reportDateOnly > endOnly) {
            return;
          }
        }

        if (!latestCountsEntry || parsedReportDate > latestCountsEntry.reportDate) {
          latestCountsEntry = {
            data: entry,
            reportDate: parsedReportDate
          };
        }
      });

      if (latestCountsEntry) {
        totalSites = parseNumber(
          latestCountsEntry.data['Total Sites'] ||
          latestCountsEntry.data['TotalSites'] ||
          latestCountsEntry.data.totalSites
        );
        activeSites = parseNumber(
          latestCountsEntry.data['Active Sites'] ||
          latestCountsEntry.data['ActiveSites'] ||
          latestCountsEntry.data.activeSites
        );
        inactiveSites = parseNumber(
          latestCountsEntry.data['Inactive Sites'] ||
          latestCountsEntry.data['InactiveSites'] ||
          latestCountsEntry.data.inactiveSites
        );
        statsLastUpdate = latestCountsEntry.reportDate;
      }
    }

    if (totalSites === 0 && siteStats.size > 0) {
      totalSites = siteStats.size;
    }

    if (activeSites === 0 && activeSitesFromDetail > 0) {
      activeSites = activeSitesFromDetail;
    }

    if (inactiveSites === 0 && totalSites > 0) {
      inactiveSites = Math.max(0, totalSites - activeSites);
    }

    if (!statsLastUpdate) {
      statsLastUpdate = latestReportDateFromDetail || new Date();
    }

    // Filtrer et construire la liste des sites SharePoint
    const sitesList = [];
    if (sharepointSites && sharepointSites.value) {
      sharepointSites.value.forEach(site => {
        const webUrl = site.webUrl || '';
        const siteId = site.id || '';
        
        // Filtrer les sites système (hub, community, personal, M365 group sites avec GUID)
        const isSystemSite = 
          webUrl.includes('/portals/hub/') ||
          webUrl.includes('/portals/community/') ||
          webUrl.includes('/portals/personal/') ||
          (siteId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId) && webUrl.includes('/sites/'));
        
        if (!isSystemSite) {
          // Récupérer les données d'activité depuis siteStats
          const siteActivity = siteStats.get(siteId);
          const isActive = siteActivity && siteActivity.lastActivityDate && 
            siteActivity.lastActivityDate >= activityWindowStart && 
            siteActivity.lastActivityDate <= activityWindowEnd;
          
          sitesList.push({
            id: siteId,
            name: site.displayName || 'Sans nom',
            webUrl: webUrl,
            createdDateTime: site.createdDateTime || null,
            lastModifiedDateTime: site.lastModifiedDateTime || null,
            lastActivityDate: siteActivity?.lastActivityDate || null,
            isActive: isActive || false
          });
        }
      });
    }

    res.json({
      success: true,
      stats: {
        totalSites,
        activeSites,
        inactiveSites,
        lastUpdate: statsLastUpdate ? statsLastUpdate.toISOString() : new Date().toISOString()
      },
      sites: sitesList
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des données SharePoint"
    });
  }
});

/**
 * GET /api/office365/stats
 * Récupère les statistiques globales Office 365
 */
router.get("/stats", verifyJWT, async (req, res) => {
  try {
    // Essayer d'abord les credentials spécifiques au client si clientId est fourni
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;
    
    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);
    }
    
    // Si pas de credentials client, utiliser les paramètres globaux
    if (!credentials) {
      const settings = await getOffice365Settings();
      if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
        credentials = {
          tenantId: settings.tenant_id,
          clientId: settings.client_id,
          clientSecret: settings.client_secret
        };
      }
    }
    
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés"
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Récupérer les données nécessaires
    const subscribedSkus = await callMicrosoftGraph("/subscribedSkus", accessToken);
    
    // Récupérer le nombre d'utilisateurs
    const usersResponse = await fetch("https://graph.microsoft.com/v1.0/users/$count", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "ConsistencyLevel": "eventual"
      }
    });
    const usersCount = parseInt(await usersResponse.text()) || 0;

    // Calculer les statistiques
    const totalLicences = subscribedSkus.value.reduce((sum, sku) => sum + (sku.prepaidUnits?.enabled || 0), 0);
    const totalUtilisees = subscribedSkus.value.reduce((sum, sku) => sum + (sku.consumedUnits || 0), 0);
    const totalDisponibles = totalLicences - totalUtilisees;
    const tauxUtilisation = totalLicences > 0 ? Math.round((totalUtilisees / totalLicences) * 100) : 0;

    res.json({
      success: true,
      stats: {
        totalLicences: totalLicences,
        totalUtilisees: totalUtilisees,
        totalDisponibles: totalDisponibles,
        tauxUtilisation: tauxUtilisation,
        nombreUtilisateurs: usersCount,
        nombreTypesLicences: subscribedSkus.value.length
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des statistiques"
    });
  }
});

/**
 * GET /api/office365/secure-score-recommendations?clientId=
 * Recommandations Microsoft Secure Score (Graph : directory/recommendations ou secureScoreControlProfiles).
 */
router.get("/secure-score-recommendations", verifyJWT, async (req, res) => {
  try {
    const clientId = req.query.clientId ? parseInt(req.query.clientId, 10) : null;
    if (!clientId) {
      return res.status(400).json({ success: false, error: "clientId est requis" });
    }

    const credentials = await getClientOffice365Credentials(clientId);
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: `Configuration Azure non trouvée pour le client ${clientId}.`,
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    let directoryRecs = null;
    try {
      directoryRecs = await callMicrosoftGraph("/directory/recommendations", accessToken, {
        getAllPages: true,
        useBeta: true,
      });
    } catch (e) {
      console.warn("secure-score-recommendations: directory/recommendations", e?.message);
    }

    const fromDirectory = mapSecureScoreProfilesToRecommendations(directoryRecs).filter((rec) => {
      const max = Number(rec.maxScore) || 0;
      const cur = Number(rec.currentScore) || 0;
      return max <= 0 || cur < max;
    });

    // Source principale : recommandations tenant-scopées de Graph beta.
    if (fromDirectory.length > 0) {
      return res.json({ success: true, recommendations: fromDirectory, total: fromDirectory.length });
    }

    // Fallback : réduire secureScoreControlProfiles aux contrôles réellement actionnables du tenant.
    const [profilesRecs, secureScores] = await Promise.all([
      callMicrosoftGraph("/security/secureScoreControlProfiles", accessToken, { getAllPages: true }).catch(
        () => null
      ),
      callMicrosoftGraph("/security/secureScores?$orderby=createdDateTime desc&$top=1", accessToken).catch(
        () => null
      ),
    ]);

    const latestSecureScore = getLatestSecureScoreWithControls(secureScores);
    const actionableControlIds = extractActionableControlIds(latestSecureScore);
    const filteredProfiles = Array.isArray(profilesRecs?.value)
      ? profilesRecs.value.filter((profile) =>
          actionableControlIds.size > 0 ? actionableControlIds.has(String(profile?.id || "")) : false
        )
      : [];

    const recommendations = mapSecureScoreProfilesToRecommendations({ value: filteredProfiles });
    res.json({ success: true, recommendations, total: recommendations.length });
  } catch (error) {
    console.error("secure-score-recommendations", error);
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des recommandations",
    });
  }
});

/**
 * GET /api/office365/security
 * Récupère les données de sécurité (MFA, rôles administrateurs)
 */
router.get("/security", verifyJWT, async (req, res) => {
  try {
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;

    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);

      // Si le client n'a pas de configuration spécifique, retourner une erreur
      // au lieu d'utiliser les settings globaux
      if (!credentials) {
        return res.status(400).json({
          success: false,
          error: `Configuration Azure non trouvée pour le client ${clientId}. Veuillez configurer les credentials Azure spécifiques à ce client.`
        });
      }
    } else {
      // Pour les appels sans clientId spécifié, utiliser les settings globaux
      const settings = await getOffice365Settings();
      if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
        credentials = {
          tenantId: settings.tenant_id,
          clientId: settings.client_id,
          clientSecret: settings.client_secret
        };
      }
    }

    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés"
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Récupérer toutes les données de sécurité en parallèle
    const [mfaReport, directoryRoles, usersData, signIns, riskDetections, servicePrincipalApps, secureScores, secureScoreProfiles, secureScoreHistory] = await Promise.all([
      // Rapport MFA (si disponible)
      callMicrosoftGraph("/reports/authenticationMethods/userRegistrationDetails", accessToken, { isReport: true }).catch((err) => {
        return null;
      }),
      // Rôles de répertoire (administrateurs)
      callMicrosoftGraph("/directoryRoles", accessToken).catch(() => null),
      // Utilisateurs pour vérifier les méthodes d'authentification
      callMicrosoftGraph("/users?$select=id,displayName,mail,userPrincipalName,accountEnabled", accessToken, { getAllPages: true }).catch(() => null),
      // Connexions pour détecter les activités suspectes
      callMicrosoftGraph("/auditLogs/signIns?$top=500&$orderby=createdDateTime desc", accessToken).catch(() => null),
      // Risques d'authentification
      callMicrosoftGraph("/identityProtection/riskDetections?$top=100&$orderby=detectedDateTime desc", accessToken).catch(() => null),
      // Applications tierces (service principals)
      callMicrosoftGraph("/servicePrincipals?$select=id,displayName,appId,servicePrincipalType", accessToken, { getAllPages: true }).catch(() => null),
      // Secure Scores (récupérer tous les scores pour filtrer Microsoft 365 Defender)
      callMicrosoftGraph("/security/secureScores?$orderby=createdDateTime desc", accessToken, { getAllPages: true }).catch(() => null),
      // Recommandations Entra ID - Essayer d'abord /directory/recommendations (beta), puis fallback sur secureScoreControlProfiles
      (async () => {
        try {
          const directoryRecs = await callMicrosoftGraph("/directory/recommendations", accessToken, { getAllPages: true, useBeta: true });
          if (directoryRecs && directoryRecs.value && directoryRecs.value.length > 0) {
            return directoryRecs;
          }
        } catch (err) {
          // Ignorer l'erreur et utiliser le fallback
        }
        // Fallback sur secureScoreControlProfiles
        try {
          return await callMicrosoftGraph("/security/secureScoreControlProfiles", accessToken, { getAllPages: true });
        } catch (err) {
          return null;
        }
      })(),
      // Historique du Secure Score (récupérer les 30 derniers jours)
      callMicrosoftGraph("/security/secureScores?$orderby=createdDateTime desc&$top=30", accessToken).catch(() => null)
    ]);

    // Logs réduits pour optimiser la synchronisation
    if (mfaReport && mfaReport.value && mfaReport.value.length > 0) {
    }

    // Traiter les données MFA
    let mfaStats = {
      totalUsers: 0,
      usersWithMFA: 0,
      usersWithoutMFA: 0,
      mfaRate: 0,
      mfaMethods: {
        authenticator: 0,
        phone: 0,
        sms: 0,
        email: 0
      }
    };

    if (mfaReport && mfaReport.value && mfaReport.value.length > 0) {
      // Le rapport CSV peut avoir des colonnes avec des espaces
      mfaStats.totalUsers = mfaReport.value.length;
      mfaReport.value.forEach(user => {
        // Essayer différentes variantes de noms de colonnes
        const isMfaRegistered = user['Is Mfa Registered'] === 'True' || 
                                user['IsMfaRegistered'] === 'True' || 
                                user.isMfaRegistered === true || 
                                user.isMfaRegistered === 'True';
        const isMfaCapable = user['Is Mfa Capable'] === 'True' || 
                            user['IsMfaCapable'] === 'True' || 
                            user.isMfaCapable === true || 
                            user.isMfaCapable === 'True';
        const hasMFA = isMfaRegistered || isMfaCapable;
        
        if (hasMFA) {
          mfaStats.usersWithMFA++;
        } else {
          mfaStats.usersWithoutMFA++;
        }
        
        // Compter les méthodes MFA (peut être une chaîne séparée par des virgules ou un tableau)
        const methodsRegistered = user['Methods Registered'] || 
                                  user['MethodsRegistered'] || 
                                  user.methodsRegistered || 
                                  '';
        const methodsArray = Array.isArray(methodsRegistered) 
          ? methodsRegistered 
          : (typeof methodsRegistered === 'string' ? methodsRegistered.split(',').map(m => m.trim()) : []);
        
        methodsArray.forEach(method => {
          const methodLower = method.toLowerCase();
          if (methodLower.includes('authenticator') || methodLower.includes('microsoftauthenticator')) {
            mfaStats.mfaMethods.authenticator++;
          }
          if (methodLower.includes('phone') || methodLower.includes('phoneauthentication')) {
            mfaStats.mfaMethods.phone++;
          }
          if (methodLower.includes('sms')) {
            mfaStats.mfaMethods.sms++;
          }
          if (methodLower.includes('email')) {
            mfaStats.mfaMethods.email++;
          }
        });
      });
      mfaStats.mfaRate = mfaStats.totalUsers > 0 ? Math.round((mfaStats.usersWithMFA / mfaStats.totalUsers) * 100) : 0;
    } else if (usersData && usersData.value && usersData.value.length > 0) {
      // Fallback : essayer de récupérer les méthodes d'authentification pour chaque utilisateur
      // Limiter à 100 utilisateurs pour éviter trop de requêtes
      mfaStats.totalUsers = usersData.value.length;
      const usersToCheck = usersData.value; // Récupérer TOUS les utilisateurs

      const mfaChecks = await Promise.allSettled(
        usersToCheck.map(async (user) => {
          try {
            const methods = await callMicrosoftGraph(`/users/${user.id}/authentication/methods`, accessToken).catch(() => null);
            // Un utilisateur a la MFA s'il a au moins une méthode d'authentification forte
            const hasMFA = methods && methods.value && methods.value.length > 0;
            return { userId: user.id, hasMFA };
          } catch {
            return { userId: user.id, hasMFA: false };
          }
        })
      );
      
      mfaChecks.forEach(result => {
        if (result.status === 'fulfilled') {
          const check = result.value;
          if (check.hasMFA) {
            mfaStats.usersWithMFA++;
          } else {
            mfaStats.usersWithoutMFA++;
          }
        } else {
          mfaStats.usersWithoutMFA++;
        }
      });
      
      // Estimer le total en extrapolant les résultats
      if (usersToCheck.length < usersData.value.length) {
        const sampleRate = mfaStats.usersWithMFA / usersToCheck.length;
        const estimatedWithMFA = Math.round(sampleRate * usersData.value.length);
        mfaStats.usersWithMFA = estimatedWithMFA;
        mfaStats.usersWithoutMFA = usersData.value.length - estimatedWithMFA;
      }
      
      mfaStats.mfaRate = mfaStats.totalUsers > 0 ? Math.round((mfaStats.usersWithMFA / mfaStats.totalUsers) * 100) : 0;
      // Logs réduits pour optimiser la synchronisation
    }

    // Traiter les rôles administrateurs
    const administrators = [];

    if (directoryRoles && directoryRoles.value) {
      // Rôles importants à vérifier - liste étendue
      const importantRoles = [
        'Global Administrator',
        'Privileged Role Administrator',
        'Exchange Administrator',
        'SharePoint Administrator',
        'User Administrator',
        'Security Administrator',
        'Billing Administrator',
        'Application Administrator',
        'Cloud Application Administrator',
        'Helpdesk Administrator',
        'Teams Administrator',
        'Power Platform Administrator',
        'Azure AD Joined Device Local Administrator',
        'Intune Administrator',
        'Windows 365 Administrator',
        'Compliance Administrator',
        'Conditional Access Administrator',
        'Authentication Administrator',
        'License Administrator',
        'Groups Administrator',
        'Password Administrator',
        'Directory Readers',
        'Guest Inviter',
        'Message Center Reader',
        'Reports Reader'
      ];

      for (const role of directoryRoles.value) {
        if (importantRoles.some(importantRole => role.displayName && role.displayName.includes(importantRole))) {
          try {
            const members = await callMicrosoftGraph(`/directoryRoles/${role.id}/members`, accessToken, { getAllPages: true }).catch(() => null);
            if (members && members.value) {
              members.value.forEach(member => {
                if (member['@odata.type'] === '#microsoft.graph.user') {
                  const email = (member.mail || member.userPrincipalName || '').toLowerCase().trim();
                  const alreadyExists = administrators.some(existing => existing.id === member.id || (existing.email && (existing.email).toLowerCase().trim() === email));
                  let hasMFA = false;
                  if (mfaReport && mfaReport.value) {
                    const mfaUser = mfaReport.value.find(u => u.userPrincipalName === member.userPrincipalName);
                    hasMFA = mfaUser && (mfaUser.isMfaRegistered === true || mfaUser.isMfaCapable === true);
                  }
                  if (!alreadyExists) {
                    administrators.push({
                      id: member.id,
                      name: member.displayName || member.userPrincipalName,
                      email: member.mail || member.userPrincipalName,
                      role: role.displayName,
                      hasMFA: hasMFA
                    });
                  } else {
                    const existing = administrators.find(existing => existing.id === member.id || (existing.email && (existing.email).toLowerCase().trim() === email));
                    if (existing && existing.role && !existing.role.includes(role.displayName)) {
                      existing.role = [existing.role, role.displayName].filter(Boolean).join(', ');
                    }
                  }
                }
              });
            }
          } catch (error) {
          }
        }
      }
    }

    // Essayer une approche alternative si peu d'administrateurs trouvés
    if (administrators.length < 5) {
      try {
        // Utiliser l'API roleAssignments pour une approche plus directe
        const roleAssignments = await callMicrosoftGraph('/roleManagement/directory/roleAssignments?$expand=principal&$top=200', accessToken).catch(() => null);

        if (roleAssignments && roleAssignments.value) {
          for (const assignment of roleAssignments.value) {
            if (assignment.principal && assignment.principal['@odata.type'] === '#microsoft.graph.user') {
              const user = assignment.principal;
              const roleDefinition = assignment.roleDefinition;

              // Vérifier si c'est un rôle administrateur
              if (roleDefinition && roleDefinition.displayName) {
                const isAdminRole = [
                  'Global Administrator', 'Privileged Role Administrator', 'User Administrator',
                  'Exchange Administrator', 'SharePoint Administrator', 'Security Administrator',
                  'Billing Administrator', 'Application Administrator', 'Cloud Application Administrator',
                  'Helpdesk Administrator', 'Teams Administrator', 'Intune Administrator'
                ].some(role => roleDefinition.displayName.includes(role));

                if (isAdminRole) {
                  const upn = (user.userPrincipalName || '').toLowerCase().trim();
                  const alreadyExists = administrators.some(existing => existing.id === user.id || (existing.email && (existing.email).toLowerCase().trim() === upn));
                  if (!alreadyExists) {
                    administrators.push({
                      id: user.id,
                      name: user.displayName || user.userPrincipalName,
                      email: user.userPrincipalName,
                      role: roleDefinition.displayName,
                      hasMFA: false
                    });
                  } else {
                    const existing = administrators.find(existing => existing.id === user.id || (existing.email && (existing.email).toLowerCase().trim() === upn));
                    if (existing && existing.role && !existing.role.includes(roleDefinition.displayName)) {
                      existing.role = [existing.role, roleDefinition.displayName].filter(Boolean).join(', ');
                    }
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        // Silent fail
      }
    }

    // Statistiques sur les administrateurs
    const adminStats = {
      total: administrators.length,
      withMFA: administrators.filter(a => a.hasMFA).length,
      withoutMFA: administrators.filter(a => !a.hasMFA).length,
      mfaRate: administrators.length > 0 ? Math.round((administrators.filter(a => a.hasMFA).length / administrators.length) * 100) : 0
    };

    // Sauvegarder les statistiques dans la base de données si clientId fourni
    if (clientId) {
      try {
        // Calculer les statistiques des utilisateurs non-administrateurs
        const totalUsers = mfaStats.totalUsers;
        const totalAdmins = adminStats.total;
        const nonAdminUsers = Math.max(0, totalUsers - totalAdmins);

        const adminMfaCount = adminStats.withMFA;
        const userMfaCount = Math.max(0, mfaStats.usersWithMFA - adminMfaCount);

        // Sauvegarder ou mettre à jour les statistiques
        await pool.query(`
          INSERT INTO v_b_clients_c_azure_stats (
            client_id,
            admin_count,
            user_count,
            admin_mfa_count,
            user_mfa_count,
            admin_mfa_percentage,
            user_mfa_percentage,
            last_sync
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
          ON CONFLICT (client_id) DO UPDATE SET
            admin_count = EXCLUDED.admin_count,
            user_count = EXCLUDED.user_count,
            admin_mfa_count = EXCLUDED.admin_mfa_count,
            user_mfa_count = EXCLUDED.user_mfa_count,
            admin_mfa_percentage = EXCLUDED.admin_mfa_percentage,
            user_mfa_percentage = EXCLUDED.user_mfa_percentage,
            last_sync = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        `, [
          clientId,
          totalAdmins,
          totalUsers,
          adminMfaCount,
          userMfaCount,
          adminStats.mfaRate,
          mfaStats.mfaRate,
        ]);

      } catch (dbError) {
        console.error('Erreur lors de la sauvegarde des statistiques Azure:', dbError);
        // Ne pas bloquer l'API si la sauvegarde échoue
      }
    }

    // Analyser les connexions suspectes
    const suspiciousConnections = {
      newLocations: [],
      newDevices: [],
      failedAttempts: []
    };
    
    if (signIns && signIns.value) {
      const userLocations = new Map();
      const userDevices = new Map();
      
      signIns.value.forEach(signIn => {
        const userId = signIn.userId || signIn.userPrincipalName;
        const location = signIn.location?.city || signIn.location?.countryOrRegion || 'Inconnu';
        const deviceId = signIn.deviceDetail?.deviceId || signIn.deviceDetail?.displayName || 'Inconnu';
        const isSuccessful = signIn.status?.errorCode === 0;
        
        // Nouveaux emplacements
        if (!userLocations.has(userId)) {
          userLocations.set(userId, new Set());
        }
        if (!userLocations.get(userId).has(location) && isSuccessful) {
          userLocations.get(userId).add(location);
          suspiciousConnections.newLocations.push({
            user: signIn.userDisplayName || userId,
            location: location,
            date: signIn.createdDateTime,
            ipAddress: signIn.ipAddress
          });
        }
        
        // Nouveaux appareils
        if (!userDevices.has(userId)) {
          userDevices.set(userId, new Set());
        }
        if (!userDevices.get(userId).has(deviceId) && isSuccessful) {
          userDevices.get(userId).add(deviceId);
          suspiciousConnections.newDevices.push({
            user: signIn.userDisplayName || userId,
            device: signIn.deviceDetail?.displayName || deviceId,
            date: signIn.createdDateTime,
            os: signIn.deviceDetail?.operatingSystem || 'Inconnu'
          });
        }
        
        // Tentatives échouées
        if (!isSuccessful && signIn.status?.errorCode >= 50000) {
          suspiciousConnections.failedAttempts.push({
            user: signIn.userDisplayName || userId,
            errorCode: signIn.status.errorCode,
            errorMessage: signIn.status.failureReason || 'Échec d\'authentification',
            date: signIn.createdDateTime,
            ipAddress: signIn.ipAddress,
            location: location
          });
        }
      });
      
      // Limiter à 20 par catégorie
      suspiciousConnections.newLocations = suspiciousConnections.newLocations.slice(0, 20);
      suspiciousConnections.newDevices = suspiciousConnections.newDevices.slice(0, 20);
      suspiciousConnections.failedAttempts = suspiciousConnections.failedAttempts.slice(0, 20);
    }

    // Traiter les risques d'authentification
    const authenticationRisks = [];
    if (riskDetections && riskDetections.value) {
      riskDetections.value.forEach(risk => {
        authenticationRisks.push({
          id: risk.id,
          user: risk.userDisplayName || risk.userPrincipalName || 'Utilisateur inconnu',
          riskType: risk.riskType || 'Unknown',
          riskLevel: risk.riskLevel || 'medium',
          detectedDateTime: risk.detectedDateTime,
          ipAddress: risk.ipAddress,
          location: risk.location?.city || risk.location?.countryOrRegion || 'Inconnu'
        });
      });
    }

    // Récupérer les politiques de conformité (si disponibles)
    // Certains endpoints nécessitent des permissions élevées (Security.Read.All). Pour éviter les erreurs 401,
    // on n'appelle plus ces endpoints si les permissions ne sont pas garanties.
    const compliance = {
      retentionPolicies: []
    };

    // Secure Score - Filtrer pour Microsoft 365 Defender et Entra ID
    let secureScoreData = null;
    let defenderSecureScoreData = null;
    let secureScoreHistoryData = [];
    
    if (secureScores && secureScores.value && secureScores.value.length > 0) {
      const providers = [...new Set(secureScores.value.map(s => s.vendorInformation?.provider || 'null'))];
      // Séparer les scores par provider
      // Le Secure Score Entra ID peut avoir différents providers : Microsoft, AzureActiveDirectory, SecureScore, ou null
      const entraIDScores = secureScores.value.filter(score => {
        const provider = score.vendorInformation?.provider || '';
        // Exclure explicitement Microsoft 365 Defender
        if (provider === "Microsoft365Defender" || provider === "Microsoft Defender for Office 365") {
          return false;
        }
        // Inclure tous les autres (Microsoft, AzureActiveDirectory, SecureScore, null, etc.)
        return true;
      });
      
      const defenderScores = secureScores.value.filter(score => 
        score.vendorInformation?.provider === "Microsoft365Defender" ||
        score.vendorInformation?.provider === "Microsoft Defender for Office 365"
      );
      // Traiter le Secure Score Entra ID (Identity)
      let entraIDScoreId = null;
      if (entraIDScores.length > 0) {
        const latestEntraScore = entraIDScores.sort((a, b) => {
          const dateA = new Date(a.createdDateTime || a.averageComparativeScores?.[0]?.basisDateTime || 0);
          const dateB = new Date(b.createdDateTime || b.averageComparativeScores?.[0]?.basisDateTime || 0);
          return dateB - dateA;
        })[0];
        
        entraIDScoreId = latestEntraScore.id;
        
        secureScoreData = {
          currentScore: latestEntraScore.currentScore || 0,
          maxScore: latestEntraScore.maxScore || 0,
          percentage: latestEntraScore.maxScore ? Math.round((latestEntraScore.currentScore / latestEntraScore.maxScore) * 1000) / 10 : null,
          activeUserCount: latestEntraScore.activeUserCount || 0,
          enabledServices: latestEntraScore.enabledServices || [],
          licensedUserCount: latestEntraScore.licensedUserCount || 0,
          averageComparativeScores: latestEntraScore.averageComparativeScores || [],
          createdDateTime: latestEntraScore.createdDateTime || latestEntraScore.averageComparativeScores?.[0]?.basisDateTime || null,
          provider: "Entra ID",
          id: latestEntraScore.id
        };
      } else {
      }
      
      // Traiter le Microsoft 365 Defender Secure Score
      if (defenderScores.length > 0) {
        const latestDefenderScore = defenderScores.sort((a, b) => {
          const dateA = new Date(a.createdDateTime || 0);
          const dateB = new Date(b.createdDateTime || 0);
          return dateB - dateA;
        })[0];
        
        defenderSecureScoreData = {
          currentScore: latestDefenderScore.currentScore || 0,
          maxScore: latestDefenderScore.maxScore || 0,
          percentage: latestDefenderScore.maxScore ? Math.round((latestDefenderScore.currentScore / latestDefenderScore.maxScore) * 1000) / 10 : null,
          averageComparativeScores: latestDefenderScore.averageComparativeScores || [],
          createdDateTime: latestDefenderScore.createdDateTime || null,
          provider: "Microsoft 365 Defender",
          vendorInformation: latestDefenderScore.vendorInformation || null
        };
        
        // Construire l'historique du score (30 derniers jours)
        if (secureScoreHistory && secureScoreHistory.value) {
          const defenderHistory = secureScoreHistory.value
            .filter(score => 
              score.vendorInformation?.provider === "Microsoft365Defender" ||
              score.vendorInformation?.provider === "Microsoft Defender for Office 365"
            )
            .sort((a, b) => {
              const dateA = new Date(a.createdDateTime || 0);
              const dateB = new Date(b.createdDateTime || 0);
              return dateA - dateB; // Ordre chronologique
            })
            .map(score => ({
              date: score.createdDateTime,
              score: score.currentScore || 0,
              maxScore: score.maxScore || 0,
              percentage: score.maxScore ? Math.round((score.currentScore / score.maxScore) * 1000) / 10 : null
            }));
          
          secureScoreHistoryData = defenderHistory;
        }
      }
    }

    const secureScoreRecommendations = mapSecureScoreProfilesToRecommendations(secureScoreProfiles);

    // Récupérer les détails d'inscription MFA pour tous les utilisateurs
    let userMfaDetails = [];
    if (usersData && usersData.value && usersData.value.length > 0) {
      const usersToCheck = usersData.value; // Récupérer TOUS les utilisateurs

      const mfaDetailsPromises = usersToCheck.map(async (user) => {
        try {
          const methods = await callMicrosoftGraph(`/users/${user.id}/authentication/methods`, accessToken).catch(() => null);

          const methodTypes = [];
          const methodDetails = [];
          if (methods && methods.value && Array.isArray(methods.value)) {
            methods.value.forEach(method => {
              if (method['@odata.type']) {
                const type = method['@odata.type'].split('.').pop().toLowerCase();
                methodTypes.push(type);
                methodDetails.push({
                  type: type,
                  createdDateTime: method.createdDateTime,
                  displayName: method.displayName || type
                });
              }
            });
          }

          // Trouver la date de dernière inscription MFA (date la plus récente)
          // UNIQUEMENT si l'utilisateur a au moins une vraie méthode MFA
          let lastMfaEnrollmentDate = null;
          if (methodDetails.length > 0) {
            // Filtrer seulement les vraies méthodes MFA (pas password, pas windows hello)
            const realMfaMethods = methodDetails.filter(method =>
              method.type === 'emailauthenticationmethod' ||
              method.type === 'softwareoathauthenticationmethod' ||
              method.type === 'phoneauthenticationmethod' ||
              method.type === 'microsoftauthenticatorauthenticationmethod'
            );

            // Si l'utilisateur a au moins une vraie MFA, prendre la date la plus récente
            if (realMfaMethods.length > 0) {
              const sortedMethods = realMfaMethods
                .filter(method => method.createdDateTime)
                .sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime));

              if (sortedMethods.length > 0) {
                lastMfaEnrollmentDate = sortedMethods[0].createdDateTime;
              }
            }
          }

          // Une vraie MFA c'est soit email, software, phone, ou authenticator
          // Exclure le mot de passe et autres méthodes non-MFA ; dédupliquer les types
          const mfaMethods = [...new Set(methodTypes)].filter(type =>
            type === 'emailauthenticationmethod' ||
            type === 'softwareoathauthenticationmethod' ||
            type === 'phoneauthenticationmethod' ||
            type === 'microsoftauthenticatorauthenticationmethod'
          );
          const hasMFA = mfaMethods.length > 0;

          return {
            id: user.id,
            displayName: user.displayName || user.userPrincipalName,
            userPrincipalName: user.userPrincipalName,
            hasMFA: hasMFA,
            mfaMethods: [...new Set(methodTypes)],
            lastMfaEnrollmentDate: lastMfaEnrollmentDate
          };
        } catch (error) {
          return {
            id: user.id,
            displayName: user.displayName || user.userPrincipalName,
            userPrincipalName: user.userPrincipalName,
            hasMFA: false,
            mfaMethods: [],
            lastMfaEnrollmentDate: null,
            error: true
          };
        }
      });

      userMfaDetails = await Promise.allSettled(mfaDetailsPromises);
      userMfaDetails = userMfaDetails
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);

    }

    // Sauvegarder les données en base si clientId fourni
    if (clientId) {
      try {
        // Calculer et sauvegarder les statistiques des méthodes MFA
        try {
          let emailMfaCount = 0;
          let softwareMfaCount = 0;
          let phoneMfaCount = 0;
          let authenticatorMfaCount = 0;

          // Analyser les méthodes MFA des utilisateurs récupérés
          userMfaDetails.forEach(userDetail => {
            if (userDetail.mfaMethods && Array.isArray(userDetail.mfaMethods)) {
              if (userDetail.mfaMethods.includes('emailauthenticationmethod')) emailMfaCount++;
              if (userDetail.mfaMethods.includes('softwareoathauthenticationmethod')) softwareMfaCount++;
              if (userDetail.mfaMethods.includes('phoneauthenticationmethod')) phoneMfaCount++;
              if (userDetail.mfaMethods.includes('microsoftauthenticatorauthenticationmethod')) authenticatorMfaCount++;
            }
          });

          const totalUsers = mfaStats.totalUsers || 0;
          const emailMfaPercentage = totalUsers > 0 ? Math.round((emailMfaCount / totalUsers) * 100) : 0;
          const softwareMfaPercentage = totalUsers > 0 ? Math.round((softwareMfaCount / totalUsers) * 100) : 0;
          const phoneMfaPercentage = totalUsers > 0 ? Math.round((phoneMfaCount / totalUsers) * 100) : 0;
          const authenticatorMfaPercentage = totalUsers > 0 ? Math.round((authenticatorMfaCount / totalUsers) * 100) : 0;

          await pool.query(`
            UPDATE v_b_clients_c_azure_stats SET
              email_mfa_count = $1,
              software_mfa_count = $2,
              phone_mfa_count = $3,
              authenticator_mfa_count = $4,
              email_mfa_percentage = $5,
              software_mfa_percentage = $6,
              phone_mfa_percentage = $7,
              authenticator_mfa_percentage = $8,
              updated_at = CURRENT_TIMESTAMP
            WHERE client_id = $9
          `, [
            emailMfaCount,
            softwareMfaCount,
            phoneMfaCount,
            authenticatorMfaCount,
            emailMfaPercentage,
            softwareMfaPercentage,
            phoneMfaPercentage,
            authenticatorMfaPercentage,
            clientId
          ]);

        } catch (mfaStatsError) {
          console.error('Erreur lors de la sauvegarde des statistiques MFA:', mfaStatsError);
        }

        // Sauvegarder les détails des utilisateurs MFA
        try {


          let adminCount = 0;
          for (const userDetail of userMfaDetails) {
            // Collecter tous les rôles admin de l'utilisateur (matching avec la liste des administrateurs)
            const adminRoles = [];

            for (const admin of administrators) {
              // Correspondance stricte : identifiant Azure AD (id) ou UPN exact uniquement
              const userUpn = (userDetail.userPrincipalName || '').toLowerCase().trim();
              const adminEmail = (admin.email || '').toLowerCase().trim();
              const matchById = admin.id && userDetail.id && String(admin.id) === String(userDetail.id);
              const matchByUpn = userUpn && adminEmail && userUpn === adminEmail;
              if (matchById || matchByUpn) {
                if (admin.role && !adminRoles.includes(admin.role)) {
                  adminRoles.push(admin.role);
                }
              }
            }

            const isAdmin = adminRoles.length > 0;
            const adminRoleText = adminRoles.join(', ');

            if (isAdmin) adminCount++;

            await pool.query(`
              INSERT INTO v_b_clients_c_azure_mfa (
                client_id,
                user_id,
                display_name,
                user_principal_name,
                account_enabled,
                has_mfa,
                mfa_methods,
                latest_mfa_registration_date,
                is_admin,
                admin_role,
                last_sync
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
              ON CONFLICT (client_id, user_id) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                user_principal_name = EXCLUDED.user_principal_name,
                account_enabled = EXCLUDED.account_enabled,
                has_mfa = EXCLUDED.has_mfa,
                mfa_methods = EXCLUDED.mfa_methods,
                latest_mfa_registration_date = EXCLUDED.latest_mfa_registration_date,
                is_admin = EXCLUDED.is_admin,
                admin_role = EXCLUDED.admin_role,
                last_sync = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            `, [
              clientId,
              userDetail.id,
              userDetail.displayName,
              userDetail.userPrincipalName,
              true, // accountEnabled par défaut
              userDetail.hasMFA,
              JSON.stringify(userDetail.mfaMethods || []),
              userDetail.lastMfaEnrollmentDate,
              isAdmin,
              adminRoleText || null
            ]);
          }

        } catch (userDetailsError) {
          console.error('Erreur lors de la sauvegarde des détails utilisateurs:', userDetailsError);
        }
      } catch (dbError) {
        console.error('Erreur lors de la sauvegarde en base:', dbError);
        // Ne pas bloquer l'API si la sauvegarde échoue
      }
    }

    res.json({
      success: true,
      mfa: mfaStats,
      administrators: administrators,
      adminStats: adminStats,
      userMfaDetails: userMfaDetails,
      suspiciousConnections: suspiciousConnections,
      authenticationRisks: authenticationRisks,
      compliance: compliance,
      secureScore: secureScoreData, // Entra ID Secure Score
      defenderSecureScore: defenderSecureScoreData, // Microsoft 365 Defender Secure Score
      secureScoreHistory: secureScoreHistoryData, // Historique du score
      secureScoreRecommendations: secureScoreRecommendations
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des données de sécurité"
    });
  }
});

/**
 * GET /api/office365/applications
 * Récupère les données d'utilisation des applications Microsoft 365
 */
router.get("/applications", verifyJWT, async (req, res) => {
  try {
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;
    
    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);
    }
    
    if (!credentials) {
      const settings = await getOffice365Settings();
      if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
        credentials = {
          tenantId: settings.tenant_id,
          clientId: settings.client_id,
          clientSecret: settings.client_secret
        };
      }
    }
    
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés"
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Toujours utiliser D90 pour récupérer le maximum de données, puis filtrer selon les dates du rapport
    const period = 'D90';
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;
    
    // Récupérer les données d'utilisation des applications
    // Utiliser getOffice365ServicesUserCounts pour obtenir les utilisateurs par service (plus fiable)
    const [office365Apps, outlookApps, teamsApps, onedriveApps, sharepointApps, servicePrincipals, activeUserCounts, servicesUserCounts] = await Promise.all([
      // getOffice365ActiveUserDetail pour les détails d'activation Word/Excel/PowerPoint
      callMicrosoftGraph(`/reports/getOffice365ActiveUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getEmailAppUsageUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getTeamsUserActivityUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getOneDriveUsageAccountDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getSharePointActivityUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      // Applications tierces (service principals)
      callMicrosoftGraph("/servicePrincipals?$select=id,displayName,appId,servicePrincipalType,appDisplayName&$filter=servicePrincipalType eq 'Application'", accessToken, { getAllPages: true }).catch(() => null),
      // Nombre d'utilisateurs actifs par jour
      callMicrosoftGraph(`/reports/getOffice365ActiveUserCounts(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      // Nombre d'utilisateurs par service par jour (Word, Excel, PowerPoint, Outlook, Teams, OneDrive, SharePoint)
      callMicrosoftGraph(`/reports/getOffice365ServicesUserCounts(period='${period}')`, accessToken, { isReport: true }).catch(() => null)
    ]);

    // Traiter les données d'utilisation
    // Utiliser getOffice365ServicesUserCounts comme source principale pour les utilisateurs par service
    const appUsage = {
      word: { users: 0, activations: 0 },
      excel: { users: 0, activations: 0 },
      powerpoint: { users: 0, activations: 0 },
      outlook: { users: 0, activations: 0 },
      teams: { users: 0, activations: 0 },
      onedrive: { users: 0, activations: 0 },
      sharepoint: { users: 0, activations: 0 }
    };

    // Utiliser servicesUserCounts pour obtenir les utilisateurs uniques par service sur la période
    if (servicesUserCounts && servicesUserCounts.value) {
      let filteredServiceCounts = servicesUserCounts.value;
      if (startDate && endDate) {
        filteredServiceCounts = servicesUserCounts.value.filter(entry => {
          const reportDate = entry['Report Date'] || entry['ReportDate'] || entry.date || '';
          if (!reportDate) return false;
          try {
            const date = new Date(reportDate);
            const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
            const endDateOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
            return dateOnly >= startDateOnly && dateOnly <= endDateOnly;
          } catch {
            return false;
          }
        });
      }

      // Calculer les utilisateurs uniques par service (maximum sur la période)
      const serviceMaxUsers = {
        'Microsoft Word': 0,
        'Microsoft Excel': 0,
        'Microsoft PowerPoint': 0,
        'Microsoft Outlook': 0,
        'Microsoft Teams': 0,
        'OneDrive For Business': 0,
        'SharePoint': 0
      };

      filteredServiceCounts.forEach(entry => {
        const serviceName = entry['Service Name'] || entry['ServiceName'] || entry.serviceName || '';
        const activeUsers = parseInt(entry['Active Users Count'] || entry['ActiveUsersCount'] || entry.activeUsers || 0);
        
        if (serviceName && activeUsers > 0) {
          // Normaliser le nom du service
          const normalizedService = serviceName.toLowerCase();
          if (normalizedService.includes('word')) {
            serviceMaxUsers['Microsoft Word'] = Math.max(serviceMaxUsers['Microsoft Word'], activeUsers);
          } else if (normalizedService.includes('excel')) {
            serviceMaxUsers['Microsoft Excel'] = Math.max(serviceMaxUsers['Microsoft Excel'], activeUsers);
          } else if (normalizedService.includes('powerpoint')) {
            serviceMaxUsers['Microsoft PowerPoint'] = Math.max(serviceMaxUsers['Microsoft PowerPoint'], activeUsers);
          } else if (normalizedService.includes('outlook')) {
            serviceMaxUsers['Microsoft Outlook'] = Math.max(serviceMaxUsers['Microsoft Outlook'], activeUsers);
          } else if (normalizedService.includes('teams')) {
            serviceMaxUsers['Microsoft Teams'] = Math.max(serviceMaxUsers['Microsoft Teams'], activeUsers);
          } else if (normalizedService.includes('onedrive')) {
            serviceMaxUsers['OneDrive For Business'] = Math.max(serviceMaxUsers['OneDrive For Business'], activeUsers);
          } else if (normalizedService.includes('sharepoint')) {
            serviceMaxUsers['SharePoint'] = Math.max(serviceMaxUsers['SharePoint'], activeUsers);
          }
        }
      });

      appUsage.word.users = serviceMaxUsers['Microsoft Word'];
      appUsage.excel.users = serviceMaxUsers['Microsoft Excel'];
      appUsage.powerpoint.users = serviceMaxUsers['Microsoft PowerPoint'];
      appUsage.outlook.users = serviceMaxUsers['Microsoft Outlook'];
      appUsage.teams.users = serviceMaxUsers['Microsoft Teams'];
      appUsage.onedrive.users = serviceMaxUsers['OneDrive For Business'];
      appUsage.sharepoint.users = serviceMaxUsers['SharePoint'];
    }

    // Utiliser les rapports détaillés pour les activations (Word, Excel, PowerPoint)
    if (office365Apps && office365Apps.value) {
      office365Apps.value.forEach(user => {
        // Essayer différentes variantes de noms de colonnes
        const wordActivated = parseInt(user['Word Activated'] || user['WordActivated'] || user['Word Activated Count'] || user['WordActivatedCount'] || 0);
        const excelActivated = parseInt(user['Excel Activated'] || user['ExcelActivated'] || user['Excel Activated Count'] || user['ExcelActivatedCount'] || 0);
        const powerpointActivated = parseInt(user['PowerPoint Activated'] || user['PowerPointActivated'] || user['PowerPoint Activated Count'] || user['PowerPointActivatedCount'] || 0);
        
          appUsage.word.activations += wordActivated;
          appUsage.excel.activations += excelActivated;
          appUsage.powerpoint.activations += powerpointActivated;
      });
    }

    // Utiliser les rapports détaillés comme fallback si servicesUserCounts n'est pas disponible
    if (appUsage.outlook.users === 0 && outlookApps && outlookApps.value) {
      const outlookUsers = new Set();
      outlookApps.value.forEach(user => {
        const outlookUsed = user['Outlook'] || user['Outlook Used'] || user['OutlookUsed'] || 'No';
        if (outlookUsed === 'Yes' || outlookUsed === true || outlookUsed === '1') {
          outlookUsers.add(user['User Principal Name'] || user['UserPrincipalName'] || user['UserPrincipalName'] || '');
        }
      });
      appUsage.outlook.users = outlookUsers.size;
    }

    if (appUsage.teams.users === 0 && teamsApps && teamsApps.value) {
      const teamsUsers = new Set();
      teamsApps.value.forEach(user => {
        const teamChatCount = parseInt(user['Team Chat Message Count'] || user['TeamChatMessageCount'] || 0);
        const privateChatCount = parseInt(user['Private Chat Message Count'] || user['PrivateChatMessageCount'] || 0);
        const meetingCount = parseInt(user['Meeting Count'] || user['MeetingCount'] || 0);
        if (teamChatCount > 0 || privateChatCount > 0 || meetingCount > 0) {
          teamsUsers.add(user['User Principal Name'] || user['UserPrincipalName'] || '');
        }
      });
      appUsage.teams.users = teamsUsers.size;
    }

    if (appUsage.onedrive.users === 0 && onedriveApps && onedriveApps.value) {
      const onedriveUsers = new Set();
      onedriveApps.value.forEach(user => {
        const filesViewed = parseInt(user['Files Viewed'] || user['FilesViewed'] || user['Files Viewed Or Edited'] || user['FilesViewedOrEdited'] || 0);
        if (filesViewed > 0) {
          onedriveUsers.add(user['User Principal Name'] || user['UserPrincipalName'] || user['Owner Principal Name'] || user['OwnerPrincipalName'] || '');
        }
      });
      appUsage.onedrive.users = onedriveUsers.size;
    }

    if (appUsage.sharepoint.users === 0 && sharepointApps && sharepointApps.value) {
      const sharepointUsers = new Set();
      sharepointApps.value.forEach(user => {
        const filesViewed = parseInt(user['Files Viewed'] || user['FilesViewed'] || user['Files Viewed Or Edited'] || user['FilesViewedOrEdited'] || 0);
        if (filesViewed > 0) {
          sharepointUsers.add(user['User Principal Name'] || user['UserPrincipalName'] || '');
        }
      });
      appUsage.sharepoint.users = sharepointUsers.size;
    }

    // Traiter les données quotidiennes pour les graphiques
    // Nombre d'utilisateurs par app par jour - utiliser getOffice365ServicesUserCounts
    const usersByAppDaily = [];
    if (servicesUserCounts && servicesUserCounts.value) {
      let filteredServiceCounts = servicesUserCounts.value;
      if (startDate && endDate) {
        filteredServiceCounts = servicesUserCounts.value.filter(entry => {
          const reportDate = entry['Report Date'] || entry['ReportDate'] || entry.date || '';
          if (!reportDate) return false;
          try {
            const date = new Date(reportDate);
            const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
            const endDateOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
            return dateOnly >= startDateOnly && dateOnly <= endDateOnly;
          } catch {
            return false;
          }
        });
      }
      
      // Grouper par date et service
      const dailyData = {};
      filteredServiceCounts.forEach(entry => {
        const reportDate = entry['Report Date'] || entry['ReportDate'] || entry.date || '';
        if (!reportDate) return;
        
        if (!dailyData[reportDate]) {
          dailyData[reportDate] = {
            date: reportDate,
            Word: 0,
            Excel: 0,
            PowerPoint: 0,
            Outlook: 0,
            Teams: 0,
            OneDrive: 0,
            SharePoint: 0
          };
        }
        
        // Les colonnes sont : "Service Name", "Active Users Count"
        const serviceName = (entry['Service Name'] || entry['ServiceName'] || entry.serviceName || '').toLowerCase();
        const activeUsers = parseInt(entry['Active Users Count'] || entry['ActiveUsersCount'] || entry.activeUsers || 0);
        
        if (serviceName.includes('word')) {
          dailyData[reportDate].Word += activeUsers;
        } else if (serviceName.includes('excel')) {
          dailyData[reportDate].Excel += activeUsers;
        } else if (serviceName.includes('powerpoint')) {
          dailyData[reportDate].PowerPoint += activeUsers;
        } else if (serviceName.includes('outlook')) {
          dailyData[reportDate].Outlook += activeUsers;
        } else if (serviceName.includes('teams')) {
          dailyData[reportDate].Teams += activeUsers;
        } else if (serviceName.includes('onedrive')) {
          dailyData[reportDate].OneDrive += activeUsers;
        } else if (serviceName.includes('sharepoint')) {
          dailyData[reportDate].SharePoint += activeUsers;
        }
      });
      
      usersByAppDaily.push(...Object.values(dailyData));
      usersByAppDaily.sort((a, b) => {
        const dateA = new Date(a.date);
        const dateB = new Date(b.date);
        return dateA - dateB;
      });
    }
    
    // Nombre d'utilisateurs par plateforme par jour
    const usersByPlatformDaily = [];
    if (servicesUserCounts && servicesUserCounts.value) {
      let filteredServiceCounts = servicesUserCounts.value;
      if (startDate && endDate) {
        filteredServiceCounts = servicesUserCounts.value.filter(entry => {
          const reportDate = entry['Report Date'] || entry['ReportDate'] || entry.date || '';
          if (!reportDate) return false;
          try {
            const date = new Date(reportDate);
            const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
            const endDateOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
            return dateOnly >= startDateOnly && dateOnly <= endDateOnly;
          } catch {
            return false;
          }
        });
      }
      
      // Grouper par date et plateforme
      const dailyPlatformData = {};
      filteredServiceCounts.forEach(entry => {
        const reportDate = entry['Report Date'] || entry['ReportDate'] || entry.date || '';
        if (!reportDate) return;
        
        if (!dailyPlatformData[reportDate]) {
          dailyPlatformData[reportDate] = {
            date: reportDate,
            Windows: 0,
            Mac: 0,
            Web: 0,
            Mobile: 0,
            Linux: 0
          };
        }
        
        // Les colonnes peuvent être : "Platform", "Active Users Count", etc.
        const platform = (entry['Platform'] || entry.platform || '').toLowerCase();
        const activeUsers = parseInt(entry['Active Users Count'] || entry['ActiveUsersCount'] || entry.activeUsers || 0);
        
        if (platform.includes('windows')) {
          dailyPlatformData[reportDate].Windows += activeUsers;
        } else if (platform.includes('mac') || platform.includes('macos')) {
          dailyPlatformData[reportDate].Mac += activeUsers;
        } else if (platform.includes('web') || platform.includes('browser')) {
          dailyPlatformData[reportDate].Web += activeUsers;
        } else if (platform.includes('mobile') || platform.includes('ios') || platform.includes('android')) {
          dailyPlatformData[reportDate].Mobile += activeUsers;
        } else if (platform.includes('linux')) {
          dailyPlatformData[reportDate].Linux += activeUsers;
        }
      });
      
      usersByPlatformDaily.push(...Object.values(dailyPlatformData));
      usersByPlatformDaily.sort((a, b) => new Date(a.date) - new Date(b.date));
    }

    res.json({
      success: true,
      applications: appUsage,
      // Données quotidiennes pour les graphiques
      dailyUsersByApp: usersByAppDaily,
      dailyUsersByPlatform: usersByPlatformDaily,
      lastUpdate: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des données d'applications"
    });
  }
});

/**
 * GET /api/office365/alerts
 * Récupère les alertes et problèmes Office 365
 */
router.get("/alerts", verifyJWT, async (req, res) => {
  try {
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let credentials = null;
    
    if (clientId) {
      credentials = await getClientOffice365Credentials(clientId);
    }
    
    if (!credentials) {
      const settings = await getOffice365Settings();
      if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
        credentials = {
          tenantId: settings.tenant_id,
          clientId: settings.client_id,
          clientSecret: settings.client_secret
        };
      }
    }
    
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Paramètres Office 365 non configurés"
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Récupérer les alertes de sécurité et l'état des services
    const [securityAlerts, serviceHealth, auditLogs] = await Promise.all([
      // Alertes de sécurité (si disponible)
      callMicrosoftGraph("/security/alerts?$top=50&$orderby=createdDateTime desc", accessToken).catch(() => null),
      // État de santé des services
      callMicrosoftGraph("/admin/serviceAnnouncement/healthOverviews", accessToken).catch(() => null),
      // Journaux d'audit pour détecter les activités suspectes
      callMicrosoftGraph("/auditLogs/signIns?$top=100&$orderby=createdDateTime desc", accessToken).catch(() => null)
    ]);

    const alerts = {
      security: [],
      serviceHealth: [],
      critical: []
    };

    // Traiter les alertes de sécurité
    if (securityAlerts && securityAlerts.value) {
      securityAlerts.value.forEach(alert => {
        alerts.security.push({
          id: alert.id,
          title: alert.title || 'Alerte de sécurité',
          severity: alert.severity || 'medium',
          status: alert.status || 'new',
          created: alert.createdDateTime,
          description: alert.description || ''
        });
        
        if (alert.severity === 'high' || alert.severity === 'critical') {
          alerts.critical.push({
            id: alert.id,
            title: alert.title || 'Alerte de sécurité critique',
            type: 'security',
            severity: alert.severity,
            created: alert.createdDateTime
          });
        }
      });
    }

    // Traiter l'état de santé des services
    if (serviceHealth && serviceHealth.value) {
      serviceHealth.value.forEach(service => {
        if (service.status !== 'serviceOperational') {
          alerts.serviceHealth.push({
            id: service.id,
            service: service.service || 'Service inconnu',
            status: service.status,
            issues: service.issues || []
          });
          
          alerts.critical.push({
            id: service.id,
            title: `Problème avec ${service.service || 'un service'}`,
            type: 'service',
            severity: service.status === 'serviceDegradation' ? 'medium' : 'high',
            created: new Date().toISOString()
          });
        }
      });
    }

    // Détecter les activités suspectes dans les journaux d'audit
    if (auditLogs && auditLogs.value) {
      const suspiciousActivities = auditLogs.value.filter(log => {
        // Détecter les connexions depuis de nouveaux emplacements ou échecs multiples
        return log.riskLevel === 'high' || 
               log.riskLevel === 'medium' ||
               (log.status && log.status.errorCode && parseInt(log.status.errorCode) >= 50000);
      });

      suspiciousActivities.slice(0, 10).forEach(activity => {
        alerts.security.push({
          id: activity.id || `audit-${Date.now()}`,
          title: 'Activité suspecte détectée',
          severity: activity.riskLevel === 'high' ? 'high' : 'medium',
          status: 'active',
          created: activity.createdDateTime,
          description: `Connexion depuis ${activity.location?.city || 'emplacement inconnu'}`
        });
      });
    }

    // Statistiques
    const stats = {
      totalSecurity: alerts.security.length,
      totalServiceIssues: alerts.serviceHealth.length,
      totalCritical: alerts.critical.length,
      highSeverity: alerts.security.filter(a => a.severity === 'high' || a.severity === 'critical').length
    };

    res.json({
      success: true,
      alerts: alerts,
      stats: stats,
      lastUpdate: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des alertes"
    });
  }
});

/**
 * GET /api/office365/stats/saved/:clientId
 * Récupère les statistiques Azure sauvegardées pour un client
 */
router.get("/stats/saved/:clientId", verifyJWT, async (req, res) => {
  try {
    const { clientId } = req.params;

    // Calculer les statistiques directement depuis v_b_clients_c_azure_mfa
    const result = await pool.query(`
      SELECT
        -- Comptages totaux
        COUNT(*) as total_users,
        COUNT(CASE WHEN is_admin = true THEN 1 END) as admin_count,
        COUNT(CASE WHEN is_admin IS NULL OR is_admin = false THEN 1 END) as regular_user_count,

        -- MFA par type d'utilisateur (utilise la colonne has_mfa corrigée)
        COUNT(CASE WHEN has_mfa = true THEN 1 END) as users_with_mfa,
        COUNT(CASE WHEN has_mfa = true AND is_admin = true THEN 1 END) as admins_with_mfa,
        COUNT(CASE WHEN has_mfa = true AND (is_admin IS NULL OR is_admin = false) THEN 1 END) as regular_users_with_mfa,

        -- Méthodes MFA détaillées (pour utilisateurs ayant has_mfa = true)
        COUNT(CASE WHEN has_mfa = true AND mfa_methods ? 'emailauthenticationmethod' THEN 1 END) as email_mfa_count,
        COUNT(CASE WHEN has_mfa = true AND mfa_methods ? 'softwareoathauthenticationmethod' THEN 1 END) as software_mfa_count,
        COUNT(CASE WHEN has_mfa = true AND mfa_methods ? 'phoneauthenticationmethod' THEN 1 END) as phone_mfa_count,
        COUNT(CASE WHEN has_mfa = true AND mfa_methods ? 'microsoftauthenticatorauthenticationmethod' THEN 1 END) as authenticator_mfa_count,

        -- Debug: comptage des valeurs nulles
        COUNT(CASE WHEN is_admin IS NULL THEN 1 END) as null_admin_count,
        COUNT(CASE WHEN has_mfa IS NULL THEN 1 END) as null_mfa_count,
        COUNT(CASE WHEN has_mfa = false THEN 1 END) as false_mfa_count,

        MAX(last_sync) as last_sync
      FROM v_b_clients_c_azure_mfa
      WHERE client_id = $1 AND account_enabled = true
    `, [clientId]);

    if (result.rows.length === 0 || result.rows[0].total_users === 0) {
      return res.json({
        success: true,
        stats: null,
        message: "Aucune donnée MFA sauvegardée pour ce client"
      });
    }

    const data = result.rows[0];

    const totalUsers = parseInt(data.total_users);
    const adminCount = parseInt(data.admin_count);
    const regularUserCount = parseInt(data.regular_user_count);

    const usersWithMfa = parseInt(data.users_with_mfa);
    const adminsWithMfa = parseInt(data.admins_with_mfa);
    const regularUsersWithMfa = parseInt(data.regular_users_with_mfa);

    // Calculer les pourcentages pour tous les utilisateurs
    const userMfaPercentage = totalUsers > 0 ? Math.round((usersWithMfa / totalUsers) * 100) : 0;
    const adminMfaPercentage = adminCount > 0 ? Math.round((adminsWithMfa / adminCount) * 100) : 0;
    const regularUserMfaPercentage = regularUserCount > 0 ? Math.round((regularUsersWithMfa / regularUserCount) * 100) : 0;

    // Calculer les pourcentages pour les méthodes MFA (par rapport au total des utilisateurs)
    const emailMfaPercentage = totalUsers > 0 ? Math.round((parseInt(data.email_mfa_count) / totalUsers) * 100) : 0;
    const softwareMfaPercentage = totalUsers > 0 ? Math.round((parseInt(data.software_mfa_count) / totalUsers) * 100) : 0;
    const phoneMfaPercentage = totalUsers > 0 ? Math.round((parseInt(data.phone_mfa_count) / totalUsers) * 100) : 0;
    const authenticatorMfaPercentage = totalUsers > 0 ? Math.round((parseInt(data.authenticator_mfa_count) / totalUsers) * 100) : 0;

    res.json({
      success: true,
      stats: {
        admin_count: adminCount,
        user_count: totalUsers, // Total incluant admins et utilisateurs
        admin_mfa_count: adminsWithMfa,
        user_mfa_count: usersWithMfa, // Tous les utilisateurs avec MFA
        admin_mfa_percentage: adminMfaPercentage,
        user_mfa_percentage: userMfaPercentage, // Pourcentage MFA sur tous les utilisateurs
        regular_user_count: regularUserCount, // Utilisateurs réguliers (non-admins)
        regular_user_mfa_count: regularUsersWithMfa, // Utilisateurs réguliers avec MFA
        regular_user_mfa_percentage: regularUserMfaPercentage, // Pourcentage MFA sur utilisateurs réguliers
        email_mfa_count: parseInt(data.email_mfa_count),
        software_mfa_count: parseInt(data.software_mfa_count),
        phone_mfa_count: parseInt(data.phone_mfa_count),
        authenticator_mfa_count: parseInt(data.authenticator_mfa_count),
        email_mfa_percentage: emailMfaPercentage,
        software_mfa_percentage: softwareMfaPercentage,
        phone_mfa_percentage: phoneMfaPercentage,
        authenticator_mfa_percentage: authenticatorMfaPercentage,
        last_sync: data.last_sync
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des statistiques"
    });
  }
});

/**
 * GET /api/office365/mfa-details/:clientId
 * Récupère les détails MFA de tous les utilisateurs du tenant
 */
router.get("/mfa-details/:clientId", verifyJWT, async (req, res) => {
  try {
    const { clientId } = req.params;

    // Récupérer les détails MFA depuis la base de données
    const result = await pool.query(`
      SELECT
        user_id as id,
        display_name,
        user_principal_name,
        account_enabled,
        has_mfa,
        mfa_methods,
        latest_mfa_registration_date,
        is_admin,
        admin_role,
        last_sync
      FROM v_b_clients_c_azure_mfa
      WHERE client_id = $1
      ORDER BY display_name ASC
    `, [clientId]);

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        userMfaDetails: [],
        message: "Aucun détail MFA sauvegardé pour ce client"
      });
    }

    // Transformer les données pour maintenir la compatibilité avec l'ancien format
    const userMfaDetails = result.rows.map(row => ({
      id: row.id,
      displayName: row.display_name,
      userPrincipalName: row.user_principal_name,
      accountEnabled: row.account_enabled,
      hasMFA: row.has_mfa,
      mfaMethods: row.mfa_methods || [],
      latestMfaRegistrationDate: row.latest_mfa_registration_date,
      is_admin: row.is_admin,
      admin_role: row.admin_role || null
    }));

    res.json({
      success: true,
      userMfaDetails: userMfaDetails
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des détails MFA"
    });
  }
});

/**
 * Fonction helper pour récupérer les données principales (licences, users, adoptionScore)
 * Réutilise la logique de la route /data
 */
async function fetchOffice365DataInternal(clientId, credentials) {
  try {
    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Récupérer les licences, utilisateurs, rapport d'activité et sign-ins (fallback pour lastLoginDate)
    const [subscribedSkus, usersData, activeUsersReport, signInsData] = await Promise.all([
      callMicrosoftGraph("/subscribedSkus", accessToken),
      callMicrosoftGraph("/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department,assignedLicenses,signInActivity,accountEnabled,createdDateTime", accessToken, { getAllPages: true }).catch(err => {
        return callMicrosoftGraph("/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department,assignedLicenses,accountEnabled,createdDateTime", accessToken, { getAllPages: true });
      }),
      callMicrosoftGraph("/reports/getOffice365ActiveUserDetail(period='D90')", accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph("/auditLogs/signIns?$top=2000&$orderby=createdDateTime desc", accessToken).catch(() => null)
    ]);

    // Créer un mapping des SKU IDs vers les noms de licences
    const skuIdToName = {};
    subscribedSkus.value.forEach(sku => {
      skuIdToName[sku.skuId] = sku.skuPartNumber || sku.displayName || "Licence inconnue";
    });

    // Transformer les licences
    const licences = subscribedSkus.value
      .filter(sku => {
        const total = sku.prepaidUnits?.enabled || 0;
        return total < 10000 && total > 0;
      })
      .map(sku => {
        const consumed = sku.consumedUnits || 0;
        const total = sku.prepaidUnits?.enabled || 0;
        const available = Math.max(0, total - consumed);

        return {
          nom: sku.skuPartNumber || sku.displayName || "Licence inconnue",
          total: total,
          utilisees: consumed,
          disponibles: available,
          skuId: sku.skuId,
          displayName: sku.displayName,
          servicePlans: sku.servicePlans || []
        };
      });

    // Créer un mapping des emails/UPN vers la date de dernière connexion (rapport Office 365)
    const emailToLastLogin = {};
    const reportUpnKeys = ['User Principal Name', 'UserPrincipalName', 'User'];
    const reportDateKeys = ['Last Activity Date (UTC)', 'Last Activity Date', 'LastActivityDate'];
    const reportOtherDateKeys = ['Report Refresh Date', 'Exchange Last Activity Date', 'SharePoint Last Activity Date', 'OneDrive Last Activity Date', 'Teams Last Activity Date', 'Yammer Last Activity Date', 'Skype For Business Last Activity Date'];
    if (activeUsersReport && activeUsersReport.value) {
      activeUsersReport.value.forEach(row => {
        const email = (getReportRowValue(row, reportUpnKeys) || '').toString().trim();
        if (!email) return;
        let lastActivity = getReportRowValue(row, reportDateKeys);
        if (lastActivity != null && typeof lastActivity === 'string') lastActivity = lastActivity.trim();
        for (const key of reportOtherDateKeys) {
          const val = row[key];
          if (val) {
            const d = new Date(val);
            if (!isNaN(d.getTime())) {
              const current = lastActivity ? new Date(lastActivity) : null;
              if (!current || d > current) lastActivity = val;
            }
          }
        }
        if (email && lastActivity) {
          emailToLastLogin[email.toLowerCase()] = lastActivity;
        }
      });
    }

    // Fallback : dernière connexion depuis auditLogs/signIns (connexions réussies, ordre date desc = plus récent en premier)
    const signInToLastLogin = {};
    if (signInsData && signInsData.value && Array.isArray(signInsData.value)) {
      signInsData.value.forEach(signIn => {
        const isSuccess = signIn.status && signIn.status.errorCode === 0;
        if (!isSuccess) return;
        const upn = (signIn.userPrincipalName || signIn.userId || '').toString().trim();
        const dt = signIn.createdDateTime;
        if (!upn || !dt) return;
        if (!signInToLastLogin[upn.toLowerCase()]) {
          signInToLastLogin[upn.toLowerCase()] = dt;
        }
      });
    }

    // Transformer les utilisateurs (garder lastLoginDate systématiquement)
    const usersList = Array.isArray(usersData?.value) ? usersData.value : [];
    const users = usersList.map(user => {
      const licenseNames = user.assignedLicenses
        ?.map(license => skuIdToName[license.skuId] || license.skuId)
        .filter(Boolean)
        .join(", ") || "";

      let lastLoginDate = null;
      if (user.signInActivity && user.signInActivity.lastSignInDateTime) {
        lastLoginDate = user.signInActivity.lastSignInDateTime;
      }
      if (lastLoginDate == null || lastLoginDate === '') {
        const userEmail = (user.mail || user.userPrincipalName || '').toString().toLowerCase().trim();
        const upn = (user.userPrincipalName || '').toString().toLowerCase().trim();
        lastLoginDate = emailToLastLogin[userEmail] || emailToLastLogin[upn] || signInToLastLogin[userEmail] || signInToLastLogin[upn];
      }
      // Normaliser en chaîne ISO ou null pour le frontend
      if (lastLoginDate != null && lastLoginDate !== '') {
        const d = new Date(lastLoginDate);
        lastLoginDate = !isNaN(d.getTime()) ? d.toISOString() : null;
      } else {
        lastLoginDate = null;
      }

      const name = user.displayName || user.userPrincipalName || "Utilisateur sans nom";
      const email = user.mail || user.userPrincipalName || "";
      const isServiceAccount = isLikelyServiceAccount(user.displayName, user.userPrincipalName, user.mail);

      return {
        name,
        email,
        department: user.department || "",
        title: user.jobTitle || "",
        licenses: licenseNames,
        userPrincipalName: user.userPrincipalName,
        lastLoginDate,
        accountEnabled: user.accountEnabled !== false,
        createdDate: user.createdDateTime || null,
        isServiceAccount: !!isServiceAccount
      };
    });

    // Traiter le score d'adoption
    let adoptionScoreData = null;
    // Note: Le score d'adoption nécessite une API spécifique qui peut ne pas être disponible

    return {
      success: true,
      licences: licences,
      users: users,
      adoptionScore: adoptionScoreData,
      lastUpdate: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Erreur lors de la récupération des données"
    };
  }
}

/**
 * Fonction helper pour récupérer les données Exchange complètes
 * Réutilise toute la logique de la route /exchange
 */
async function fetchExchangeDataInternal(accessToken, startDate, endDate, period = 'D90') {
  try {
    const [emailActivity, emailAppUsage, mailboxUsage, emailActivityUserDetail, activeUsersReport, usersWithMailboxSettings] = await Promise.all([
      callMicrosoftGraph(`/reports/getEmailActivityCounts(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getEmailAppUsageUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getMailboxUsageDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getEmailActivityUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getOffice365ActiveUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph("/users?$select=id,displayName,mail,userPrincipalName", accessToken, { getAllPages: true }).catch(() => null)
    ]);

    let totalSent = 0;
    let totalReceived = 0;
    let totalRead = 0;
    let totalMailboxSize = 0;
    let totalMailboxes = 0;
    let dailyActivity = [];
    let totalItemCount = 0;
    const mailboxQuotas = [];

    if (emailActivity && emailActivity.value) {
      emailActivity.value.forEach(day => {
        const sent = parseInt(day.Send || day.send || day['Send Count'] || 0);
        const received = parseInt(day.Receive || day.receive || day['Receive Count'] || 0);
        const read = parseInt(day.Read || day.read || day['Read Count'] || 0);
        const date = day.ReportDate || day['Report Date'] || day.reportDate || day.date || '';
        const dayDate = new Date(date);
        
        if (startDate && endDate) {
          const dayDateOnly = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate());
          const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
          const endDateOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
          if (dayDateOnly >= startDateOnly && dayDateOnly <= endDateOnly) {
            totalSent += sent;
            totalReceived += received;
            totalRead += read;
          }
        } else {
          totalSent += sent;
          totalReceived += received;
          totalRead += read;
        }
        // Graphique : toutes les dates disponibles (pas de filtre)
        dailyActivity.push({ date, sent, received, read });
      });
      
      dailyActivity.sort((a, b) => {
        const dateA = new Date(a.date);
        const dateB = new Date(b.date);
        return dateA - dateB;
      });
    }

    const userQuotaMap = new Map();
    if (usersWithMailboxSettings && usersWithMailboxSettings.value) {
      usersWithMailboxSettings.value.forEach(user => {
        if (user.mailboxSettings && user.userPrincipalName) {
          const emailKey = user.userPrincipalName.toLowerCase();
          const quota = user.mailboxSettings.prohibitSendReceiveQuota || 
                       user.mailboxSettings.storageQuota || 
                       user.mailboxSettings.issueWarningQuota || 
                       null;
          userQuotaMap.set(emailKey, {
            displayName: user.displayName || user.mail || user.userPrincipalName.split('@')[0],
            email: user.userPrincipalName,
            quota: quota ? parseInt(quota) : null
          });
        }
      });
    }
    
    if (mailboxUsage && mailboxUsage.value) {
      mailboxUsage.value.forEach(mailbox => {
        const storageUsed = parseInt(
          mailbox['Storage Used (Byte)'] || 
          mailbox['Storage Used'] || 
          mailbox.storageUsedInBytes || 
          mailbox['StorageUsed'] ||
          mailbox['StorageUsedInBytes'] ||
          0
        );
        
        let storageQuota = parseInt(
          mailbox['Storage Quota (Byte)'] ||
          mailbox['Storage Quota'] ||
          mailbox.storageQuotaInBytes ||
          mailbox['StorageQuota'] ||
          mailbox['StorageQuotaInBytes'] ||
          0
        );
        
        const itemCount = parseInt(
          mailbox['Item Count'] || 
          mailbox.itemCount || 
          mailbox['ItemCount'] ||
          0
        );
        
        const userPrincipalName = mailbox['User Principal Name'] || 
                                  mailbox['UserPrincipalName'] || 
                                  mailbox.userPrincipalName || 
                                  'Inconnu';
        
        const emailKey = userPrincipalName.toLowerCase();
        const userInfo = userQuotaMap.get(emailKey);
        
        const displayName = userInfo?.displayName || 
                           mailbox['Display Name'] || 
                           mailbox['DisplayName'] || 
                           mailbox.displayName || 
                           userPrincipalName.split('@')[0];
        
        if (storageQuota === 0 && userInfo?.quota) {
          storageQuota = userInfo.quota;
        }
        
        totalMailboxes++;
        totalMailboxSize += storageUsed;
        totalItemCount += itemCount;
        
        mailboxQuotas.push({
          displayName: displayName,
          user: displayName,
          email: userInfo?.email || userPrincipalName,
          storageUsed: storageUsed,
          storageQuota: storageQuota,
          usagePercent: storageQuota > 0 ? Math.round((storageUsed / storageQuota) * 100) : 0,
          quotaPercent: storageQuota > 0 ? Math.round((storageUsed / storageQuota) * 100) : 0,
          itemCount: itemCount
        });
      });
    }
    
    const daysCount = dailyActivity.length || 1;
    const avgSent = Math.round(totalSent / daysCount);
    const avgReceived = Math.round(totalReceived / daysCount);
    const avgRead = Math.round(totalRead / daysCount);
    const readRate = totalReceived > 0 ? ((totalRead / totalReceived) * 100).toFixed(1) : 0;
    const averageMailboxSize = totalMailboxes > 0 ? Math.round(totalMailboxSize / totalMailboxes) : 0;
    const averageItemCount = totalMailboxes > 0 ? Math.round(totalItemCount / totalMailboxes) : 0;

    const weeklyStats = {
      monday: { sent: 0, received: 0, read: 0, count: 0 },
      tuesday: { sent: 0, received: 0, read: 0, count: 0 },
      wednesday: { sent: 0, received: 0, read: 0, count: 0 },
      thursday: { sent: 0, received: 0, read: 0, count: 0 },
      friday: { sent: 0, received: 0, read: 0, count: 0 },
      saturday: { sent: 0, received: 0, read: 0, count: 0 },
      sunday: { sent: 0, received: 0, read: 0, count: 0 }
    };

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    
    if (dailyActivity && dailyActivity.length > 0) {
      dailyActivity.forEach(day => {
        const date = new Date(day.date);
        if (!isNaN(date.getTime())) {
          const dayOfWeek = dayNames[date.getDay()];
          if (weeklyStats[dayOfWeek]) {
            weeklyStats[dayOfWeek].sent += day.sent || 0;
            weeklyStats[dayOfWeek].received += day.received || 0;
            weeklyStats[dayOfWeek].read += day.read || 0;
            weeklyStats[dayOfWeek].count++;
          }
        }
      });
    }

    const weeklyStatsFormatted = {
      lundi: {
        sent: weeklyStats.monday.count > 0 ? Math.round(weeklyStats.monday.sent / weeklyStats.monday.count) : 0,
        received: weeklyStats.monday.count > 0 ? Math.round(weeklyStats.monday.received / weeklyStats.monday.count) : 0,
        read: weeklyStats.monday.count > 0 ? Math.round(weeklyStats.monday.read / weeklyStats.monday.count) : 0
      },
      mardi: {
        sent: weeklyStats.tuesday.count > 0 ? Math.round(weeklyStats.tuesday.sent / weeklyStats.tuesday.count) : 0,
        received: weeklyStats.tuesday.count > 0 ? Math.round(weeklyStats.tuesday.received / weeklyStats.tuesday.count) : 0,
        read: weeklyStats.tuesday.count > 0 ? Math.round(weeklyStats.tuesday.read / weeklyStats.tuesday.count) : 0
      },
      mercredi: {
        sent: weeklyStats.wednesday.count > 0 ? Math.round(weeklyStats.wednesday.sent / weeklyStats.wednesday.count) : 0,
        received: weeklyStats.wednesday.count > 0 ? Math.round(weeklyStats.wednesday.received / weeklyStats.wednesday.count) : 0,
        read: weeklyStats.wednesday.count > 0 ? Math.round(weeklyStats.wednesday.read / weeklyStats.wednesday.count) : 0
      },
      jeudi: {
        sent: weeklyStats.thursday.count > 0 ? Math.round(weeklyStats.thursday.sent / weeklyStats.thursday.count) : 0,
        received: weeklyStats.thursday.count > 0 ? Math.round(weeklyStats.thursday.received / weeklyStats.thursday.count) : 0,
        read: weeklyStats.thursday.count > 0 ? Math.round(weeklyStats.thursday.read / weeklyStats.thursday.count) : 0
      },
      vendredi: {
        sent: weeklyStats.friday.count > 0 ? Math.round(weeklyStats.friday.sent / weeklyStats.friday.count) : 0,
        received: weeklyStats.friday.count > 0 ? Math.round(weeklyStats.friday.received / weeklyStats.friday.count) : 0,
        read: weeklyStats.friday.count > 0 ? Math.round(weeklyStats.friday.read / weeklyStats.friday.count) : 0
      },
      samedi: {
        sent: weeklyStats.saturday.count > 0 ? Math.round(weeklyStats.saturday.sent / weeklyStats.saturday.count) : 0,
        received: weeklyStats.saturday.count > 0 ? Math.round(weeklyStats.saturday.received / weeklyStats.saturday.count) : 0,
        read: weeklyStats.saturday.count > 0 ? Math.round(weeklyStats.saturday.read / weeklyStats.saturday.count) : 0
      },
      dimanche: {
        sent: weeklyStats.sunday.count > 0 ? Math.round(weeklyStats.sunday.sent / weeklyStats.sunday.count) : 0,
        received: weeklyStats.sunday.count > 0 ? Math.round(weeklyStats.sunday.received / weeklyStats.sunday.count) : 0,
        read: weeklyStats.sunday.count > 0 ? Math.round(weeklyStats.sunday.read / weeklyStats.sunday.count) : 0
      }
    };

    let topUsers = [];
    let allUsersMap = new Map();
    if (usersWithMailboxSettings && usersWithMailboxSettings.value) {
      usersWithMailboxSettings.value.forEach(u => {
        const emailKey = (u.userPrincipalName || u.mail || '').toLowerCase();
        if (emailKey) {
          allUsersMap.set(emailKey, {
            displayName: u.displayName || u.mail || u.userPrincipalName,
            userPrincipalName: u.userPrincipalName || u.mail
          });
        }
      });
    }
    
    if (emailActivityUserDetail && emailActivityUserDetail.value) {
      const userMap = new Map();
      
      emailActivityUserDetail.value.forEach(user => {
        const identifier = user['User Principal Name'] || user['UserPrincipalName'] || user.userPrincipalName || '';
        const displayName = user['Display Name'] || user['DisplayName'] || user.displayName || '';
        const sent = parseInt(user['Send Count'] || user['Send'] || user.send || user.sendCount || 0);
        const received = parseInt(user['Receive Count'] || user['Receive'] || user.receive || user.receiveCount || 0);
        const read = parseInt(user['Read Count'] || user['Read'] || user.read || user.readCount || 0);
        
        const isHashedId = /^[0-9A-F]{32,}$/i.test(identifier);
        
        if (isHashedId) {
          let mappedUser = null;
          if (activeUsersReport && activeUsersReport.value) {
            const matched = activeUsersReport.value.find(activeUser => {
              const activeUserId = activeUser['User Id'] || activeUser['UserId'] || '';
              return activeUserId === identifier || activeUserId.toLowerCase() === identifier.toLowerCase();
            });
            if (matched) {
              const matchedEmail = matched['User Principal Name'] || matched['UserPrincipalName'] || '';
              if (matchedEmail && matchedEmail.includes('@')) {
                const userInfo = allUsersMap.get(matchedEmail.toLowerCase());
                if (userInfo) {
                  mappedUser = userInfo;
                }
              }
            }
          }
          
          if (!userMap.has(identifier)) {
            userMap.set(identifier, {
              displayName: mappedUser?.displayName || displayName || `Utilisateur ${identifier.substring(0, 8)}...`,
              userPrincipalName: mappedUser?.userPrincipalName || identifier,
              email: mappedUser?.userPrincipalName || identifier,
              sent: 0,
              received: 0,
              read: 0,
              total: 0
            });
          }
          
          const userStat = userMap.get(identifier);
          userStat.sent += sent;
          userStat.received += received;
          userStat.read += read;
          userStat.total = userStat.sent + userStat.received;
        } else if (identifier.includes('@')) {
          const emailKey = identifier.toLowerCase();
          if (!userMap.has(emailKey)) {
            const userInfo = allUsersMap.get(emailKey) || {
              displayName: displayName || emailKey.split('@')[0],
              userPrincipalName: identifier
            };
            
            userMap.set(emailKey, {
              displayName: userInfo.displayName,
              userPrincipalName: userInfo.userPrincipalName,
              email: identifier,
              sent: 0,
              received: 0,
              read: 0,
              total: 0
            });
          }
          
          const userStat = userMap.get(emailKey);
          userStat.sent += sent;
          userStat.received += received;
          userStat.read += read;
          userStat.total = userStat.sent + userStat.received;
        }
      });
      
      topUsers = Array.from(userMap.values())
        .filter(user => user.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 5)
        .map(user => ({
          name: user.displayName || user.email.split('@')[0] || user.email,
          email: user.userPrincipalName || user.email,
          sent: user.sent,
          received: user.received,
          read: user.read,
          total: user.total
        }));
    }

    mailboxQuotas.sort((a, b) => b.storageUsed - a.storageUsed);

    return {
      success: true,
      emailActivity: {
        sent: totalSent,
        received: totalReceived,
        read: totalRead,
        period: period,
        dailyActivity: dailyActivity,
        averages: {
          sent: avgSent,
          received: avgReceived,
          read: avgRead
        },
        readRate: parseFloat(readRate),
        weeklyStats: weeklyStatsFormatted
      },
      mailboxes: {
        total: totalMailboxes,
        totalSize: formatBytes(totalMailboxSize),
        averageSize: formatBytes(averageMailboxSize),
        totalItems: totalItemCount,
        averageItems: averageItemCount,
        quotas: mailboxQuotas
      },
      appUsage: emailAppUsage || null,
      topUsers: topUsers,
      lastUpdate: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Erreur lors de la récupération des données Exchange"
    };
  }
}

/**
 * Fonction helper pour récupérer les données Teams complètes
 * Réutilise toute la logique de la route /teams
 */
async function fetchTeamsDataInternal(accessToken, startDate, endDate, period = 'D90') {
  try {
    const parseNumber = (value) => {
      if (value === null || value === undefined) return 0;
      if (typeof value === "number") {
        return isNaN(value) ? 0 : value;
      }
      if (typeof value === "string") {
        const cleaned = value.replace(/,/g, "").trim();
        if (cleaned === "") return 0;
        const parsed = parseFloat(cleaned);
        return isNaN(parsed) ? 0 : parsed;
      }
      return 0;
    };

    const normalizeBoolean = (value) => {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        return normalized === "true" || normalized === "yes" || normalized === "1";
      }
      if (typeof value === "number") return value === 1;
      return false;
    };

    const getDateKey = (value) => {
      if (!value) return null;
      try {
        const date = new Date(value);
        if (isNaN(date.getTime())) return null;
        return date.toISOString().split("T")[0];
      } catch {
        return null;
      }
    };
    
    const [teams, teamsActivity, teamsDeviceUsage, callRecords] = await Promise.all([
      callMicrosoftGraph("/teams", accessToken, { getAllPages: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getTeamsUserActivityUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getTeamsDeviceUsageUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph("/communications/callRecords", accessToken, { getAllPages: true }).catch(() => null)
    ]);
    
    let totalTeams = 0;
    let activeUsers = new Set();
    let totalMessages = 0;
    let totalMeetings = 0;
    let totalCalls = 0;
    let totalCallDuration = 0;
    let teamChatMessages = 0;
    let privateChatMessages = 0;
    let urgentMessages = 0;
    let postMessages = 0;
    let replyMessages = 0;
    let meetingsOrganized = 0;
    let meetingsAttended = 0;
    let adHocMeetingsOrganized = 0;
    let adHocMeetingsAttended = 0;
    let scheduledOneTimeOrganized = 0;
    let scheduledOneTimeAttended = 0;
    let scheduledRecurringOrganized = 0;
    let scheduledRecurringAttended = 0;
    let callCountFromActivity = 0;
    let callDurationFromActivity = 0;
    let audioDurationSeconds = 0;
    let videoDurationSeconds = 0;
    let screenShareDurationSeconds = 0;
    let hasOtherActionCount = 0;
    let licensedUsers = 0;
    let deletedUsers = 0;
    let reportPeriod = null;
    let reportRefreshDate = null;
    const dailyActivityMap = new Map();

    if (teams && teams.value) {
      totalTeams = teams.value.length;
    }

    const teamMemberCounts = new Map();
    const teamChannelCounts = new Map();
    if (teams && teams.value && teams.value.length > 0) {
      const teamsForCounts = teams.value.slice(0, 50);
      try {
        await Promise.all(
          teamsForCounts.map(async (team) => {
            try {
              const [members, channels] = await Promise.all([
                callMicrosoftGraph(`/teams/${team.id}/members`, accessToken, { getAllPages: true }).catch(() => null),
                callMicrosoftGraph(`/teams/${team.id}/channels`, accessToken, { getAllPages: true }).catch(() => null)
              ]);
              teamMemberCounts.set(team.id, Array.isArray(members?.value) ? members.value.length : 0);
              teamChannelCounts.set(team.id, Array.isArray(channels?.value) ? channels.value.length : 0);
            } catch {
              teamMemberCounts.set(team.id, 0);
              teamChannelCounts.set(team.id, 0);
            }
          })
        );
      } catch {
        // En cas d'erreur globale (ex. rate limit), laisser les maps vides → comptes à 0
      }
    }

    if (teamsActivity && teamsActivity.value) {
      if (teamsActivity.value.length > 0) {
        reportRefreshDate = teamsActivity.value[0]['Report Refresh Date'] || teamsActivity.value[0]['ReportRefreshDate'] || null;
        reportPeriod = teamsActivity.value[0]['Report Period'] || teamsActivity.value[0]['ReportPeriod'] || null;
      }

      teamsActivity.value.forEach(user => {
        const userPrincipalName = user['User Principal Name'] || user['UserPrincipalName'] || user.userPrincipalName || user['User'] || user['User Name'] || '';
        const lastActivityDate = user['Last Activity Date'] || user['LastActivityDate'] || user.lastActivityDate || null;
        const dateKey = getDateKey(lastActivityDate);
        const isLicensed = normalizeBoolean(user['Is Licensed'] || user['IsLicensed'] || user.isLicensed);
        const isDeleted = normalizeBoolean(user['Is Deleted'] || user['IsDeleted'] || user.isDeleted);
        const hasOtherAction = normalizeBoolean(user['Has Other Action'] || user['HasOtherAction'] || user.hasOtherAction);
        if (isLicensed) licensedUsers++;
        if (isDeleted) deletedUsers++;
        if (hasOtherAction) hasOtherActionCount++;
        
        let matchesMonitoringPeriod = true;
        if (startDate && endDate) {
          if (!lastActivityDate || lastActivityDate === '') {
            matchesMonitoringPeriod = false;
          } else {
            try {
              const activityDate = new Date(lastActivityDate);
              matchesMonitoringPeriod = activityDate >= startDate && activityDate <= endDate;
            } catch {
              matchesMonitoringPeriod = false;
            }
          }
        }
        
        const teamChatMessageCount = parseNumber(
          user['Team Chat Message Count'] || 
          user['TeamChatMessageCount'] || 
          user['Team Chat Messages'] ||
          user['TeamChatMessages'] ||
          user.teamChatMessageCount || 
          user.teamChatMessages ||
          user['Team Chat'] ||
          user['TeamChat']
        );
        
        const privateChatMessageCount = parseNumber(
          user['Private Chat Message Count'] ||
          user['PrivateChatMessageCount'] ||
          user['Private Chat Messages'] ||
          user['PrivateChatMessages'] ||
          user.privateChatMessageCount ||
          user.privateChatMessages ||
          user['Private Chat'] ||
          user['PrivateChat']
        );
        
        const meetingCount = parseNumber(
          user['Meeting Count'] || 
          user['MeetingCount'] || 
          user['Meetings'] ||
          user.meetingCount || 
          user.meetings ||
          user['Total Meetings'] ||
          user['TotalMeetings'] ||
          user['Meeting']
        );
        
        const meetingsOrganizedCount = parseNumber(
          user['Meetings Organized Count'] ||
          user['MeetingsOrganizedCount'] ||
          user['Meetings Organized'] ||
          user.meetingsOrganized ||
          user['Organized Meetings']
        );
        
        const meetingsAttendedCount = parseNumber(
          user['Meetings Attended Count'] ||
          user['MeetingsAttendedCount'] ||
          user['Meetings Attended'] ||
          user.meetingsAttended ||
          user['Attended Meetings']
        );
        
        const adHocMeetingsOrganizedCount = parseNumber(
          user['Ad Hoc Meetings Organized Count'] ||
          user['AdHocMeetingsOrganizedCount'] ||
          user['Ad Hoc Meetings Organized'] ||
          user['AdHocMeetingsOrganized'] ||
          user.adHocMeetingsOrganized
        );
        
        const adHocMeetingsAttendedCount = parseNumber(
          user['Ad Hoc Meetings Attended Count'] ||
          user['AdHocMeetingsAttendedCount'] ||
          user['Ad Hoc Meetings Attended'] ||
          user['AdHocMeetingsAttended'] ||
          user.adHocMeetingsAttended
        );
        
        const scheduledOneTimeOrganizedCount = parseNumber(
          user['Scheduled One-time Meetings Organized Count'] ||
          user['Scheduled One-time Meetings Organized'] ||
          user['ScheduledOnetimeMeetingsOrganizedCount'] ||
          user['ScheduledOneTimeMeetingsOrganized'] ||
          user.scheduledOneTimeMeetingsOrganized
        );
        
        const scheduledOneTimeAttendedCount = parseNumber(
          user['Scheduled One-time Meetings Attended Count'] ||
          user['Scheduled One-time Meetings Attended'] ||
          user['ScheduledOnetimeMeetingsAttendedCount'] ||
          user['ScheduledOneTimeMeetingsAttended'] ||
          user.scheduledOneTimeMeetingsAttended
        );
        
        const scheduledRecurringOrganizedCount = parseNumber(
          user['Scheduled Recurring Meetings Organized Count'] ||
          user['Scheduled Recurring Meetings Organized'] ||
          user['ScheduledRecurringMeetingsOrganizedCount'] ||
          user['ScheduledRecurringMeetingsOrganized'] ||
          user.scheduledRecurringMeetingsOrganized
        );
        
        const scheduledRecurringAttendedCount = parseNumber(
          user['Scheduled Recurring Meetings Attended Count'] ||
          user['Scheduled Recurring Meetings Attended'] ||
          user['ScheduledRecurringMeetingsAttendedCount'] ||
          user['ScheduledRecurringMeetingsAttended'] ||
          user.scheduledRecurringMeetingsAttended
        );
        
        const urgentMessagesCount = parseNumber(
          user['Urgent Messages'] ||
          user['UrgentMessages'] ||
          user.urgentMessages
        );
        
        const postMessagesCount = parseNumber(
          user['Post Messages'] ||
          user['PostMessages'] ||
          user.postMessages
        );
        
        const replyMessagesCount = parseNumber(
          user['Reply Messages'] ||
          user['ReplyMessages'] ||
          user.replyMessages
        );
        
        const callCount = parseNumber(
          user['Call Count'] || 
          user['Calls'] ||
          user['Total Calls'] ||
          user['CallCount'] ||
          user.callCount
        );
        
        const audioDuration = parseNumber(
          user['Audio Duration In Seconds'] ||
          user['Audio Duration'] ||
          user['AudioDurationInSeconds'] ||
          user.audioDurationInSeconds
        );
        
        const videoDuration = parseNumber(
          user['Video Duration In Seconds'] ||
          user['Video Duration'] ||
          user['VideoDurationInSeconds'] ||
          user.videoDurationInSeconds
        );
        
        const screenShareDuration = parseNumber(
          user['Screen Share Duration In Seconds'] ||
          user['Screen Share Duration'] ||
          user['ScreenShareDurationInSeconds'] ||
          user.screenShareDurationInSeconds
        );
        
        if (dateKey) {
          if (!dailyActivityMap.has(dateKey)) {
            dailyActivityMap.set(dateKey, {
              date: dateKey,
              channelMessages: 0,
              chatMessages: 0,
              oneOnOneCalls: 0,
              totalMeetings: 0
            });
          }
          const dailyEntry = dailyActivityMap.get(dateKey);
          dailyEntry.channelMessages += teamChatMessageCount;
          dailyEntry.chatMessages += privateChatMessageCount;
          dailyEntry.oneOnOneCalls += callCount;
          dailyEntry.totalMeetings += meetingCount;
        }

        if (!matchesMonitoringPeriod) {
          return;
        }

        teamChatMessages += teamChatMessageCount;
        privateChatMessages += privateChatMessageCount;
        urgentMessages += urgentMessagesCount;
        postMessages += postMessagesCount;
        replyMessages += replyMessagesCount;
        totalMessages += teamChatMessageCount + privateChatMessageCount;
        totalMeetings += meetingCount;
        meetingsOrganized += meetingsOrganizedCount;
        meetingsAttended += meetingsAttendedCount;
        adHocMeetingsOrganized += adHocMeetingsOrganizedCount;
        adHocMeetingsAttended += adHocMeetingsAttendedCount;
        scheduledOneTimeOrganized += scheduledOneTimeOrganizedCount;
        scheduledOneTimeAttended += scheduledOneTimeAttendedCount;
        scheduledRecurringOrganized += scheduledRecurringOrganizedCount;
        scheduledRecurringAttended += scheduledRecurringAttendedCount;
        callCountFromActivity += callCount;
        audioDurationSeconds += audioDuration;
        videoDurationSeconds += videoDuration;
        screenShareDurationSeconds += screenShareDuration;
        callDurationFromActivity += audioDuration + videoDuration + screenShareDuration;
        
        if (teamChatMessageCount > 0 || privateChatMessageCount > 0 || meetingCount > 0 || callCount > 0) {
          if (userPrincipalName) {
            activeUsers.add(userPrincipalName);
          }
        }
      });
    }

    if (callRecords && callRecords.value && callRecords.value.length > 0) {
      let filteredCalls = callRecords.value;
      if (startDate && endDate) {
        filteredCalls = callRecords.value.filter(call => {
          const callStartDate = call.startDateTime || call.startDate;
          if (!callStartDate) return false;
          
          try {
            const callDate = new Date(callStartDate);
            return callDate >= startDate && callDate <= endDate;
          } catch {
            return false;
          }
        });
      }
      
      totalCalls = filteredCalls.length;
      filteredCalls.forEach(call => {
        let callDurationSeconds = 0;
        
        if (call.startDateTime && call.endDateTime) {
          try {
            const startDate = new Date(call.startDateTime);
            const endDate = new Date(call.endDateTime);
            if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime()) && endDate > startDate) {
              callDurationSeconds = Math.floor((endDate - startDate) / 1000);
            }
          } catch (e) {
          }
        }
        
        if (callDurationSeconds === 0) {
          const duration = call.duration || call.callDuration || call.durationInSeconds || call.callDurationInSeconds || 0;
          if (typeof duration === 'string' && duration.startsWith('PT')) {
            const hoursMatch = duration.match(/(\d+)H/);
            const minutesMatch = duration.match(/(\d+)M/);
            const secondsMatch = duration.match(/(\d+)S/);
            const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;
            const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
            const seconds = secondsMatch ? parseInt(secondsMatch[1]) : 0;
            callDurationSeconds = (hours * 3600) + (minutes * 60) + seconds;
          } else {
            callDurationSeconds = parseInt(duration || 0);
          }
        }
        
        totalCallDuration += callDurationSeconds;
      });
    }

    const effectiveCallCount = totalCalls > 0 ? totalCalls : callCountFromActivity;
    const effectiveCallDuration = totalCallDuration > 0 ? totalCallDuration : callDurationFromActivity;

    const formatDuration = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    };

    const callsStats = {
      total: effectiveCallCount,
      totalDuration: formatDuration(effectiveCallDuration),
      averageDuration: effectiveCallCount > 0 ? formatDuration(Math.floor(effectiveCallDuration / effectiveCallCount)) : "0h 0m",
      audioDuration: formatDuration(audioDurationSeconds),
      videoDuration: formatDuration(videoDurationSeconds),
      screenShareDuration: formatDuration(screenShareDurationSeconds),
      totalDurationSeconds: effectiveCallDuration,
      audioDurationSeconds,
      videoDurationSeconds,
      screenShareDurationSeconds
    };

    let dailyActivity = Array.from(dailyActivityMap.values()).sort((a, b) => new Date(a.date) - new Date(b.date));
    // Graphique : toutes les dates (pas de filtre)

    const messagesStats = {
      total: teamChatMessages + privateChatMessages,
      teamChat: teamChatMessages,
      privateChat: privateChatMessages,
      urgent: urgentMessages,
      posts: postMessages,
      replies: replyMessages
    };

    const meetingsStats = {
      total: totalMeetings,
      organized: meetingsOrganized,
      attended: meetingsAttended,
      adHoc: {
        organized: adHocMeetingsOrganized,
        attended: adHocMeetingsAttended
      },
      scheduledOneTime: {
        organized: scheduledOneTimeOrganized,
        attended: scheduledOneTimeAttended
      },
      scheduledRecurring: {
        organized: scheduledRecurringOrganized,
        attended: scheduledRecurringAttended
      }
    };

    const usageStats = {
      activeUsers: activeUsers.size,
      licensedUsers,
      deletedUsers,
      otherActions: hasOtherActionCount,
      reportPeriod,
      reportRefreshDate
    };

    const activityStats = {
      totalMessages: messagesStats.total,
      totalMeetings: meetingsStats.total,
      activeUsers: activeUsers.size,
      messages: messagesStats,
      meetings: meetingsStats,
      calls: callsStats,
      usage: usageStats
    };

    const licensedActivity =
      dailyActivity.length > 0
        ? {
            totalChannelMessages: teamChatMessages,
            totalChatMessages: privateChatMessages,
            totalMeetings,
            totalCalls: callCountFromActivity,
            dailyActivity
          }
        : null;

    return {
      success: true,
      teams: {
        total: totalTeams,
        activeUsers: activeUsers.size,
        teamsList: teams?.value?.slice(0, 50).map(team => ({
          id: team.id,
          displayName: team.displayName,
          description: team.description,
          memberCount: teamMemberCounts.get(team.id) ?? 0,
          channelCount: teamChannelCounts.get(team.id) ?? 0
        })) || []
      },
      activity: activityStats,
      calls: callsStats,
      licensedActivity,
      lastUpdate: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Erreur lors de la récupération des données Teams"
    };
  }
}

/**
 * Fonction helper pour récupérer les données OneDrive complètes
 * Réutilise toute la logique de la route /onedrive
 */
async function fetchOneDriveDataInternal(accessToken, startDate, endDate, period = 'D90') {
  try {
    const [onedriveUsage, onedriveActivity, onedriveActivityFileCounts] = await Promise.all([
      callMicrosoftGraph(`/reports/getOneDriveUsageAccountDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getOneDriveActivityUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
      callMicrosoftGraph(`/reports/getOneDriveActivityFileCounts(period='${period}')`, accessToken, { isReport: true }).catch(() => null)
    ]);

    let totalStorageUsed = 0;
    let totalFiles = 0;
    let totalSharedFiles = 0;
    let totalExternalShares = 0;
    let usersNearQuota = [];
    let totalStorage = 0;

    if (onedriveUsage && onedriveUsage.value) {
      onedriveUsage.value.forEach(account => {
        const storageUsed = parseInt(account['Storage Used (Byte)'] || account.storageUsedInBytes || account['Storage Used'] || 0);
        const fileCount = parseInt(account['File Count'] || account.fileCount || account['Files'] || 0);
        const ownerName = account['Owner Display Name'] || account.ownerDisplayName || account['Owner'] || '';
        const ownerEmail = account['Owner Principal Name'] || account.ownerPrincipalName || account['Owner Email'] || '';
        
        totalStorageUsed += storageUsed;
        totalFiles += fileCount;
        totalStorage += storageUsed;
        
        const quotaBytes = 1024 * 1024 * 1024 * 1024; // 1TB
        const usagePercent = (storageUsed / quotaBytes) * 100;
        
        if (usagePercent >= 90) {
          usersNearQuota.push({
            name: ownerName,
            email: ownerEmail,
            usagePercent: Math.round(usagePercent),
            used: formatBytes(storageUsed),
            files: fileCount
          });
        }
      });
    }

    let filteredActivity = onedriveActivity?.value || [];
    if (onedriveActivity && onedriveActivity.value && startDate && endDate) {
      filteredActivity = onedriveActivity.value.filter(activity => {
        const activityDate = activity['Last Activity Date'] || 
                            activity['LastActivityDate'] || 
                            activity['Report Date'] ||
                            activity['ReportDate'] ||
                            activity.lastActivityDate ||
                            activity.reportDate;
        
        if (!activityDate || activityDate === '') return false;
        
        try {
          const date = new Date(activityDate);
          const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
          const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
          const endDateOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
          
          return dateOnly >= startDateOnly && dateOnly <= endDateOnly;
        } catch {
          return false;
        }
      });
    }
    
    if (filteredActivity.length > 0) {
      filteredActivity.forEach(activity => {
        const sharedExternally = activity['Shared Externally'] || activity.sharedExternally || 'False';
        const sharedCount = parseInt(activity['Shared Count'] || activity.sharedCount || activity['Shares'] || 0);
        
        if (sharedExternally === 'True' || sharedExternally === true) {
          totalExternalShares += sharedCount;
        }
        totalSharedFiles += sharedCount;
      });
    }

    const filesByActivityType = {
      viewedOrEdited: 0,
      synced: 0,
      sharedInternally: 0,
      sharedExternally: 0
    };
    
    let filteredFileCounts = onedriveActivityFileCounts?.value || [];
    if (onedriveActivityFileCounts && onedriveActivityFileCounts.value && startDate && endDate) {
      filteredFileCounts = onedriveActivityFileCounts.value.filter(entry => {
        const reportDate = entry['Report Date'] || 
                          entry['ReportDate'] ||
                          entry['Date'] ||
                          entry.reportDate ||
                          entry.date;
        
        if (!reportDate || reportDate === '') return false;
        
        try {
          const date = new Date(reportDate);
          const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
          const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
          const endDateOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
          
          return dateOnly >= startDateOnly && dateOnly <= endDateOnly;
        } catch {
          return false;
        }
      });
    }
    
    if (filteredFileCounts.length > 0) {
      filteredFileCounts.forEach(entry => {
        const viewedOrEdited = parseInt(
          entry['Viewed Or Edited File Count'] ||
          entry['Viewed or Edited File Count'] ||
          entry['ViewedOrEditedFileCount'] ||
          entry['Viewed Or Edited'] ||
          entry.viewedOrEdited ||
          0
        );
        const synced = parseInt(
          entry['Synced File Count'] ||
          entry['SyncedFileCount'] ||
          entry['Synced'] ||
          entry.synced ||
          0
        );
        const sharedInternal = parseInt(
          entry['Shared Internally File Count'] ||
          entry['SharedInternallyFileCount'] ||
          entry['Shared Internally'] ||
          entry.sharedInternally ||
          0
        );
        const sharedExternal = parseInt(
          entry['Shared Externally File Count'] ||
          entry['SharedExternallyFileCount'] ||
          entry['Shared Externally'] ||
          entry.sharedExternally ||
          0
        );
        
        filesByActivityType.viewedOrEdited += viewedOrEdited;
        filesByActivityType.synced += synced;
        filesByActivityType.sharedInternally += sharedInternal;
        filesByActivityType.sharedExternally += sharedExternal;
      });
    }

    return {
      success: true,
      storage: {
        totalUsed: formatBytes(totalStorageUsed),
        totalFiles: totalFiles,
        averagePerUser: onedriveUsage?.value?.length > 0 
          ? formatBytes(Math.floor(totalStorageUsed / onedriveUsage.value.length))
          : "0 B"
      },
      sharing: {
        totalShared: totalSharedFiles,
        externalShares: totalExternalShares,
        internalShares: totalSharedFiles - totalExternalShares,
        byActivityType: {
          viewedOrEdited: filesByActivityType.viewedOrEdited,
          synced: filesByActivityType.synced,
          sharedInternally: filesByActivityType.sharedInternally,
          sharedExternally: filesByActivityType.sharedExternally
        }
      },
      usersNearQuota: usersNearQuota,
      lastUpdate: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Erreur lors de la récupération des données OneDrive"
    };
  }
}

/**
 * Construit la liste des administrateurs (avec rôle) puis sauvegarde les détails MFA
 * (dont admin_role) en base pour le client. Utilisé par /security (inline) et par /sync-all.
 */
async function saveClientMfaDetailsWithAdminRoles(clientId, accessToken) {
  const importantRoles = [
    'Global Administrator', 'Privileged Role Administrator', 'Exchange Administrator',
    'SharePoint Administrator', 'User Administrator', 'Security Administrator',
    'Billing Administrator', 'Application Administrator', 'Cloud Application Administrator',
    'Helpdesk Administrator', 'Teams Administrator', 'Power Platform Administrator',
    'Azure AD Joined Device Local Administrator', 'Intune Administrator', 'Windows 365 Administrator',
    'Compliance Administrator', 'Conditional Access Administrator', 'Authentication Administrator',
    'License Administrator', 'Groups Administrator', 'Password Administrator',
    'Directory Readers', 'Guest Inviter', 'Message Center Reader', 'Reports Reader'
  ];

  const directoryRoles = await callMicrosoftGraph("/directoryRoles", accessToken).catch(() => null);
  const administrators = [];

  if (directoryRoles && directoryRoles.value) {
    for (const role of directoryRoles.value) {
      if (importantRoles.some(importantRole => role.displayName && role.displayName.includes(importantRole))) {
        try {
          const members = await callMicrosoftGraph(`/directoryRoles/${role.id}/members`, accessToken, { getAllPages: true }).catch(() => null);
          if (members && members.value) {
            members.value.forEach(member => {
                if (member['@odata.type'] === '#microsoft.graph.user') {
                const email = (member.mail || member.userPrincipalName || '').toLowerCase().trim();
                const alreadyExists = administrators.some(existing => existing.id === member.id || (existing.email && (existing.email).toLowerCase().trim() === email));
                if (!alreadyExists) {
                  administrators.push({
                    id: member.id,
                    name: member.displayName || member.userPrincipalName,
                    email: member.mail || member.userPrincipalName,
                    role: role.displayName,
                    hasMFA: false
                  });
                } else {
                  const existing = administrators.find(existing => existing.id === member.id || (existing.email && (existing.email).toLowerCase().trim() === email));
                  if (existing && existing.role && !existing.role.includes(role.displayName)) {
                    existing.role = [existing.role, role.displayName].filter(Boolean).join(', ');
                  }
                }
              }
            });
          }
        } catch (err) { /* ignore */ }
      }
    }
  }

  if (administrators.length < 5) {
    try {
      const roleAssignments = await callMicrosoftGraph('/roleManagement/directory/roleAssignments?$expand=principal&$top=200', accessToken).catch(() => null);
      if (roleAssignments && roleAssignments.value) {
        const adminRoleNames = [
          'Global Administrator', 'Privileged Role Administrator', 'User Administrator',
          'Exchange Administrator', 'SharePoint Administrator', 'Security Administrator',
          'Billing Administrator', 'Application Administrator', 'Cloud Application Administrator',
          'Helpdesk Administrator', 'Teams Administrator', 'Intune Administrator'
        ];
        for (const assignment of roleAssignments.value) {
          if (assignment.principal && assignment.principal['@odata.type'] === '#microsoft.graph.user') {
            const user = assignment.principal;
            const roleDefinition = assignment.roleDefinition;
            if (roleDefinition && roleDefinition.displayName && adminRoleNames.some(r => roleDefinition.displayName.includes(r))) {
              const upn = (user.userPrincipalName || '').toLowerCase().trim();
              const alreadyExists = administrators.some(existing => existing.id === user.id || (existing.email && (existing.email).toLowerCase().trim() === upn));
              if (!alreadyExists) {
                administrators.push({
                  id: user.id,
                  name: user.displayName || user.userPrincipalName,
                  email: user.userPrincipalName,
                  role: roleDefinition.displayName,
                  hasMFA: false
                });
              } else {
                const existing = administrators.find(existing => existing.id === user.id || (existing.email && (existing.email).toLowerCase().trim() === upn));
                if (existing && existing.role && !existing.role.includes(roleDefinition.displayName)) {
                  existing.role = [existing.role, roleDefinition.displayName].filter(Boolean).join(', ');
                }
              }
            }
          }
        }
      }
    } catch (err) { /* ignore */ }
  }

  const usersData = await callMicrosoftGraph("/users?$select=id,displayName,mail,userPrincipalName,accountEnabled", accessToken, { getAllPages: true }).catch(() => null);
  if (!usersData || !usersData.value || usersData.value.length === 0) return;

  const usersToCheck = usersData.value;
  const mfaDetailsPromises = usersToCheck.map(async (user) => {
    try {
      const methods = await callMicrosoftGraph(`/users/${user.id}/authentication/methods`, accessToken).catch(() => null);
      const methodTypes = [];
      let lastMfaEnrollmentDate = null;
      if (methods && methods.value && Array.isArray(methods.value)) {
        methods.value.forEach(method => {
          if (method['@odata.type']) {
            const type = method['@odata.type'].split('.').pop().toLowerCase();
            methodTypes.push(type);
          }
        });
        const realMfaMethods = (methods.value || []).filter(m => {
          const t = (m['@odata.type'] || '').split('.').pop().toLowerCase();
          return ['emailauthenticationmethod', 'softwareoathauthenticationmethod', 'phoneauthenticationmethod', 'microsoftauthenticatorauthenticationmethod'].includes(t);
        });
        if (realMfaMethods.length > 0) {
          const sorted = realMfaMethods.filter(m => m.createdDateTime).sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime));
          if (sorted[0]) lastMfaEnrollmentDate = sorted[0].createdDateTime;
        }
      }
      const uniqueMethodTypes = [...new Set(methodTypes)];
      const mfaMethods = uniqueMethodTypes.filter(t =>
        ['emailauthenticationmethod', 'softwareoathauthenticationmethod', 'phoneauthenticationmethod', 'microsoftauthenticatorauthenticationmethod'].includes(t)
      );
      const hasMFA = mfaMethods.length > 0;
      return {
        id: user.id,
        displayName: user.displayName || user.userPrincipalName,
        userPrincipalName: user.userPrincipalName,
        hasMFA,
        mfaMethods: uniqueMethodTypes,
        lastMfaEnrollmentDate
      };
    } catch (err) {
      return {
        id: user.id,
        displayName: user.displayName || user.userPrincipalName,
        userPrincipalName: user.userPrincipalName,
        hasMFA: false,
        mfaMethods: [],
        lastMfaEnrollmentDate: null
      };
    }
  });

  const settled = await Promise.allSettled(mfaDetailsPromises);
  const userMfaDetails = settled.filter(r => r.status === 'fulfilled').map(r => r.value);

  try {
    for (const userDetail of userMfaDetails) {
      const adminRoles = [];
      for (const admin of administrators) {
        // Correspondance stricte : identifiant Azure AD (id) ou UPN exact uniquement
        const userUpn = (userDetail.userPrincipalName || '').toLowerCase().trim();
        const adminEmail = (admin.email || '').toLowerCase().trim();
        const matchById = admin.id && userDetail.id && String(admin.id) === String(userDetail.id);
        const matchByUpn = userUpn && adminEmail && userUpn === adminEmail;
        if (matchById || matchByUpn) {
          if (admin.role && !adminRoles.includes(admin.role)) adminRoles.push(admin.role);
        }
      }
      const isAdmin = adminRoles.length > 0;
      const adminRoleText = adminRoles.join(', ') || null;
      await pool.query(`
        INSERT INTO v_b_clients_c_azure_mfa (
          client_id, user_id, display_name, user_principal_name, account_enabled,
          has_mfa, mfa_methods, latest_mfa_registration_date, is_admin, admin_role, last_sync
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
        ON CONFLICT (client_id, user_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          user_principal_name = EXCLUDED.user_principal_name,
          account_enabled = EXCLUDED.account_enabled,
          has_mfa = EXCLUDED.has_mfa,
          mfa_methods = EXCLUDED.mfa_methods,
          latest_mfa_registration_date = EXCLUDED.latest_mfa_registration_date,
          is_admin = EXCLUDED.is_admin,
          admin_role = EXCLUDED.admin_role,
          last_sync = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      `, [
        clientId, userDetail.id, userDetail.displayName, userDetail.userPrincipalName, true,
        userDetail.hasMFA, JSON.stringify(userDetail.mfaMethods || []), userDetail.lastMfaEnrollmentDate,
        isAdmin, adminRoleText
      ]);
    }
  } catch (err) {
    console.error('Erreur sauvegarde MFA + rôles admin (sync):', err);
  }
}

/**
 * GET /api/office365/sync-all
 * Synchronise TOUTES les données Office 365 (data, exchange, teams, onedrive, sharepoint, security)
 * et les sauvegarde dans v_b_clients_m_o365
 */
router.get("/sync-all", verifyJWT, async (req, res) => {
  try {
    const clientId = req.query.clientId ? parseInt(req.query.clientId) : null;
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;
    const period = 'D90'; // Toujours D90 pour avoir le maximum de données

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: "clientId est requis pour la synchronisation complète"
      });
    }

    // Récupérer les credentials depuis v_b_clients_azure pour ce client spécifique
    // IMPORTANT: Ne PAS utiliser les settings globaux si un clientId est fourni
    // pour éviter de mélanger les données entre différents clients
    const credentials = await getClientOffice365Credentials(clientId);
    
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: `Configuration Azure non trouvée pour le client ${clientId}. Veuillez configurer les credentials Azure spécifiques à ce client dans v_b_clients_azure.`
      });
    }
    
    // Vérifier que les credentials sont valides
    if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret) {
      return res.status(400).json({
        success: false,
        error: `Configuration Azure incomplète pour le client ${clientId}. Les credentials doivent contenir tenantId, clientId et clientSecret.`
      });
    }

    const accessToken = await getMicrosoftGraphToken(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Récupérer TOUTES les données en parallèle en appelant directement les fonctions internes
    // Au lieu de faire des appels HTTP, on va réutiliser la logique directement
    
    // 1. Données principales (licences, users, adoptionScore)
    const dataResult = await fetchOffice365DataInternal(clientId, credentials);

    // Préparer les dates pour le filtrage
    const startDateObj = startDate ? new Date(startDate) : null;
    const endDateObj = endDate ? new Date(endDate) : null;

    // 2. Exchange - utiliser la fonction helper complète
    const exchangePromise = fetchExchangeDataInternal(accessToken, startDateObj, endDateObj, period);

    // 3. Teams - utiliser la fonction helper complète
    const teamsPromise = fetchTeamsDataInternal(accessToken, startDateObj, endDateObj, period);

    // 4. OneDrive - utiliser la fonction helper complète
    const onedrivePromise = fetchOneDriveDataInternal(accessToken, startDateObj, endDateObj, period);

    // 5. SharePoint - réutiliser la logique de la route /sharepoint (simplifié)
    const sharepointPromise = (async () => {
      try {
        const [sharepointUsage, sharepointActivity, sites] = await Promise.all([
          callMicrosoftGraph(`/reports/getSharePointSiteUsageDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
          callMicrosoftGraph(`/reports/getSharePointActivityUserDetail(period='${period}')`, accessToken, { isReport: true }).catch(() => null),
          callMicrosoftGraph("/sites?$select=id,displayName,webUrl,createdDateTime,lastModifiedDateTime", accessToken, { getAllPages: true }).catch(() => null)
        ]);

        const sitesList = sites?.value?.map(site => ({
          id: site.id,
          name: site.displayName,
          webUrl: site.webUrl,
          createdDateTime: site.createdDateTime,
          lastActivityDate: site.lastModifiedDateTime,
          isActive: true
        })) || [];

        return {
          success: true,
          sites: sitesList,
          stats: { totalSites: sitesList.length, activeSites: sitesList.length }
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    })();

    // 6. Security - réutiliser la logique de la route /security (simplifié)
    const securityPromise = (async () => {
      try {
        const [mfaReport, directoryRoles, usersData, secureScores] = await Promise.all([
          callMicrosoftGraph("/reports/authenticationMethods/userRegistrationDetails", accessToken, { isReport: true }).catch(() => null),
          callMicrosoftGraph("/directoryRoles", accessToken).catch(() => null),
          callMicrosoftGraph("/users?$select=id,displayName,mail,userPrincipalName,accountEnabled", accessToken, { getAllPages: true }).catch(() => null),
          callMicrosoftGraph("/security/secureScores?$orderby=createdDateTime desc", accessToken, { getAllPages: true }).catch(() => null)
        ]);

        // Traitement simplifié des données de sécurité
        const identitySecureScore = secureScores?.value?.find(score => score.controlCategory === 'Identity' || !score.controlCategory) || secureScores?.value?.[0];
        
        return {
          success: true,
          secureScore: identitySecureScore ? {
            currentScore: identitySecureScore.currentScore || 0,
            maxScore: identitySecureScore.maxScore || 0,
            percentage: identitySecureScore.maxScore > 0 ? ((identitySecureScore.currentScore / identitySecureScore.maxScore) * 100) : 0
          } : null,
          mfa: {
            usersWithMFA: 0,
            usersWithoutMFA: usersData?.value?.length || 0
          },
          adminStats: {
            total: directoryRoles?.value?.length || 0,
            withMFA: 0,
            withoutMFA: directoryRoles?.value?.length || 0
          }
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    })();

    // Attendre toutes les promesses (y compris récupération des rôles admin + sauvegarde MFA)
    const [data, exchangeData, teamsData, onedriveData, sharepointData, securityData, mfaAdminSave] = await Promise.allSettled([
      Promise.resolve(dataResult),
      exchangePromise,
      teamsPromise,
      onedrivePromise,
      sharepointPromise,
      securityPromise,
      saveClientMfaDetailsWithAdminRoles(clientId, accessToken)
    ]);

    // Extraire les résultats
    const dataFinal = data.status === 'fulfilled' ? data.value : { success: false, error: data.reason?.message };
    const exchangeFinal = exchangeData.status === 'fulfilled' ? exchangeData.value : { success: false, error: exchangeData.reason?.message };
    const teamsFinal = teamsData.status === 'fulfilled' ? teamsData.value : { success: false, error: teamsData.reason?.message };
    const onedriveFinal = onedriveData.status === 'fulfilled' ? onedriveData.value : { success: false, error: onedriveData.reason?.message };
    const sharepointFinal = sharepointData.status === 'fulfilled' ? sharepointData.value : { success: false, error: sharepointData.reason?.message };
    const securityFinal = securityData.status === 'fulfilled' ? securityData.value : { success: false, error: securityData.reason?.message };

    // Construire le snapshot complet
    const snapshotData = {
      tenantId: credentials.tenantId || null,
      licences: dataFinal.licences || [],
      users: dataFinal.users || [],
      adoptionScore: dataFinal.adoptionScore || null,
      exchangeData: exchangeFinal.success !== false ? exchangeFinal : null,
      teamsData: teamsFinal.success ? teamsFinal : null,
      onedriveData: onedriveFinal.success ? onedriveFinal : null,
      sharepointData: sharepointFinal.success ? sharepointFinal : null,
      securityData: securityFinal.success ? securityFinal : null,
      lastUpdate: new Date().toISOString()
    };

    // Sauvegarder dans v_b_clients_m_o365
    try {
      // Supprimer uniquement les snapshots de CE client avec CE tenantId
      await pool.query(
        `DELETE FROM v_b_clients_m_o365 
         WHERE client_id = $1 
           AND item_key = $2`,
        [clientId, credentials.tenantId || null]
      );

      // Insérer le nouveau snapshot avec le clientId et tenantId corrects
      await pool.query(
        `INSERT INTO v_b_clients_m_o365 (client_id, item_key, name, data, is_active)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          clientId,
          credentials.tenantId || null,
          'Microsoft 365',
          snapshotData,
          true
        ]
      );
    } catch (dbError) {
      return res.status(500).json({
        success: false,
        error: `Erreur lors de la sauvegarde: ${dbError.message}`
      });
    }

    res.json({
      success: true,
      message: "Synchronisation complète terminée",
      data: snapshotData,
      lastUpdate: snapshotData.lastUpdate
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la synchronisation complète"
    });
  }
});

export default router;

