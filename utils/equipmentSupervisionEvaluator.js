import { getExpirationStatus, getMaintenanceLicenceExpiration } from "./equipmentExpirationUtils.js";
const CHECKMK_MAPPABLE_FAMILIES = new Set(["servers", "stockage", "firewall", "switch", "wifi", "routeur", "internet", "toip", "alimentation"]);
const WARRANTY_FAMILIES = new Set(["firewall", "servers", "stockage"]);
const NETWORK_IP_FAMILIES = new Set(["firewall", "switch", "routeur", "servers", "wifi", "toip"]);
function readDataField(data, ...keys) {
  if (!data || typeof data !== "object") return null;
  for (const key of keys) {
    if (data[key] != null && data[key] !== "") return data[key];
  }
  return null;
}
function isRmmManaged(data, agentId) {
  return Boolean(agentId || data?.source === "rmm" || data?.agentId || data?.agent_id);
}
export function isEquipmentMonitoredInventoryItem({
  agentId = null,
  data = {},
  isMkMapped = false
} = {}) {
  if (isMkMapped) return true;
  if (isRmmManaged(data, agentId)) return true;
  if (data?.checkmk_host_name || data?.checkmkHostName) return true;
  return false;
}
function getWorstDiskUsage(data) {
  const disks = data?.disks || data?.storage || data?.volumes || data?.hardware?.disks;
  if (!Array.isArray(disks)) return null;
  let worst = null;
  for (const disk of disks) {
    const total = Number(disk?.totalGb ?? disk?.total_gb ?? disk?.sizeGb ?? 0);
    const used = Number(disk?.usedGb ?? disk?.used_gb ?? disk?.used ?? 0);
    let pct = Number(disk?.usedPct ?? disk?.used_pct ?? disk?.percent ?? NaN);
    if (!Number.isFinite(pct) && total > 0) pct = Math.round(used / total * 100);
    if (!Number.isFinite(pct)) continue;
    if (!worst || pct > worst.pct) {
      worst = {
        pct,
        drive: disk?.drive || disk?.mount || disk?.label || disk?.name || null
      };
    }
  }
  return worst;
}
function getWindowsUpdatePendingCount(data) {
  const updates = data?.updates || data?.windowsUpdates || data?.windows_updates;
  if (!updates || typeof updates !== "object") return 0;
  const pending = updates.pending ?? updates.pendingCount ?? updates.count;
  const n = Number(pending);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function getLastInventoryAt(data, lastSeenAt) {
  return data?.lastInventoryAt || data?.collectedAt || data?.last_inventory_at || lastSeenAt || null;
}
function isAgentOfflineForAlert(data, lastSeenAt, offlineAlertThresholdMinutes) {
  if (!isRmmManaged(data, data?.agentId || data?.agent_id)) return false;
  const lastAt = getLastInventoryAt(data, lastSeenAt);
  if (!lastAt) return false;
  const ageMs = Date.now() - new Date(lastAt).getTime();
  if (!Number.isFinite(ageMs)) return false;
  const thresholdMs = Math.max(1, offlineAlertThresholdMinutes) * 60 * 1000;
  return ageMs >= thresholdMs;
}
function pushCriterion(criteria, key, detail = null) {
  criteria.push({
    key,
    detail
  });
}
export function evaluateEquipmentSupervisionCriteria({
  equipmentFamily,
  data = {},
  name = "",
  ip = null,
  agentId = null,
  lastSeenAt = null,
  checkmkSummary = null,
  isMkMapped = false,
  offlineAlertThresholdMinutes = 2880,
  thresholds = null
}) {
  const criteria = [];
  const family = String(equipmentFamily || "").toLowerCase();
  const d = data && typeof data === "object" ? data : {};
  const monitored = isEquipmentMonitoredInventoryItem({
    agentId,
    data: d,
    isMkMapped
  });
  const t = {
    offlineAlertThresholdMinutes: thresholds?.offlineAlertThresholdMinutes ?? offlineAlertThresholdMinutes ?? 2880,
    diskCriticalPercent: thresholds?.diskCriticalPercent ?? 90,
    diskWarnPercent: thresholds?.diskWarnPercent ?? 80,
    updatesMinPending: thresholds?.updatesMinPending ?? 1,
    warrantySoonDays: thresholds?.warrantySoonDays ?? 30,
    maintenanceSoonDays: thresholds?.maintenanceSoonDays ?? 30,
    batterySoonDays: thresholds?.batterySoonDays ?? 30
  };
  const mkStatus = checkmkSummary?.status || "no_data";
  if (family === "ordinateurs") {
    if (isRmmManaged(d, agentId)) {
      if (isAgentOfflineForAlert(d, lastSeenAt, t.offlineAlertThresholdMinutes)) {
        pushCriterion(criteria, "agent_offline");
      }
      const pendingUpdates = getWindowsUpdatePendingCount(d);
      if (pendingUpdates >= t.updatesMinPending) {
        pushCriterion(criteria, "updates_pending", {
          pendingCount: pendingUpdates
        });
      }
      const worstDisk = getWorstDiskUsage(d);
      if ((worstDisk?.pct ?? 0) >= t.diskCriticalPercent) {
        pushCriterion(criteria, "disk_critical", worstDisk);
      } else if ((worstDisk?.pct ?? 0) >= t.diskWarnPercent) {
        pushCriterion(criteria, "disk_warn", worstDisk);
      }
    }
    return criteria;
  }
  if (CHECKMK_MAPPABLE_FAMILIES.has(family)) {
    if (isMkMapped && monitored) {
      if (mkStatus === "critical") pushCriterion(criteria, "monitor_critical", checkmkSummary);else if (mkStatus === "warning") pushCriterion(criteria, "monitor_warning", checkmkSummary);else if (mkStatus === "no_data") pushCriterion(criteria, "no_data");
    } else if (!isMkMapped) {
      pushCriterion(criteria, "unmapped");
    }
  }
  if (!monitored) {
    return criteria;
  }
  if (WARRANTY_FAMILIES.has(family)) {
    const serverType = String(d.typeServer || d.type || "").toLowerCase();
    const skipWarranty = family === "servers" && serverType === "virtuel";
    if (!skipWarranty) {
      const warrantyDate = readDataField(d, "expirationGarantie", "expiration_garantie");
      const warrantyStatus = getExpirationStatus(warrantyDate, t.warrantySoonDays);
      if (warrantyStatus === "expired") pushCriterion(criteria, "warranty_expired", {
        date: warrantyDate
      });else if (warrantyStatus === "soon") pushCriterion(criteria, "warranty_soon", {
        date: warrantyDate
      });
    }
  }
  if (family === "firewall") {
    const licences = d.licences || [];
    const maintDate = getMaintenanceLicenceExpiration(licences);
    const maintStatus = getExpirationStatus(maintDate, t.maintenanceSoonDays);
    if (maintStatus === "expired") pushCriterion(criteria, "maintenance_expired", {
      date: maintDate
    });else if (maintStatus === "soon") pushCriterion(criteria, "maintenance_soon", {
      date: maintDate
    });
  }
  if (family === "alimentation") {
    const batteryDate = readDataField(d, "dateBatterie", "date_batterie");
    const batteryStatus = getExpirationStatus(batteryDate, t.batterySoonDays);
    if (batteryStatus === "expired") pushCriterion(criteria, "battery_expired", {
      date: batteryDate
    });else if (batteryStatus === "soon") pushCriterion(criteria, "battery_soon", {
      date: batteryDate
    });
  }
  const resolvedIp = ip || readDataField(d, "ip");
  const ipNonFixe = readDataField(d, "ipNonFixe", "ip_non_fixe");
  if (NETWORK_IP_FAMILIES.has(family) && !resolvedIp && !ipNonFixe) {
    pushCriterion(criteria, "missing_ip");
  }
  return criteria;
}
export function criteriaToActiveMap(criteria = []) {
  const map = {};
  for (const item of criteria) {
    if (item?.key) map[item.key] = true;
  }
  return map;
}
export function diffCriteriaTransitions(previousMap = {}, activeMap = {}) {
  const activated = [];
  const resolved = [];
  for (const [key, active] of Object.entries(activeMap)) {
    if (active && !previousMap[key]) activated.push(key);
  }
  for (const [key, wasActive] of Object.entries(previousMap)) {
    if (wasActive && !activeMap[key]) resolved.push(key);
  }
  return {
    activated,
    resolved
  };
}
