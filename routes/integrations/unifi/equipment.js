import express from "express";
import fetch from "node-fetch";
import verifyJWT from "../../../middleware/auth.js";

const router = express.Router();

async function createHttpsAgent(rejectUnauthorized) {
  const https = await import("https");
  return new https.Agent({ rejectUnauthorized: rejectUnauthorized !== false });
}

function normalizeUnifiHost(host) {
  let value = String(host || "").trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, "");
}

router.post("/equipment-test", verifyJWT, async (req, res) => {
  try {
    const { host, apiKey, rejectUnauthorized = false } = req.body || {};

    const baseUrl = normalizeUnifiHost(host);
    const key = String(apiKey || "").trim();

    if (!baseUrl || !key) {
      return res.status(400).json({
        success: false,
        error: "URL du contrôleur et clé API requises",
      });
    }

    const testUrl = `${baseUrl}/proxy/network/api/s/default/self`;
    const agent = await createHttpsAgent(rejectUnauthorized);

    const response = await fetch(testUrl, {
      method: "GET",
      headers: {
        "X-API-KEY": key,
        Accept: "application/json",
      },
      agent,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      let errorMessage = "Connexion à l'API UniFi locale échouée";
      if (response.status === 401) errorMessage = "Clé API invalide ou expirée";
      else if (response.status === 403) errorMessage = "Accès refusé — vérifiez les permissions de la clé API";
      else if (response.status === 404) {
        errorMessage = "Endpoint introuvable — vérifiez l'URL du contrôleur (UDM Pro / UniFi OS)";
      }

      return res.status(400).json({
        success: false,
        error: errorMessage,
        details: payload?.meta?.msg || payload?.message || `HTTP ${response.status}`,
      });
    }

    return res.json({
      success: true,
      message: "Connexion API UniFi réussie",
      controller: {
        host: baseUrl,
        site: payload?.data?.[0]?.name || payload?.data?.name || "default",
        admin: payload?.data?.[0]?.admin_name || payload?.data?.admin_name || null,
      },
    });
  } catch (err) {
    console.error("POST /unifi/equipment-test:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur lors du test de connexion UniFi",
      details: err.message,
    });
  }
});

export default router;
