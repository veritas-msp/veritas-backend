import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { encrypt, decrypt } from "../../utils/encryption.js";
import { dispatchNotificationEvent } from "../../services/notificationDispatcher.js";
let getClientOffice365Credentials, getOffice365Settings, getMicrosoftGraphToken;
(async () => {
  const office365Module = await import("../integrations/office365.js");
  getClientOffice365Credentials = office365Module.getClientOffice365Credentials || (async () => null);
  getOffice365Settings = office365Module.getOffice365Settings || (async () => null);
  getMicrosoftGraphToken = office365Module.getMicrosoftGraphToken;
})();
const router = express.Router();
router.use(verifyJWT);
router.post("/test-credentials", async (req, res) => {
  try {
    const {
      tenantId,
      clientIdAzure,
      clientSecret,
      secretKeyId
    } = req.body;
    if (!tenantId || !clientIdAzure || !clientSecret) {
      return res.status(400).json({
        success: false,
        error: "Tenant ID, Client ID Azure et Client Secret are required"
      });
    }
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
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    if (!tokenResponse.ok) {
      let errorMessage = `Microsoft authentication error (${tokenResponse.status})`;
      let microsoftError = null;
      try {
        const errorData = await tokenResponse.json();
        microsoftError = errorData;
        if (errorData.error_description) {
          errorMessage = `${errorData.error_description}`;
        } else if (errorData.error) {
          errorMessage = `Error: ${errorData.error}`;
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
    const graphResponse = await fetch("https://graph.microsoft.com/v1.0/organization", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    if (!graphResponse.ok) {
      throw new Error(`Microsoft Graph API error: ${graphResponse.status}`);
    }
    const orgInfo = await graphResponse.json();
    let applicationDisplayName = null;
    try {
      const appResponse = await fetch(`https://graph.microsoft.com/v1.0/applications(appId='${clientIdAzure}')?$select=displayName`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      });
      if (appResponse.ok) {
        const appData = await appResponse.json();
        applicationDisplayName = appData.displayName;
      }
    } catch (e) {}
    res.json({
      success: true,
      message: "Successfully connected to Microsoft Graph API",
      organization: orgInfo.value?.[0]?.displayName || "Organisation inconnue",
      applicationDisplayName: applicationDisplayName
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Error testing connection"
    });
  }
});
router.get("/:clientId", async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const result = await pool.query(`SELECT id, client_id, tenant_id, client_id_azure, secret_key_id, created_at, updated_at
       FROM v_b_clients_azure
       WHERE client_id = $1`, [clientId]);
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
        hasSecret: true,
        createdAt: cred.created_at,
        updatedAt: cred.updated_at
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Error retrieving credentials"
    });
  }
});
router.post("/:clientId", async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const {
      tenantId,
      clientIdAzure,
      clientSecret,
      secretKeyId
    } = req.body;
    if (!tenantId || !clientIdAzure) {
      return res.status(400).json({
        success: false,
        error: "Tenant ID et Client ID Azure are required"
      });
    }
    const existingResult = await pool.query("SELECT id, client_secret_encrypted, iv, auth_tag FROM v_b_clients_azure WHERE client_id = $1", [clientId]);
    let finalClientSecret = clientSecret;
    let needsEncryption = true;
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
        error: "Client Secret is required to configure Office365 for the first time. Please enter it in the 'Secret value (client secret)' field."
      });
    }
    const clientResult = await pool.query("SELECT id FROM v_b_clients WHERE id = $1", [clientId]);
    if (clientResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Client not found"
      });
    }
    const normalizedSecretKeyId = secretKeyId && secretKeyId.trim() !== "" ? secretKeyId.trim() : null;
    let encryptedData;
    if (needsEncryption) {
      encryptedData = encrypt(finalClientSecret);
      if (!encryptedData) {
        return res.status(500).json({
          success: false,
          error: "Error encrypting secret"
        });
      }
    } else {
      encryptedData = finalClientSecret;
    }
    if (existingResult.rows.length > 0) {
      await pool.query(`UPDATE v_b_clients_azure
         SET tenant_id = $1, client_id_azure = $2, client_secret_encrypted = $3, iv = $4, auth_tag = $5, secret_key_id = $6
         WHERE client_id = $7`, [tenantId, clientIdAzure, encryptedData.encrypted, encryptedData.iv, encryptedData.authTag, normalizedSecretKeyId, clientId]);
    } else {
      await pool.query(`INSERT INTO v_b_clients_azure
         (client_id, tenant_id, client_id_azure, client_secret_encrypted, iv, auth_tag, secret_key_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [clientId, tenantId, clientIdAzure, encryptedData.encrypted, encryptedData.iv, encryptedData.authTag, normalizedSecretKeyId]);
    }
    res.json({
      success: true,
      message: "Office 365 credentials saved successfully"
    });
    await dispatchNotificationEvent({
      source: "services",
      element: "tenant_updated",
      enterpriseId: String(clientId || ""),
      user: req.user,
      context: {
        entreprise: {
          id: String(clientId || "")
        },
        tenantId,
        clientIdAzure
      }
    }).catch(() => {});
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Error saving credentials"
    });
  }
});
router.delete("/:clientId", async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    await pool.query("DELETE FROM v_b_clients_azure WHERE client_id = $1", [clientId]);
    try {
      await pool.query("DELETE FROM v_b_clients_azure WHERE client_id = $1", [clientId]);
    } catch (e) {
      console.log("Note: v_b_clients_azure might not exist or have different structure");
    }
    res.json({
      success: true,
      message: "Office 365 credentials deleted successfully"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Error deleting credentials"
    });
  }
});
router.get("/:clientId/test", async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const result = await pool.query(`SELECT tenant_id, client_id_azure, client_secret_encrypted, iv, auth_tag
       FROM v_b_clients_azure
       WHERE client_id = $1`, [clientId]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No Office 365 credential configured for this client"
      });
    }
    const cred = result.rows[0];
    let clientSecret;
    try {
      clientSecret = decrypt(cred.client_secret_encrypted, cred.iv, cred.auth_tag);
      if (!clientSecret) {
        return res.status(500).json({
          success: false,
          error: "Error decrypting secret: empty result. Verify ENCRYPTION_KEY is correctly set in environment variables."
        });
      }
    } catch (decryptError) {
      return res.status(500).json({
        success: false,
        error: `Error decrypting secret: ${decryptError.message}. If you changed ENCRYPTION_KEY, you will need to re-save credentials.`
      });
    }
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
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    if (!tokenResponse.ok) {
      let errorMessage = `Microsoft authentication error (${tokenResponse.status})`;
      let microsoftError = null;
      try {
        const errorData = await tokenResponse.json();
        microsoftError = errorData;
        if (errorData.error_description) {
          errorMessage = `${errorData.error_description}`;
        } else if (errorData.error) {
          errorMessage = `Error: ${errorData.error}`;
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
      if (tokenResponse.status === 401) {
        let helpMessage = "\\n\\n🔍 Checks to perform:";
        if (microsoftError?.error === "invalid_client") {
          helpMessage += "\n❌ Client ID ou Client Secret incorrect";
          helpMessage += "\\n   - Verify the Client ID (Azure) matches the Application (client) ID in Azure Portal";
          helpMessage += "\\n   - Verify the Client Secret has not expired (Azure Portal > Certificates & secrets)";
          helpMessage += "\\n   - Verify you copied the full secret value (often very long)";
        } else if (microsoftError?.error === "invalid_request") {
          helpMessage += "\n❌ Invalid request";
          helpMessage += "\\n   - Verify the Tenant ID is correct";
          helpMessage += "\\n   - Verify ID format (GUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)";
        } else {
          helpMessage += "\\n- Is the Client Secret correct and not expired?";
          helpMessage += "\n- Is the Client ID (Azure) correct?";
          helpMessage += "\n- Is the Tenant ID correct?";
          helpMessage += "\\n- Are Application permissions correctly configured?";
        }
        errorMessage += helpMessage;
      }
      throw new Error(errorMessage);
    }
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const graphResponse = await fetch("https://graph.microsoft.com/v1.0/organization", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    if (!graphResponse.ok) {
      throw new Error(`Microsoft Graph API error: ${graphResponse.status}`);
    }
    const orgInfo = await graphResponse.json();
    let applicationDisplayName = null;
    try {
      const appResponse = await fetch(`https://graph.microsoft.com/v1.0/applications(appId='${cred.client_id_azure}')?$select=displayName`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      });
      if (appResponse.ok) {
        const appData = await appResponse.json();
        applicationDisplayName = appData.displayName;
      }
    } catch (e) {}
    res.json({
      success: true,
      message: "Successfully connected to Microsoft Graph API",
      organization: orgInfo.value?.[0]?.displayName || "Organisation inconnue",
      applicationDisplayName: applicationDisplayName
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Error testing connection"
    });
  }
});
router.get("/:clientId/secret-expiration", async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const result = await pool.query(`SELECT tenant_id, client_id_azure, secret_key_id
       FROM v_b_clients_azure
       WHERE client_id = $1`, [clientId]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No Office 365 credential configured for this client"
      });
    }
    const cred = result.rows[0];
    const office365Module = await import("../integrations/office365.js");
    const getClientOffice365Credentials = office365Module.getClientOffice365Credentials;
    const getOffice365Settings = office365Module.getOffice365Settings;
    const getMicrosoftGraphToken = office365Module.getMicrosoftGraphToken;
    let clientCredentials = await getClientOffice365Credentials(clientId);
    if (!clientCredentials) {
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
          error: "Credentials not configured"
        });
      }
    }
    const accessToken = await getMicrosoftGraphToken(clientCredentials.tenantId, clientCredentials.clientId, clientCredentials.clientSecret);
    const fetch = (await import("node-fetch")).default;
    let appResponse = await fetch(`https://graph.microsoft.com/v1.0/applications(appId='${cred.client_id_azure}')?$select=id,appId,displayName,passwordCredentials`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    if (!appResponse.ok && appResponse.status === 404) {
      appResponse = await fetch(`https://graph.microsoft.com/v1.0/applications/${cred.client_id_azure}?$select=id,appId,displayName,passwordCredentials`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      });
    }
    if (!appResponse.ok) {
      const errorText = await appResponse.text().catch(() => '');
      if (appResponse.status === 403) {
        return res.status(403).json({
          success: false,
          error: "Insufficient permission. Application.Read.All is required to retrieve the secret expiration date. Verify admin consent was granted."
        });
      }
      throw new Error(`Microsoft Graph API error: ${appResponse.status} - ${errorText}`);
    }
    const appData = await appResponse.json();
    const passwordCredentials = appData.passwordCredentials || [];
    let targetSecret = null;
    if (cred.secret_key_id) {
      targetSecret = passwordCredentials.find(secret => secret.keyId === cred.secret_key_id);
    }
    if (!targetSecret) {
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
        message: "No secret found for this application"
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
      error: error.message || "Error retrieving expiration date"
    });
  }
});
export default router;
