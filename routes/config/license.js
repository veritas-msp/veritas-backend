import express from "express";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { writeEnvFile, writeFrontendEnvFile } from "../../utils/envFile.js";
import { getEditionPayload } from "../../utils/edition.js";
import {
  getLicensePublicSummary,
  getLicenseAdminSummary,
  invalidateLicenseCache,
  isValidLicenseKeyFormat,
  normalizeLicenseKey,
  refreshProLicenseState,
} from "../../utils/proLicense.js";

const router = express.Router();

router.get("/", verifyJWT, requireRole("admin"), (_req, res) => {
  res.json(getLicenseAdminSummary());
});

router.post("/refresh", verifyJWT, requireRole("admin"), async (_req, res) => {
  await refreshProLicenseState();
  res.json(getLicenseAdminSummary());
});

router.post("/", verifyJWT, requireRole("admin"), async (req, res) => {
  const key = normalizeLicenseKey(req.body?.licenseKey || "");

  if (!key || !isValidLicenseKeyFormat(key)) {
    return res.status(400).json({
      error: "INVALID_LICENSE_FORMAT",
      message: "Format de clé invalide (attendu : VRT-PRO-XXXX-XXXX-XXXX-XXXX).",
    });
  }

  const previousKey = process.env.VERITAS_LICENSE_KEY;
  process.env.VERITAS_LICENSE_KEY = key;

  const state = await refreshProLicenseState();
  if (!state.valid) {
    if (previousKey) {
      process.env.VERITAS_LICENSE_KEY = previousKey;
    } else {
      delete process.env.VERITAS_LICENSE_KEY;
    }
    await refreshProLicenseState();
    return res.status(400).json({
      error: "LICENSE_INVALID",
      code: state.status,
      message: state.lastError || "Licence invalide ou abonnement inactif.",
    });
  }

  writeEnvFile({
    VERITAS_LICENSE_KEY: key,
    VERITAS_EDITION: "pro",
  });
  writeFrontendEnvFile({
    REACT_APP_VERITAS_EDITION: "pro",
  });

  invalidateLicenseCache();
  await refreshProLicenseState();

  res.json({
    ...getEditionPayload(),
    message:
      "Licence Pro activée. Rechargez l'application pour appliquer tous les modules frontend.",
  });
});

export default router;
