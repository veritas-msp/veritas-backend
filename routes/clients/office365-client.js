import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { encrypt, decrypt } from "../../utils/encryption.js";
import { dispatchNotificationEvent } from "../../services/notificationDispatcher.js";

// Import des fonctions depuis office365.js
let getClientOffice365Credentials, getOffice365Settings, getMicrosoftGraphToken;

// Charger les fonctions de manière asynchrone
(async () => {
  const office365Module = await import("../integrations/office365.js");
  getClientOffice365Credentials = office365Module.getClientOffice365Credentials || (async () => null);
  getOffice365Settings = office365Module.getOffice365Settings || (async () => null);
  getMicrosoftGraphToken = office365Module.getMicrosoftGraphToken;
})();

const router = express.Router();

// Toutes les routes nécessitent une authentification
router.use(verifyJWT);

/**
 * POST /api/client-office365/test-credentials
 * Teste la connexion Office 365 avec les credentials fournies (sans les sauvegarder)
 */
router.post("/test-credentials", async (req, res) => {
  try {
    const { tenantId, clientIdAzure, clientSecret, secretKeyId } = req.body;

    // Validation
    if (!tenantId || !clientIdAzure || !clientSecret) {
      return res.status(400).json({
        success: false,
        error: "Tenant ID, Client ID Azure et Client Secret sont requis"
      });
    }

    // Déchiffrer n'est pas nécessaire ici puisque les credentials ne sont pas chiffrés
    // (ils viennent directement du formulaire et ne sont pas sauvegardés)

    // Tester la connexion en appelant directement Microsoft Graph
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      client_id: clientIdAzure,
      scope: "https://graph.microsoft.com/.default",
      client_secret: clientSecret,
      grant_type: "client_credentials"
    });

    const fetch = (await import("node-fetch")).default;
    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    if (!tokenResponse.ok) {
      // Récupérer le message d'erreur détaillé de Microsoft
      let errorMessage = `Erreur d'authentification Microsoft (${tokenResponse.status})`;
      let microsoftError = null;

      try {
        const errorData = await tokenResponse.json();
        microsoftError = errorData;
        if (errorData.error_description) {
          errorMessage = `${errorData.error_description}`;
        } else if (errorData.error) {
          errorMessage = `Erreur: ${errorData.error}`;
          if (errorData.error_description) {
            errorMessage += ` - ${errorData.error_description}`;
          }
        }
      } catch (e) {
        const errorText = await tokenResponse.text().catch(() => '');
        if (errorText) {
          errorMessage = errorText;
        }
      }

      throw new Error(errorMessage);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Tester avec un appel à l'API Graph
    const graphResponse = await fetch("https://graph.microsoft.com/v1.0/organization", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    if (!graphResponse.ok) {
      throw new Error(`Erreur Microsoft Graph API: ${graphResponse.status}`);
    }

    const orgInfo = await graphResponse.json();

    // Récupérer aussi le nom de l'application
    let applicationDisplayName = null;
    try {
      const appResponse = await fetch(
        `https://graph.microsoft.com/v1.0/applications(appId='${clientIdAzure}')?$select=displayName`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          }
        }
      );
      if (appResponse.ok) {
        const appData = await appResponse.json();
        applicationDisplayName = appData.displayName;
      }
    } catch (e) {
      // Ignorer l'erreur si on ne peut pas récupérer le nom de l'application
    }

    res.json({
      success: true,
      message: "Connexion à Microsoft Graph API réussie",
      organization: orgInfo.value?.[0]?.displayName || "Organisation inconnue",
      applicationDisplayName: applicationDisplayName
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors du test de connexion"
    });
  }
});

/**
 * GET /api/client-office365/:clientId
 * Récupère les credentials Office 365 d'un client (sans le secret)
 */
