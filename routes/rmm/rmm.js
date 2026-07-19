import express from "express";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { rmmEnrollRateLimit } from "../../middleware/rateLimit.js";
import { generateRmmToken, hashRmmSecret, encryptRmmToken, mapEnrollmentTokenRow } from "../../utils/rmmCrypto.js";
import {
  fetchRmmSettings,
  fetchGlobalRmmSettings,
  saveRmmSettings,
  listClientRmmSettings,
  fetchClientRmmOverrides,
  saveClientRmmSettings,
  deleteClientRmmSettings,
  mergeRmmSettings,
  isAgentOnline,
} from "../../utils/rmmSettings.js";
import {
  assertCommunityRmmAgentLimit,
  sendCommunityLimitError,
} from "../../utils/communityLimits.js";
import { enableMonitoringAlertsForEquipment } from "../../utils/equipmentInventoryScan.js";
import { isCommunity } from "../../utils/edition.js";
import { requirePro } from "../../middleware/edition.js";
import {
  agentPackageAvailable,
  agentMsiAvailable,
  streamWindowsSetupScript,
  streamWindowsSetupMsi,
  streamWindowsSetupZip,
  WINDOWS_INSTALLER_VERSION,
  getWindowsInstallerFilenames,
} from "../../utils/rmmAgentPackage.js";
import { mergeRmmInventoryData } from "../../utils/rmmInventory.js";
import {
  fetchRmmMetricHistory,
  metricIdToName,
  recordRmmMetricsFromHeartbeat,
  resolveDimId,
  resolveMetricId,
  dimIdToDrive,
} from "../../utils/rmmMetrics.js";
import {
  estimateRmmMetricsStorage,
  fetchRmmMetricsStorageStats,
} from "../../utils/rmmMetricsStorage.js";
import { maybeLogRmmAgentVersionChange, logRmmHeartbeatActivity } from "../../utils/rmmEquipmentLog.js";
import {
  findUnlinkedManualEquipment,
  getAgentEquipmentFamily,
  normalizeEquipmentFamily,
} from "../../utils/rmmEquipmentMatch.js";

const router = express.Router();

/** Legacy name kept for route declarations — enforces rmm.manage (admin role bypasses). */
function requireAdmin(req, res, next) {
  return requirePermission("rmm.manage")(req, res, next);
}

