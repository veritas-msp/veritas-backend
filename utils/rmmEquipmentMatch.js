export function normalizeMac(value) {
  if (!value) return "";
  return String(value).replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}
export function normalizeSerial(value) {
  if (!value) return "";
  return String(value).trim().toUpperCase();
}
export function parseEquipmentData(data) {
  let parsed = data;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = {};
    }
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}
export function equipmentDataSerial(data) {
  const parsed = parseEquipmentData(data);
  return normalizeSerial(parsed.numeroSerie || parsed.serial || parsed.serialNumber || parsed.chassis?.serial || parsed.chassis?.serialNumber);
}
export function equipmentDataMac(data) {
  const parsed = parseEquipmentData(data);
  return normalizeMac(parsed.mac || parsed.adresseMac || parsed.macAddress || parsed.network?.mac);
}
export function extractInventoryIdentifiers(inventory = {}, meta = {}) {
  const chassis = inventory.chassis || {};
  const network = inventory.network || {};
  const serial = normalizeSerial(chassis.serial || chassis.serialNumber || inventory.numeroSerie || inventory.serial || meta.serial);
  const mac = normalizeMac(network.mac || inventory.mac || inventory.adresseMac || meta.mac);
  const hostname = String(inventory.hostname || inventory.computerName || meta.hostname || "").trim().toLowerCase();
  return {
    serial,
    mac,
    hostname
  };
}
export function normalizeEquipmentFamily(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "serveurs" || raw === "serveur" || raw === "servers" || raw === "server") {
    return "serveurs";
  }
  return "ordinateurs";
}
export function getAgentEquipmentFamily(agent) {
  return normalizeEquipmentFamily(agent?.config?.equipmentFamily);
}
export function findManualEquipmentMatch(rows, identifiers) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const {
    serial,
    mac,
    hostname
  } = identifiers;
  if (serial) {
    const bySerial = rows.filter(row => equipmentDataSerial(row.data) === serial);
    if (bySerial.length === 1) return {
      row: bySerial[0],
      matchType: "serial"
    };
  }
  if (mac) {
    const byMac = rows.filter(row => equipmentDataMac(row.data) === mac);
    if (byMac.length === 1) return {
      row: byMac[0],
      matchType: "mac"
    };
  }
  if (hostname) {
    const byName = rows.filter(row => {
      const data = parseEquipmentData(row.data);
      const candidates = [String(row.name || "").trim().toLowerCase(), String(data.nom || "").trim().toLowerCase(), String(data.netbios || "").trim().toLowerCase(), String(data.hostname || "").trim().toLowerCase()].filter(Boolean);
      return candidates.includes(hostname);
    });
    if (byName.length === 1) return {
      row: byName[0],
      matchType: "name"
    };
  }
  return null;
}
export async function findUnlinkedManualEquipment(pool, {
  clientId,
  table,
  inventory,
  meta
}) {
  const identifiers = extractInventoryIdentifiers(inventory, meta);
  if (!identifiers.serial && !identifiers.mac && !identifiers.hostname) {
    return null;
  }
  const result = await pool.query(`SELECT id, name, data
     FROM ${table}
     WHERE client_id = $1
       AND agent_id IS NULL
       AND COALESCE(is_active, true) = true`, [clientId]);
  const match = findManualEquipmentMatch(result.rows, identifiers);
  return match ? {
    ...match.row,
    matchType: match.matchType
  } : null;
}