router.get("/:clientId", async (req, res) => {
  try {
    const { clientId } = req.params;
    
    const result = await pool.query(
      `SELECT id, client_id, tenant_id, client_id_azure, secret_key_id, created_at, updated_at
       FROM v_b_clients_azure
       WHERE client_id = $1`,
      [clientId]
    );
    
    if (result.rows.length === 0) {
      return res.json({
        success: true,
        credentials: null
      });
    }
    
    const cred = result.rows[0];
    res.json({
      success: true,
      credentials: {
        id: cred.id,
        clientId: cred.client_id,
        tenantId: cred.tenant_id,
        clientIdAzure: cred.client_id_azure,
        secretKeyId: cred.secret_key_id,
        hasSecret: true, // Indique qu'un secret est configuré (mais on ne le retourne pas)
        createdAt: cred.created_at,
        updatedAt: cred.updated_at
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération des credentials"
    });
  }
});

/**
 * POST /api/client-office365/:clientId
 * Crée ou met à jour les credentials Office 365 d'un client
 */
router.post("/:clientId", async (req, res) => {
  try {
    const { clientId } = req.params;
    const { tenantId, clientIdAzure, clientSecret, secretKeyId } = req.body;

    // Validation
    if (!tenantId || !clientIdAzure) {
      return res.status(400).json({
        success: false,
        error: "Tenant ID et Client ID Azure sont requis"
      });
    }

    // Vérifier si des credentials existent déjà
    const existingResult = await pool.query(
      "SELECT id, client_secret_encrypted, iv, auth_tag FROM v_b_clients_azure WHERE client_id = $1",
      [clientId]
    );

    let finalClientSecret = clientSecret;
    let needsEncryption = true;

    // Si des credentials existent et qu'aucun nouveau secret n'est fourni,
    // on garde le secret existant
    if (existingResult.rows.length > 0 && !clientSecret) {
      const existingCred = existingResult.rows[0];
      finalClientSecret = {
        encrypted: existingCred.client_secret_encrypted,
        iv: existingCred.iv,
        authTag: existingCred.auth_tag
      };
      needsEncryption = false;
    } else if (!clientSecret) {
      return res.status(400).json({
        success: false,
        error: "Le Client Secret est obligatoire pour configurer Office365 pour la première fois. Veuillez le saisir dans le champ 'Valeur du secret (client secret)'."
      });
    }
    
    // Vérifier que le client existe
    const clientResult = await pool.query(
      "SELECT id FROM v_b_clients WHERE id = $1",
      [clientId]
    );

    if (clientResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Client non trouvé"
      });
    }

    // Normaliser secretKeyId : convertir chaîne vide en null
    const normalizedSecretKeyId = secretKeyId && secretKeyId.trim() !== "" ? secretKeyId.trim() : null;

    // Préparer les données de chiffrement
    let encryptedData;
    if (needsEncryption) {
      encryptedData = encrypt(finalClientSecret);
      if (!encryptedData) {
        return res.status(500).json({
          success: false,
          error: "Erreur lors du chiffrement du secret"
        });
      }
    } else {
      // Réutiliser les données existantes
      encryptedData = finalClientSecret;
    }

    if (existingResult.rows.length > 0) {
      // Mise à jour
      await pool.query(
        `UPDATE v_b_clients_azure
         SET tenant_id = $1, client_id_azure = $2, client_secret_encrypted = $3, iv = $4, auth_tag = $5, secret_key_id = $6
         WHERE client_id = $7`,
        [
          tenantId,
          clientIdAzure,
          encryptedData.encrypted,
          encryptedData.iv,
          encryptedData.authTag,
          normalizedSecretKeyId,
          clientId
        ]
      );
    } else {
      // Création
      await pool.query(
        `INSERT INTO v_b_clients_azure
         (client_id, tenant_id, client_id_azure, client_secret_encrypted, iv, auth_tag, secret_key_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          clientId,
          tenantId,
          clientIdAzure,
          encryptedData.encrypted,
          encryptedData.iv,
          encryptedData.authTag,
          normalizedSecretKeyId
        ]
      );
    }
    
    res.json({
      success: true,
      message: "Credentials Office 365 enregistrés avec succès"
    });

    await dispatchNotificationEvent({
      source: "services",
      element: "tenant_updated",
      enterpriseId: String(clientId || ""),
      user: req.user,
      context: {
        entreprise: { id: String(clientId || "") },
        tenantId,
        clientIdAzure,
      },
    }).catch(() => {});
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de l'enregistrement des credentials"
    });
  }
});

/**
 * DELETE /api/client-office365/:clientId
 * Supprime les credentials Office 365 d'un client
 */
router.delete("/:clientId", async (req, res) => {
  try {
    const { clientId } = req.params;

    // Supprimer des deux tables possibles (ancienne et nouvelle)
    await pool.query(
      "DELETE FROM v_b_clients_azure WHERE client_id = $1",
      [clientId]
    );

    // Aussi supprimer de l'ancienne table v_b_clients_azure si elle existe
    try {
      await pool.query(
        "DELETE FROM v_b_clients_azure WHERE client_id = $1",
        [clientId]
      );
    } catch (e) {
      // Ignorer l'erreur si la table n'existe pas ou n'a pas cette structure
      console.log("Note: v_b_clients_azure might not exist or have different structure");
    }

    res.json({
      success: true,
      message: "Credentials Office 365 supprimés avec succès"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la suppression des credentials"
    });
  }
});

/**
 * GET /api/client-office365/:clientId/test
 * Teste la connexion Office 365 avec les credentials du client
 */
router.get("/:clientId/test", async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Récupérer les credentials chiffrés
    const result = await pool.query(
      `SELECT tenant_id, client_id_azure, client_secret_encrypted, iv, auth_tag
       FROM v_b_clients_azure
       WHERE client_id = $1`,
      [clientId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Aucun credential Office 365 configuré pour ce client"
      });
    }
    
    const cred = result.rows[0];
    
    // Déchiffrer le secret
    let clientSecret;
    try {
      clientSecret = decrypt(
        cred.client_secret_encrypted,
        cred.iv,
        cred.auth_tag
      );
      
      if (!clientSecret) {
        return res.status(500).json({
          success: false,
          error: "Erreur lors du déchiffrement du secret : résultat vide. Vérifiez que ENCRYPTION_KEY est correctement configurée dans les variables d'environnement."
        });
      }
      
    } catch (decryptError) {
      return res.status(500).json({
        success: false,
        error: `Erreur lors du déchiffrement du secret: ${decryptError.message}. Si vous avez changé ENCRYPTION_KEY, vous devrez réenregistrer les credentials.`
      });
    }
    
    // Tester la connexion en appelant directement Microsoft Graph
    const tokenUrl = `https://login.microsoftonline.com/${cred.tenant_id}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      client_id: cred.client_id_azure,
      scope: "https://graph.microsoft.com/.default",
      client_secret: clientSecret,
      grant_type: "client_credentials"
    });
    
    const fetch = (await import("node-fetch")).default;
    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    
    if (!tokenResponse.ok) {
      // Récupérer le message d'erreur détaillé de Microsoft
      let errorMessage = `Erreur d'authentification Microsoft (${tokenResponse.status})`;
      let microsoftError = null;
      
      try {
        const errorData = await tokenResponse.json();
        microsoftError = errorData;
        if (errorData.error_description) {
          errorMessage = `${errorData.error_description}`;
        } else if (errorData.error) {
          errorMessage = `Erreur: ${errorData.error}`;
          if (errorData.error_description) {
            errorMessage += ` - ${errorData.error_description}`;
          }
        }
      } catch (e) {
        const errorText = await tokenResponse.text().catch(() => '');
        if (errorText) {
          errorMessage = errorText;
        }
      }
      
      // Log détaillé pour le débogage
      // Messages d'aide selon le code d'erreur
      if (tokenResponse.status === 401) {
        let helpMessage = "\n\n🔍 Vérifications à effectuer :";
        
        // Messages spécifiques selon le type d'erreur Microsoft
        if (microsoftError?.error === "invalid_client") {
          helpMessage += "\n❌ Client ID ou Client Secret incorrect";
          helpMessage += "\n   - Vérifiez que le Client ID (Azure) correspond à l'Application (client) ID dans Azure Portal";
          helpMessage += "\n   - Vérifiez que le Client Secret n'a pas expiré (Azure Portal > Certificates & secrets)";
          helpMessage += "\n   - Vérifiez que vous avez copié la valeur complète du secret (souvent très long)";
        } else if (microsoftError?.error === "invalid_request") {
          helpMessage += "\n❌ Requête invalide";
          helpMessage += "\n   - Vérifiez que le Tenant ID est correct";
          helpMessage += "\n   - Vérifiez le format des IDs (GUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)";
        } else {
          helpMessage += "\n- Le Client Secret est-il correct et non expiré ?";
          helpMessage += "\n- Le Client ID (Azure) est-il correct ?";
          helpMessage += "\n- Le Tenant ID est-il correct ?";
          helpMessage += "\n- Les permissions Application sont-elles bien configurées ?";
        }
        
        errorMessage += helpMessage;
      }
      
      throw new Error(errorMessage);
    }
    
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    
    // Tester avec un appel à l'API Graph
    const graphResponse = await fetch("https://graph.microsoft.com/v1.0/organization", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    
    if (!graphResponse.ok) {
      throw new Error(`Erreur Microsoft Graph API: ${graphResponse.status}`);
    }
    
    const orgInfo = await graphResponse.json();
    
    // Récupérer aussi le nom de l'application
    let applicationDisplayName = null;
    try {
      const appResponse = await fetch(
        `https://graph.microsoft.com/v1.0/applications(appId='${cred.client_id_azure}')?$select=displayName`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          }
        }
      );
      if (appResponse.ok) {
        const appData = await appResponse.json();
        applicationDisplayName = appData.displayName;
      }
    } catch (e) {
      // Ignorer l'erreur si on ne peut pas récupérer le nom de l'application
    }
    
    res.json({
      success: true,
      message: "Connexion à Microsoft Graph API réussie",
      organization: orgInfo.value?.[0]?.displayName || "Organisation inconnue",
      applicationDisplayName: applicationDisplayName
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors du test de connexion"
    });
  }
});