async function verifyAgentAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Agent non authentifié" });
  }

  const secret = authHeader.slice(7).trim();
  if (!secret) {
    return res.status(401).json({ error: "Agent non authentifié" });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM v_b_rmm_agents
       WHERE secret_hash = $1 AND status = 'active'
       LIMIT 1`,
      [hashRmmSecret(secret)]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "Agent invalide ou révoqué" });
    }

    req.agent = result.rows[0];
    next();
  } catch (err) {
    console.error("[rmm] verifyAgentAuth:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
}

async function validateEnrollmentToken(token) {
  const tokenHash = hashRmmSecret(token);
  const result = await pool.query(
    `SELECT t.*, c.name AS client_name
     FROM v_b_rmm_enrollment_tokens t
     JOIN v_b_clients c ON c.id = t.client_id
     WHERE t.token_hash = $1
       AND t.revoked_at IS NULL
       AND (t.expires_at IS NULL OR t.expires_at > NOW())
     LIMIT 1`,
    [tokenHash]
  );

  const row = result.rows[0];
  if (!row) return { error: "Token d'enrôlement invalide ou expiré" };
  if (row.max_uses != null && row.uses_count >= row.max_uses) {
    return { error: "Token d'enrôlement épuisé" };
  }
  return { token: row };
}

async function upsertRmmEquipment(agent, inventory = {}, meta = {}) {
  const family = getAgentEquipmentFamily(agent);
  if (family === "serveurs") {
    return upsertServeur(agent, inventory, meta);
  }
  return upsertOrdinateur(agent, inventory, meta);
}

async function upsertOrdinateur(agent, inventory = {}, meta = {}) {
  const settings = await fetchRmmSettings(agent.client_id);
  const netbios =
    inventory.hostname ||
    meta.hostname ||
    agent.hostname ||
    inventory.computerName ||
    agent.machine_id;

  let existingRow = null;
  let linkMatchType = null;
  if (agent.ordinateur_id) {
    const byId = await pool.query(
      `SELECT id, name, data FROM v_b_clients_m_ordinateurs
       WHERE id = $1 AND client_id = $2
       LIMIT 1`,
      [agent.ordinateur_id, agent.client_id]
    );
    existingRow = byId.rows[0] || null;
  }
  if (!existingRow) {
    const byAgent = await pool.query(
      `SELECT id, name, data FROM v_b_clients_m_ordinateurs
       WHERE agent_id = $1
       LIMIT 1`,
      [agent.id]
    );
    existingRow = byAgent.rows[0] || null;
  }
  if (!existingRow) {
    const byKey = await pool.query(
      `SELECT id, name, data FROM v_b_clients_m_ordinateurs
       WHERE client_id = $1 AND item_key = $2
       LIMIT 1`,
      [agent.client_id, agent.machine_id]
    );
    existingRow = byKey.rows[0] || null;
  }
  if (!existingRow) {
    const manualMatch = await findUnlinkedManualEquipment(pool, {
      clientId: agent.client_id,
      table: "v_b_clients_m_ordinateurs",
      inventory,
      meta: { ...meta, hostname: netbios },
    });
    if (manualMatch) {
      existingRow = manualMatch;
      linkMatchType = manualMatch.matchType || "manual";
    }
  }

  const previousDataRaw = existingRow?.data || {};
  let previousData = previousDataRaw;
  if (previousData && typeof previousData === "string") {
    try {
      previousData = JSON.parse(previousData);
    } catch {
      previousData = {};
    }
  }
  if (!previousData || typeof previousData !== "object") {
    previousData = {};
  }
  const veritasName = String(previousData.nom || existingRow?.name || netbios || "").trim() || netbios;

  const data = mergeRmmInventoryData(previousData, inventory, {
    hostname: netbios,
    machineId: agent.machine_id,
    agentId: agent.id,
    agentVersion: meta.agentVersion || inventory.agentVersion || null,
  }, settings.collectors || {});

  data.nom = data.nom || veritasName;
  if (linkMatchType) {
    data.rmmLinkMatch = linkMatchType;
  }

  let ordinateurId;
  if (existingRow) {
    const result = await pool.query(
      `UPDATE v_b_clients_m_ordinateurs
       SET item_key = $1,
           name = $2,
           data = $3,
           agent_id = $4,
           is_active = true,
           updated_at = NOW()
       WHERE id = $5
       RETURNING id`,
      [agent.machine_id, veritasName, data, agent.id, existingRow.id]
    );
    ordinateurId = result.rows[0]?.id;
  } else {
    const result = await pool.query(
      `INSERT INTO v_b_clients_m_ordinateurs (client_id, item_key, name, data, agent_id, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id`,
      [agent.client_id, agent.machine_id, veritasName, data, agent.id]
    );
    ordinateurId = result.rows[0]?.id;
  }

  if (ordinateurId) {
    await pool.query(
      `UPDATE v_b_rmm_agents SET ordinateur_id = $1, updated_at = NOW() WHERE id = $2`,
      [ordinateurId, agent.id]
    );
  }

  return {
    id: ordinateurId,
    veritasName,
    netbios,
    equipmentFamily: "ordinateurs",
    linkMatchType,
  };
}

async function upsertServeur(agent, inventory = {}, meta = {}) {
  const settings = await fetchRmmSettings(agent.client_id);
  const netbios =
    inventory.hostname ||
    meta.hostname ||
    agent.hostname ||
    inventory.computerName ||
    agent.machine_id;

  let existingRow = null;
  let linkMatchType = null;
  if (agent.serveur_id) {
    const byId = await pool.query(
      `SELECT id, name, data FROM v_b_clients_m_servers
       WHERE id = $1 AND client_id = $2
       LIMIT 1`,
      [agent.serveur_id, agent.client_id]
    );
    existingRow = byId.rows[0] || null;
  }
  if (!existingRow) {
    const byAgent = await pool.query(
      `SELECT id, name, data FROM v_b_clients_m_servers
       WHERE agent_id = $1
       LIMIT 1`,
      [agent.id]
    );
    existingRow = byAgent.rows[0] || null;
  }
  if (!existingRow) {
    const byKey = await pool.query(
      `SELECT id, name, data FROM v_b_clients_m_servers
       WHERE client_id = $1 AND item_key = $2
       LIMIT 1`,
      [agent.client_id, agent.machine_id]
    );
    existingRow = byKey.rows[0] || null;
  }
  if (!existingRow) {
    const manualMatch = await findUnlinkedManualEquipment(pool, {
      clientId: agent.client_id,
      table: "v_b_clients_m_servers",
      inventory,
      meta: { ...meta, hostname: netbios },
    });
    if (manualMatch) {
      existingRow = manualMatch;
      linkMatchType = manualMatch.matchType || "manual";
    }
  }

  const previousDataRaw = existingRow?.data || {};
  let previousData = previousDataRaw;
  if (previousData && typeof previousData === "string") {
    try {
      previousData = JSON.parse(previousData);
    } catch {
      previousData = {};
    }
  }
  if (!previousData || typeof previousData !== "object") {
    previousData = {};
  }
  const veritasName = String(previousData.nom || existingRow?.name || netbios || "").trim() || netbios;

  const data = mergeRmmInventoryData(previousData, inventory, {
    hostname: netbios,
    machineId: agent.machine_id,
    agentId: agent.id,
    agentVersion: meta.agentVersion || inventory.agentVersion || null,
  }, settings.collectors || {});

  data.nom = data.nom || veritasName;
  if (linkMatchType) {
    data.rmmLinkMatch = linkMatchType;
  }

  let serveurId;
  if (existingRow) {
    const result = await pool.query(
      `UPDATE v_b_clients_m_servers
       SET item_key = $1,
           name = $2,
           data = $3,
           agent_id = $4,
           is_active = true,
           updated_at = NOW()
       WHERE id = $5
       RETURNING id`,
      [agent.machine_id, veritasName, data, agent.id, existingRow.id]
    );
    serveurId = result.rows[0]?.id;
  } else {
    const result = await pool.query(
      `INSERT INTO v_b_clients_m_servers (client_id, item_key, name, data, agent_id, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id`,
      [agent.client_id, agent.machine_id, veritasName, data, agent.id]
    );
    serveurId = result.rows[0]?.id;
  }

  if (serveurId) {
    await pool.query(
      `UPDATE v_b_rmm_agents SET serveur_id = $1, updated_at = NOW() WHERE id = $2`,
      [serveurId, agent.id]
    );
  }

  return {
    id: serveurId,
    veritasName,
    netbios,
    equipmentFamily: "serveurs",
    linkMatchType,
  };
}

// ─── Routes agent (without JWT user) ─────────────────────────────────────

router.post("/enroll", rmmEnrollRateLimit, async (req, res) => {
  try {
    const { enrollmentToken, machineId, hostname, agentVersion, equipmentFamily: rawFamily } = req.body || {};

    if (!enrollmentToken || !machineId) {
      return res.status(400).json({ error: "enrollmentToken et machineId requis" });
    }

    const equipmentFamily = normalizeEquipmentFamily(rawFamily);

    const validation = await validateEnrollmentToken(enrollmentToken);
    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const { token } = validation;
    const settings = await fetchRmmSettings(token.client_id);
    const agentSecret = generateRmmToken(32);
    const secretHash = hashRmmSecret(agentSecret);

    const existing = await pool.query(
      `SELECT id, status, agent_version FROM v_b_rmm_agents WHERE machine_id = $1 LIMIT 1`,
      [String(machineId)]
    );

    let agentRow;
    const familyConfig = JSON.stringify({ equipmentFamily });
    if (existing.rows.length) {
      const updated = await pool.query(
        `UPDATE v_b_rmm_agents
         SET client_id = $1,
             hostname = $2,
             secret_hash = $3,
             agent_version = $4,
             status = 'active',
             last_seen_at = NOW(),
             config = COALESCE(config, '{}'::jsonb) || $5::jsonb,
             updated_at = NOW()
         WHERE machine_id = $6
         RETURNING *`,
        [token.client_id, hostname || null, secretHash, agentVersion || null, familyConfig, String(machineId)]
      );
      agentRow = updated.rows[0];
    } else {
      await assertCommunityRmmAgentLimit(1);
      const inserted = await pool.query(
        `INSERT INTO v_b_rmm_agents (client_id, machine_id, hostname, secret_hash, agent_version, last_seen_at, config)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6::jsonb)
         RETURNING *`,
        [token.client_id, String(machineId), hostname || null, secretHash, agentVersion || null, familyConfig]
      );
      agentRow = inserted.rows[0];
    }

    await pool.query(
      `UPDATE v_b_rmm_enrollment_tokens SET uses_count = uses_count + 1 WHERE id = $1`,
      [token.id]
    );

    const equipmentName = hostname || agentRow.hostname || agentRow.machine_id;
    const upsertResult = await upsertRmmEquipment(agentRow, { hostname }, { agentVersion });
    const equipmentId = upsertResult?.id || null;

    try {
      await maybeLogRmmAgentVersionChange(pool, {
        clientId: agentRow.client_id,
        equipmentName: upsertResult?.veritasName || equipmentName,
        equipmentId: equipmentId,
        previousVersion: existing.rows.length ? existing.rows[0]?.agent_version : null,
        newVersion: agentVersion,
        event: existing.rows.length ? "re_enroll" : "install",
        source: "enroll",
        hostname: equipmentName,
        machineId: agentRow.machine_id,
        equipmentFamily: upsertResult?.equipmentFamily || equipmentFamily,
        linkMatchType: upsertResult?.linkMatchType || null,
      });
    } catch (logErr) {
      console.error("[rmm] enroll log:", logErr.message);
    }

    try {
      if (settings.alertsEnabledOnEnroll !== false && equipmentId) {
        await enableMonitoringAlertsForEquipment({
          clientId: agentRow.client_id,
          equipmentId,
          equipmentFamily: upsertResult?.equipmentFamily || equipmentFamily,
          equipmentName: upsertResult?.veritasName || equipmentName,
        });
      }
    } catch (alertErr) {
      console.error("[rmm] enroll alerts enable:", alertErr.message);
    }

    res.status(201).json({
      agentId: agentRow.id,
      clientId: agentRow.client_id,
      agentSecret,
      equipmentFamily: upsertResult?.equipmentFamily || equipmentFamily,
      equipmentId,
      linkMatchType: upsertResult?.linkMatchType || null,
      config: {
        heartbeatIntervalMinutes: settings.heartbeatIntervalMinutes,
        collectors: settings.collectors,
        equipmentFamily: upsertResult?.equipmentFamily || equipmentFamily,
      },
    });
  } catch (err) {
    if (err?.code?.startsWith("COMMUNITY_")) {
      return sendCommunityLimitError(res, err);
    }
    console.error("[rmm] enroll:", err.message);
    res.status(500).json({ error: "Erreur lors de l'enrôlement" });
  }
});

router.post("/heartbeat", verifyAgentAuth, async (req, res) => {
  try {
    const agent = req.agent;
    const { inventory, agentVersion, hostname } = req.body || {};
    const settings = await fetchRmmSettings(agent.client_id);
    const previousVersion = agent.agent_version;
    const resolvedHostname =
      inventory?.hostname ||
      hostname ||
      agent.hostname ||
      agent.machine_id;

    await pool.query(
      `UPDATE v_b_rmm_agents
       SET last_seen_at = NOW(),
           agent_version = COALESCE($1, agent_version),
           hostname = COALESCE($2, hostname),
           updated_at = NOW()
       WHERE id = $3`,
      [agentVersion || null, hostname || null, agent.id]
    );

    let equipmentId = agent.ordinateur_id || agent.serveur_id || null;
    let logEquipmentName = resolvedHostname;
    const syncRequested = Boolean(agent.config?.syncRequestedAt);
    if (inventory && typeof inventory === "object") {
      const upsertResult = await upsertRmmEquipment(agent, inventory, { agentVersion });
      equipmentId = upsertResult?.id || equipmentId;
      logEquipmentName = upsertResult?.veritasName || resolvedHostname;
      try {
        await logRmmHeartbeatActivity(pool, {
          clientId: agent.client_id,
          equipmentName: logEquipmentName,
          equipmentId: equipmentId,
          inventory,
          agentVersion: agentVersion || previousVersion,
          hostname: resolvedHostname,
          machineId: agent.machine_id,
          syncRequested,
        });
      } catch (logErr) {
        console.error("[rmm] heartbeat activity log:", logErr.message);
      }
      try {
        await maybeLogRmmAgentVersionChange(pool, {
          clientId: agent.client_id,
          equipmentName: logEquipmentName,
          equipmentId: equipmentId,
          previousVersion,
          newVersion: agentVersion || previousVersion,
          event: "update",
          source: "heartbeat",
          hostname: resolvedHostname,
          machineId: agent.machine_id,
        });
      } catch (logErr) {
        console.error("[rmm] heartbeat log:", logErr.message);
      }
      try {
        await recordRmmMetricsFromHeartbeat(agent, inventory, settings);
      } catch (metricsErr) {
        console.error("[rmm] metrics:", metricsErr.message);
      }
      if (inventory.inventoryMode === "full") {
        await pool.query(
          `UPDATE v_b_rmm_agents
           SET config = COALESCE(config, '{}'::jsonb) - 'syncRequestedAt',
               updated_at = NOW()
           WHERE id = $1 AND (config ? 'syncRequestedAt')`,
          [agent.id]
        );
      }
    }

    const fullSyncRequested = syncRequested;

    res.json({
      ok: true,
      config: {
        heartbeatIntervalMinutes: settings.heartbeatIntervalMinutes,
        collectors: settings.collectors,
        fullSyncRequested,
      },
    });
  } catch (err) {
    console.error("[rmm] heartbeat:", err.message);
    res.status(500).json({ error: "Erreur heartbeat" });
  }
});

// ─── Routes administration (JWT + admin) ─────────────────────────────────────

router.get("/settings", verifyJWT, requireAdmin, async (_req, res) => {
  try {
    const settings = await fetchGlobalRmmSettings();
    res.json(settings);
  } catch (err) {
    console.error("[rmm] get settings:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/settings", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const payload = { ...(req.body || {}) };
    if (isCommunity() && payload.collectors) {
      delete payload.collectors;
    }
    const settings = await saveRmmSettings(payload);
    res.json(settings);
  } catch (err) {
    console.error("[rmm] put settings:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/settings/metrics-storage", verifyJWT, requireAdmin, async (_req, res) => {
  try {
    const [stats, global] = await Promise.all([
      fetchRmmMetricsStorageStats(),
      fetchGlobalRmmSettings(),
    ]);
    const estimate = estimateRmmMetricsStorage({
      agentCount: stats.activeAgents || stats.agentCountWithData,
      retentionDays: global.metrics?.retentionDays,
      collectors: global.collectors,
      avgDisksPerAgent: stats.avgDisksPerAgent,
    });
    res.json({
      stats,
      estimate,
      settings: { metrics: global.metrics, collectors: global.collectors },
    });
  } catch (err) {
    console.error("[rmm] metrics storage:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/settings/clients", verifyJWT, requireAdmin, requirePro, async (_req, res) => {
  try {
    const items = await listClientRmmSettings();
    res.json(items);
  } catch (err) {
    console.error("[rmm] list client settings:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/settings/clients/:clientId", verifyJWT, requireAdmin, requirePro, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "clientId invalide" });

    const global = await fetchGlobalRmmSettings();
    const overrides = await fetchClientRmmOverrides(clientId);
    const effective = mergeRmmSettings(global, overrides);

    res.json({
      clientId,
      global,
      overrides,
      effective,
      hasCustomConfig: Boolean(overrides && Object.keys(overrides).length > 0),
    });
  } catch (err) {
    console.error("[rmm] get client settings:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/settings/clients/:clientId", verifyJWT, requireAdmin, requirePro, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "clientId invalide" });

    const { overrides, useCustom } = req.body || {};
    if (useCustom === false) {
      await deleteClientRmmSettings(clientId);
    } else {
      await saveClientRmmSettings(clientId, overrides || {}, req.user?.id || null);
    }

    const global = await fetchGlobalRmmSettings();
    const savedOverrides = await fetchClientRmmOverrides(clientId);
    res.json({
      clientId,
      global,
      overrides: savedOverrides,
      effective: mergeRmmSettings(global, savedOverrides),
      hasCustomConfig: Boolean(savedOverrides && Object.keys(savedOverrides).length > 0),
    });
  } catch (err) {
    console.error("[rmm] put client settings:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.delete("/settings/clients/:clientId", verifyJWT, requireAdmin, requirePro, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "clientId invalide" });
    await deleteClientRmmSettings(clientId);
    res.json({ success: true });
  } catch (err) {
    console.error("[rmm] delete client settings:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/enrollment-tokens", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const { clientId, status = "active" } = req.query;
    const params = [];
    let where =
      status === "revoked" ? "WHERE t.revoked_at IS NOT NULL" : "WHERE t.revoked_at IS NULL";

    if (clientId) {
      params.push(clientId);
      where += ` AND t.client_id = $${params.length}`;
    }

    const orderBy =
      status === "revoked" ? "ORDER BY t.revoked_at DESC NULLS LAST" : "ORDER BY t.created_at DESC";

    const result = await pool.query(
      `SELECT t.id, t.client_id, t.label, t.expires_at, t.max_uses, t.uses_count,
              t.created_at, t.revoked_at, t.token_encrypted, c.name AS client_name
       FROM v_b_rmm_enrollment_tokens t
       JOIN v_b_clients c ON c.id = t.client_id
       ${where}
       ${orderBy}`,
      params
    );

    res.json(result.rows.map(mapEnrollmentTokenRow));
  } catch (err) {
    console.error("[rmm] list tokens:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/enrollment-tokens", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const { clientId, label, expiresAt, maxUses } = req.body || {};
    if (!clientId) {
      return res.status(400).json({ error: "clientId requis" });
    }

    const plainToken = generateRmmToken(24);
    const tokenHash = hashRmmSecret(plainToken);
    const tokenEncrypted = encryptRmmToken(plainToken);

    const result = await pool.query(
      `INSERT INTO v_b_rmm_enrollment_tokens (client_id, token_hash, token_encrypted, label, expires_at, max_uses, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, client_id, label, expires_at, max_uses, uses_count, created_at, token_encrypted`,
      [
        clientId,
        tokenHash,
        tokenEncrypted,
        label || null,
        expiresAt || null,
        maxUses ?? null,
        req.user?.id || null,
      ]
    );

    res.status(201).json({
      ...mapEnrollmentTokenRow(result.rows[0]),
      token: plainToken,
    });
  } catch (err) {
    console.error("[rmm] create token:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/enrollment-tokens/:id/restore", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE v_b_rmm_enrollment_tokens
       SET revoked_at = NULL
       WHERE id = $1 AND revoked_at IS NOT NULL
       RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Token introuvable ou déjà actif" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[rmm] restore token:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.delete("/enrollment-tokens/:id/permanent", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM v_b_rmm_enrollment_tokens
       WHERE id = $1 AND revoked_at IS NOT NULL
       RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Token introuvable ou non présent dans la corbeille" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[rmm] delete token permanently:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.delete("/enrollment-tokens/:id", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE v_b_rmm_enrollment_tokens
       SET revoked_at = NOW()
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Token introuvable ou déjà révoqué" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[rmm] revoke token:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/agents", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const { clientId } = req.query;
    const params = [];
    let where = "WHERE a.status = 'active'";

    if (clientId) {
      params.push(clientId);
      where += ` AND a.client_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT a.id, a.client_id, a.machine_id, a.hostname, a.status,
              a.agent_version, a.last_seen_at, a.created_at, a.updated_at, a.config,
              c.name AS client_name
       FROM v_b_rmm_agents a
       JOIN v_b_clients c ON c.id = a.client_id
       ${where}
       ORDER BY a.last_seen_at DESC NULLS LAST`,
      params
    );

    const thresholdCache = new Map();
    const agents = [];
    for (const row of result.rows) {
      let threshold = thresholdCache.get(row.client_id);
      if (threshold == null) {
        const settings = await fetchRmmSettings(row.client_id);
        threshold = settings.offlineThresholdMinutes;
        thresholdCache.set(row.client_id, threshold);
      }
      agents.push({
        ...row,
        online: isAgentOnline(row.last_seen_at, threshold),
        sync_requested_at: row.config?.syncRequestedAt || null,
      });
    }

    res.json(agents);
  } catch (err) {
    console.error("[rmm] list agents:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/agents/:id/metrics/history", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const metricId = resolveMetricId(req.query.metric || "disk_used_pct");
    if (!metricId) {
      return res.status(400).json({ error: "Métrique invalide" });
    }

    const dimId = resolveDimId(req.query.dim);
    const days = req.query.days;

    const agentCheck = await pool.query(
      `SELECT id FROM v_b_rmm_agents WHERE id = $1 AND status = 'active' LIMIT 1`,
      [req.params.id]
    );
    if (!agentCheck.rows.length) {
      return res.status(404).json({ error: "Agent introuvable" });
    }

    const points = await fetchRmmMetricHistory(agentCheck.rows[0].id, {
      metricId,
      dimId,
      days,
    });

    res.json({
      agentId: agentCheck.rows[0].id,
      metric: metricIdToName(metricId),
      dim: dimId ? dimIdToDrive(dimId) : null,
      dimId,
      days: Math.min(730, Math.max(1, Number.parseInt(String(days), 10) || 90)),
      points,
    });
  } catch (err) {
    console.error("[rmm] metrics history:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/agents/:id/request-sync", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE v_b_rmm_agents
       SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('syncRequestedAt', to_jsonb(NOW()::text)),
           updated_at = NOW()
       WHERE id = $1 AND status = 'active'
       RETURNING id, config`,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Agent introuvable ou inactif" });
    }

    res.json({
      ok: true,
      sync_requested_at: result.rows[0].config?.syncRequestedAt || new Date().toISOString(),
    });
  } catch (err) {
    console.error("[rmm] request-sync:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/agents/:id/cancel-sync", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE v_b_rmm_agents
       SET config = COALESCE(config, '{}'::jsonb) - 'syncRequestedAt',
           updated_at = NOW()
       WHERE id = $1 AND status = 'active'
       RETURNING id, config, ordinateur_id`,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Agent introuvable ou inactif" });
    }

    const ordinateurId = result.rows[0].ordinateur_id;
    if (ordinateurId) {
      await pool.query(
        `UPDATE v_b_clients_m_ordinateurs
         SET data = COALESCE(data, '{}'::jsonb)
           - 'syncRequestedAt'
           - 'sync_requested_at'
           - 'Sync_requested_at'
           - 'SyncRequestedAt',
             updated_at = NOW()
         WHERE id = $1`,
        [ordinateurId]
      );
    }

    res.json({
      ok: true,
      sync_requested_at: null,
    });
  } catch (err) {
    console.error("[rmm] cancel-sync:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.patch("/agents/:id", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["active", "revoked"].includes(status)) {
      return res.status(400).json({ error: "status invalide (active|revoked)" });
    }

    if (status === "active") {
      const existing = await pool.query(
        `SELECT status FROM v_b_rmm_agents WHERE id = $1 LIMIT 1`,
        [req.params.id]
      );
      if (existing.rows[0]?.status !== "active") {
        await assertCommunityRmmAgentLimit(1);
      }
    }

    const result = await pool.query(
      `UPDATE v_b_rmm_agents SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Agent introuvable" });
    }

    if (status === "revoked") {
      await pool.query(
        `UPDATE v_b_clients_m_ordinateurs
         SET is_active = false, agent_id = NULL, updated_at = NOW()
         WHERE agent_id = $1`,
        [req.params.id]
      );
      await pool.query(
        `UPDATE v_b_clients_m_servers
         SET agent_id = NULL, updated_at = NOW()
         WHERE agent_id = $1`,
        [req.params.id]
      );
      await pool.query(
        `UPDATE v_b_rmm_agents
         SET ordinateur_id = NULL, serveur_id = NULL, updated_at = NOW()
         WHERE id = $1`,
        [req.params.id]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    if (err?.code?.startsWith("COMMUNITY_")) {
      return sendCommunityLimitError(res, err);
    }
    console.error("[rmm] patch agent:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/agent/installer-info", verifyJWT, requireAdmin, (_req, res) => {
  try {
    const names = getWindowsInstallerFilenames();
    res.json({
      version: WINDOWS_INSTALLER_VERSION,
      filenames: names,
      cmdAvailable: agentPackageAvailable(),
      zipAvailable: agentPackageAvailable(),
      msiAvailable: agentMsiAvailable() || process.platform === "win32",
    });
  } catch (err) {
    console.error("[rmm] installer-info:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/agent/download/windows", verifyJWT, requireAdmin, (req, res) => {
  try {
    if (!agentPackageAvailable()) {
      return res.status(404).json({ error: "Package agent Windows indisponible" });
    }
    streamWindowsSetupScript(res);
  } catch (err) {
    console.error("[rmm] download windows setup:", err.message);
    res.status(500).json({ error: "Erreur lors du téléchargement" });
  }
});

router.get("/agent/download/windows/zip", verifyJWT, requireAdmin, (req, res) => {
  try {
    if (!agentPackageAvailable()) {
      return res.status(404).json({ error: "Package agent Windows indisponible" });
    }
    streamWindowsSetupZip(res);
  } catch (err) {
    console.error("[rmm] download windows zip:", err.message);
    res.status(500).json({ error: "Erreur lors du téléchargement" });
  }
});

router.get("/agent/download/windows/msi", verifyJWT, requireAdmin, (req, res) => {
  try {
    streamWindowsSetupMsi(res);
  } catch (err) {
    if (!res.headersSent) {
      const status = err.message?.includes("indisponible") || err.message?.includes("WiX") ? 404 : 500;
      console.error("[rmm] download windows msi:", err.message);
      return res.status(status).json({
        error: err.message || "Erreur lors du téléchargement",
      });
    }
    res.end();
  }
});

export default router;
