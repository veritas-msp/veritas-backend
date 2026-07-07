export function normalizeRmmAgentVersion(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function buildRmmAgentUpdateAction({ event = "update", previousVersion, newVersion } = {}) {
  const previous = normalizeRmmAgentVersion(previousVersion);
  const next = normalizeRmmAgentVersion(newVersion);

  if (event === "install") {
    return next ? `Agent RMM installé — ${next}` : "Agent RMM installé";
  }
  if (event === "re_enroll") {
    return next ? `Agent RMM ré-enrôlé — ${next}` : "Agent RMM ré-enrôlé";
  }
  if (previous && next && previous !== next) {
    return `Agent RMM mis à jour — ${previous} → ${next}`;
  }
  if (!previous && next) {
    return `Agent RMM mis à jour — ${next}`;
  }
  return null;
}

export async function logRmmAgentEquipmentActivity(
  pool,
  {
    clientId,
    equipmentName,
    equipmentId = null,
    action,
    details = {},
  }
) {
  if (!clientId || !equipmentName || !action) return;

  await pool.query(
    `INSERT INTO v_b_clients_m_logs
       (client_id, equipment_family, equipment_name, equipment_id, user_id, user_name, action, details)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)`,
    [
      clientId,
      "ordinateurs",
      equipmentName,
      equipmentId,
      "Agent RMM",
      action,
      JSON.stringify(details),
    ]
  );
}

export async function maybeLogRmmAgentVersionChange(
  pool,
  {
    clientId,
    equipmentName,
    equipmentId = null,
    previousVersion,
    newVersion,
    event = "update",
    source = "heartbeat",
    hostname = null,
    machineId = null,
  }
) {
  const previous = normalizeRmmAgentVersion(previousVersion);
  const next = normalizeRmmAgentVersion(newVersion);

  if (event === "update" && previous === next) return false;
  if (event === "update" && !next) return false;

  const action = buildRmmAgentUpdateAction({ event, previousVersion: previous, newVersion: next });
  if (!action) return false;

  await logRmmAgentEquipmentActivity(pool, {
    clientId,
    equipmentName,
    equipmentId,
    action,
    details: {
      kind: "rmm_agent_update",
      event,
      source,
      previousVersion: previous,
      newVersion: next,
      hostname: hostname || equipmentName || null,
      machineId: machineId || null,
    },
  });

  return true;
}

const HEARTBEAT_LOG_KIND = "rmm_heartbeat";
const HEARTBEAT_LOG_WINDOW = "1 hour";

function buildHeartbeatLogAction(heartbeatCount) {
  const count = Number(heartbeatCount) || 1;
  if (count <= 1) return "Heartbeat agent RMM";
  return `Agent RMM actif — ${count} signaux / 1 h`;
}

async function findOpenHeartbeatLog(pool, { clientId, equipmentName, equipmentId = null }) {
  const params = [clientId, HEARTBEAT_LOG_KIND];
  let equipmentMatch;

  if (equipmentId) {
    params.push(equipmentId);
    equipmentMatch = `equipment_id = $${params.length}`;
  } else {
    params.push(equipmentName);
    equipmentMatch = `equipment_name = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, details, created_at
     FROM v_b_clients_m_logs
     WHERE client_id = $1
       AND equipment_family = 'ordinateurs'
       AND ${equipmentMatch}
       AND details->>'kind' = $2
       AND created_at >= NOW() - INTERVAL '${HEARTBEAT_LOG_WINDOW}'
     ORDER BY created_at DESC
     LIMIT 1`,
    params
  );

  return result.rows[0] || null;
}

function parseLogDetails(value) {
  if (value == null) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function buildHeartbeatLogDetails({
  summary,
  agentVersion,
  hostname,
  machineId,
  inventory,
  syncRequested,
  heartbeatCount,
  periodStart,
  lastHeartbeatAt,
}) {
  const nowIso = lastHeartbeatAt || new Date().toISOString();
  return {
    kind: HEARTBEAT_LOG_KIND,
    mode: "light",
    agentVersion: normalizeRmmAgentVersion(agentVersion),
    hostname: hostname || null,
    machineId: machineId || null,
    collectedAt: inventory.collectedAt || inventory.lastInventoryAt || null,
    syncRequested: Boolean(syncRequested),
    heartbeatCount: Number(heartbeatCount) || 1,
    periodStart: periodStart || nowIso,
    lastHeartbeatAt: nowIso,
    ...summary,
  };
}

function summarizeRmmInventoryForLog(inventory = {}) {
  const updates = inventory.updates || {};
  const performance = inventory.performance || {};
  const os = inventory.os || {};
  const license = inventory.license || {};
  const pendingCount =
    updates.pendingCount ??
    (Array.isArray(updates.pendingItems) ? updates.pendingItems.length : null);

  let osEdition = license.edition || license.name || null;
  if (osEdition) {
    osEdition = String(osEdition)
      .replace(/^Windows\(R\),\s*/i, "")
      .replace(/\s+edition$/i, "")
      .trim();
  }
  if (!osEdition && os.editionId) {
    osEdition = String(os.editionId);
  }
  if (!osEdition && os.name) {
    const match = String(os.name).match(/Windows(?:\s+Server)?\s+[\d.]+\s+(.+?)(?:\s+\d+-bit)?$/i);
    if (match?.[1]) osEdition = match[1].trim();
  }

  return {
    pendingCount: pendingCount ?? null,
    rebootRequired: Boolean(updates.rebootRequired),
    cpuUsagePct: performance.cpuUsagePct ?? null,
    ramUsagePct: performance.ramUsagePct ?? null,
    loggedUser: inventory.loggedUser || inventory.session?.user || null,
    osEdition: osEdition || null,
    osDisplayVersion: os.displayVersion || null,
    osBuild: os.patchLabel || (os.build != null ? String(os.build) : null),
    osCaption: os.name || inventory.systeme || null,
    licenseActivated: license.activated ?? null,
  };
}

export async function logRmmHeartbeatActivity(
  pool,
  {
    clientId,
    equipmentName,
    equipmentId = null,
    inventory = {},
    agentVersion = null,
    hostname = null,
    machineId = null,
    syncRequested = false,
  }
) {
  const mode = inventory.inventoryMode === "full" ? "full" : "light";
  const isFullSync = mode === "full";
  const summary = summarizeRmmInventoryForLog(inventory);

  if (isFullSync) {
    await logRmmAgentEquipmentActivity(pool, {
      clientId,
      equipmentName,
      equipmentId,
      action: "Sync complet agent RMM",
      details: {
        kind: "rmm_full_sync",
        mode,
        agentVersion: normalizeRmmAgentVersion(agentVersion),
        hostname: hostname || equipmentName || null,
        machineId: machineId || null,
        collectedAt: inventory.collectedAt || inventory.lastInventoryAt || null,
        syncRequested: Boolean(syncRequested),
        ...summary,
      },
    });
    return true;
  }

  const existing = await findOpenHeartbeatLog(pool, {
    clientId,
    equipmentName,
    equipmentId,
  });
  const nowIso = new Date().toISOString();

  if (existing) {
    const previous = parseLogDetails(existing.details);
    const heartbeatCount = (Number(previous.heartbeatCount) || 1) + 1;
    const mergedDetails = buildHeartbeatLogDetails({
      summary,
      agentVersion,
      hostname: hostname || equipmentName || null,
      machineId,
      inventory,
      syncRequested,
      heartbeatCount,
      periodStart: previous.periodStart || existing.created_at,
      lastHeartbeatAt: nowIso,
    });

    await pool.query(
      `UPDATE v_b_clients_m_logs
       SET action = $1, details = $2
       WHERE id = $3`,
      [buildHeartbeatLogAction(heartbeatCount), JSON.stringify(mergedDetails), existing.id]
    );
    return true;
  }

  const details = buildHeartbeatLogDetails({
    summary,
    agentVersion,
    hostname: hostname || equipmentName || null,
    machineId,
    inventory,
    syncRequested,
    heartbeatCount: 1,
    periodStart: nowIso,
    lastHeartbeatAt: nowIso,
  });

  await logRmmAgentEquipmentActivity(pool, {
    clientId,
    equipmentName,
    equipmentId,
    action: buildHeartbeatLogAction(1),
    details,
  });

  return true;
}