/**
 * GET /api/client-office365/:clientId/secret-expiration
 * Récupère la date d'expiration du Client Secret depuis Microsoft Graph
 */
router.get("/:clientId/secret-expiration", async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Récupérer les credentials
    const result = await pool.query(
      `SELECT tenant_id, client_id_azure, secret_key_id
       FROM v_b_clients_azure
       WHERE client_id = $1`,
      [clientId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Aucun credential Office 365 configuré pour ce client"
      });
    }
    
    const cred = result.rows[0];
    
    // Importer les fonctions depuis office365.js
    const office365Module = await import("../integrations/office365.js");
    const getClientOffice365Credentials = office365Module.getClientOffice365Credentials;
    const getOffice365Settings = office365Module.getOffice365Settings;
    const getMicrosoftGraphToken = office365Module.getMicrosoftGraphToken;
    
    // Récupérer les credentials pour obtenir le token
    let clientCredentials = await getClientOffice365Credentials(clientId);
    if (!clientCredentials) {
      // Essayer avec les paramètres globaux
      const settings = await getOffice365Settings();
      if (settings && settings.tenant_id && settings.client_id && settings.client_secret) {
        clientCredentials = {
          tenantId: settings.tenant_id,
          clientId: settings.client_id,
          clientSecret: settings.client_secret
        };
      } else {
        return res.status(400).json({
          success: false,
          error: "Credentials non configurés"
        });
      }
    }
    
    // Obtenir un token d'accès
    const accessToken = await getMicrosoftGraphToken(
      clientCredentials.tenantId,
      clientCredentials.clientId,
      clientCredentials.clientSecret
    );
    
    // Récupérer les informations de l'application
    // Utiliser appId comme clé alternative si l'ID de l'objet n'est pas disponible
    const fetch = (await import("node-fetch")).default;
    
    // Essayer d'abord avec appId comme clé alternative
    let appResponse = await fetch(
      `https://graph.microsoft.com/v1.0/applications(appId='${cred.client_id_azure}')?$select=id,appId,displayName,passwordCredentials`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    // Si ça ne fonctionne pas, essayer avec l'ID directement
    if (!appResponse.ok && appResponse.status === 404) {
      appResponse = await fetch(
        `https://graph.microsoft.com/v1.0/applications/${cred.client_id_azure}?$select=id,appId,displayName,passwordCredentials`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          }
        }
      );
    }
    
    if (!appResponse.ok) {
      const errorText = await appResponse.text().catch(() => '');
      
      if (appResponse.status === 403) {
        return res.status(403).json({
          success: false,
          error: "Permission insuffisante. La permission Application.Read.All est requise pour récupérer la date d'expiration du secret. Vérifiez que le consentement administrateur a été accordé."
        });
      }
      throw new Error(`Erreur Microsoft Graph API: ${appResponse.status} - ${errorText}`);
    }
    
    const appData = await appResponse.json();
    
    // Trouver le secret correspondant (on ne peut pas matcher par valeur, mais on peut retourner tous les secrets)
    // Le secret le plus récent est généralement celui utilisé
    const passwordCredentials = appData.passwordCredentials || [];
    
    // Si un keyId est spécifié, chercher ce secret spécifique
    let targetSecret = null;
    if (cred.secret_key_id) {
      targetSecret = passwordCredentials.find(secret => secret.keyId === cred.secret_key_id);
    }
    
    // Si pas de secret trouvé par keyId, prendre le plus récent
    if (!targetSecret) {
      // Trier par date de création (startDateTime) décroissante pour obtenir le plus récent
      passwordCredentials.sort((a, b) => {
        const dateA = new Date(a.startDateTime || 0);
        const dateB = new Date(b.startDateTime || 0);
        return dateB - dateA;
      });
      targetSecret = passwordCredentials[0];
    }
    
    const latestSecret = targetSecret;
    
    if (!latestSecret) {
      return res.json({
        success: true,
        expirationDate: null,
        message: "Aucun secret trouvé pour cette application"
      });
    }
    
    res.json({
      success: true,
      expirationDate: latestSecret.endDateTime,
      displayName: latestSecret.displayName || "Secret client",
      startDateTime: latestSecret.startDateTime,
      allSecrets: passwordCredentials.map(secret => ({
        displayName: secret.displayName,
        expirationDate: secret.endDateTime,
        startDateTime: secret.startDateTime
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Erreur lors de la récupération de la date d'expiration"
    });
  }
});

export default router;

