import express from 'express';
import fetch from 'node-fetch';
import { pool } from '../../../database/db.js';
import verifyJWT from '../../../middleware/auth.js';
const router = express.Router();
const TABLE = 'v_b_equipment_checkmk_monitoring';
const SYNC_MIN_INTERVAL_MS = 30 * 60 * 1000;
const RECENT_ALERT_DAYS = 7;
function getEventTimeMs(event) {
  const raw = event?.time ?? event?.log_time ?? event?.timestamp ?? event?.event_time ?? event?.created ?? null;
  if (raw == null) return null;
  const num = Number(raw);
  if (!Number.isNaN(num)) return num < 1e12 ? num * 1000 : num;
  const d = new Date(String(raw).trim().replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
function parseEventStateRaw(rawState) {
  if (typeof rawState === 'number') return rawState;
  if (typeof rawState === 'string') {
    const match = rawState.match(/\((OK|WARNING|CRITICAL|UNKNOWN)\)/i) || rawState.match(/\b(OK|WARNING|CRITICAL|UNKNOWN)\b/i);
    if (match) {
      const s = match[1].toUpperCase();
      if (s === 'OK') return 0;
      if (s === 'WARNING') return 1;
      if (s === 'CRITICAL') return 2;
      return 3;
    }
    const n = parseInt(rawState, 10);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}
function getEventStateNum(event) {
  if (typeof event?.state === 'number') return event.state;
  if (event?.state != null && typeof event.state !== 'number') return parseEventStateRaw(event.state);
  if (typeof event?.state_info === 'number') return event.state_info;
  if (event?.state_info != null) return parseEventStateRaw(event.state_info);
  if (Array.isArray(event)) return parseEventStateRaw(event[5]);
  if (event?.raw && Array.isArray(event.raw)) return parseEventStateRaw(event.raw[5]);
  return 0;
}
function isAlertEvent(event) {
  const state = getEventStateNum(event);
  return state === 1 || state === 2;
}
export function computeMonitoringSummary(monitoringData, lastSyncedAt) {
  if (!monitoringData || typeof monitoringData !== 'object') {
    return {
      status: 'no_data',
      critServices: 0,
      warnServices: 0,
      recentAlerts: 0,
      recentCritAlerts: 0,
      recentWarnAlerts: 0,
      lastSyncedAt: lastSyncedAt || null
    };
  }
  const services = monitoringData?.services?.services || [];
  const events = monitoringData?.events?.events || [];
  const critServices = services.filter(s => (s.state ?? 3) === 2).length;
  const warnServices = services.filter(s => (s.state ?? 3) === 1).length;
  const cutoff = Date.now() - RECENT_ALERT_DAYS * 24 * 60 * 60 * 1000;
  const recentAlertEvents = events.filter(e => {
    if (!isAlertEvent(e)) return false;
    const t = getEventTimeMs(e);
    return t != null && t >= cutoff;
  });
  const recentCritAlerts = recentAlertEvents.filter(e => getEventStateNum(e) === 2).length;
  const recentWarnAlerts = recentAlertEvents.filter(e => getEventStateNum(e) === 1).length;
  let status = 'ok';
  if (critServices > 0 || recentCritAlerts > 0) status = 'critical';else if (warnServices > 0 || recentWarnAlerts > 0) status = 'warning';
  return {
    status,
    critServices,
    warnServices,
    recentAlerts: recentAlertEvents.length,
    recentCritAlerts,
    recentWarnAlerts,
    lastSyncedAt: lastSyncedAt || null
  };
}
const INTERNAL_BASE = `http://127.0.0.1:${process.env.PORT || 3001}`;
const EQUIPMENT_FAMILY_TABLES = {
  servers: 'v_b_clients_m_servers',
  stockage: 'v_b_clients_m_stockage',
  nas: 'v_b_clients_m_stockage',
  firewall: 'v_b_clients_m_firewall',
  switch: 'v_b_clients_m_switch',
  wifi: 'v_b_clients_m_wifi',
  alimentation: 'v_b_clients_m_alimentation',
  routeur: 'v_b_clients_m_routeur',
  toip: 'v_b_clients_m_toip'
};
async function internalCheckMKGet(req, path, query = {}) {
  const url = new URL(`${INTERNAL_BASE}/api/checkmk${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = {
    Accept: 'application/json'
  };
  if (req.headers.cookie) headers.Cookie = req.headers.cookie;
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  const res = await fetch(url.toString(), {
    headers
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`[checkmk equipment-sync] ${path} → ${res.status}: ${text.slice(0, 150)}`);
    return null;
  }
  return res.json();
}
function getAvailabilityPeriodRange(periodKey) {
  const endTime = new Date();
  endTime.setHours(23, 59, 59, 999);
  const startTime = new Date(endTime);
  if (periodKey === '1m') startTime.setMonth(startTime.getMonth() - 1);else if (periodKey === '3m') startTime.setMonth(startTime.getMonth() - 3);else if (periodKey === '1y') startTime.setFullYear(startTime.getFullYear() - 1);
  startTime.setHours(0, 0, 0, 0);
  return {
    startTime,
    endTime
  };
}
function eventDedupeKey(event) {
  if (event?.id != null && event.id !== '') return `id:${event.id}`;
  if (event?.event_id != null) return `eid:${event.event_id}`;
  const t = event?.time ?? event?.timestamp ?? event?.log_time ?? '';
  const svc = event?.service ?? event?.log_service_description ?? '';
  const msg = event?.message ?? event?.event_text ?? event?.plugin_output ?? '';
  return `t:${t}|s:${svc}|m:${String(msg).slice(0, 80)}`;
}
function mergeEventLists(existing = [], incoming = []) {
  const map = new Map();
  for (const e of existing) map.set(eventDedupeKey(e), e);
  for (const e of incoming) map.set(eventDedupeKey(e), e);
  return [...map.values()];
}
function rowToResponse(row, availabilityPeriod = '1m') {
  if (!row) return null;
  const monitoringData = row.monitoring_data || {};
  const availabilityByPeriod = monitoringData.availabilityByPeriod || {};
  return {
    equipmentId: row.equipment_id,
    clientId: row.client_id,
    equipmentFamily: row.equipment_family,
    checkmkHostName: row.checkmk_host_name,
    checkmkSite: row.checkmk_site,
    lastSyncedAt: row.last_synced_at,
    hostDetails: row.host_details || null,
    checkmkData: {
      services: monitoringData.services || null,
      events: monitoringData.events || null,
      availability: availabilityByPeriod[availabilityPeriod] ?? monitoringData.availability ?? null,
      hostEventsDetailed: monitoringData.hostEventsDetailed || null,
      availabilityByPeriod
    },
    availabilityByPeriod
  };
}
async function getStoredMonitoring(equipmentId) {
  const r = await pool.query(`SELECT * FROM ${TABLE} WHERE equipment_id = $1::uuid`, [equipmentId]);
  return r.rows[0] || null;
}
async function verifyEquipmentMapping(equipmentId, clientId, family, hostName) {
  const table = EQUIPMENT_FAMILY_TABLES[family];
  if (!table) return false;
  const r = await pool.query(`SELECT id, checkmk_host_name FROM ${table}
     WHERE id = $1::uuid AND client_id = $2 AND checkmk_host_name = $3`, [equipmentId, clientId, hostName]);
  return r.rows.length > 0;
}
async function fetchAndMergeCheckMKData(req, {
  hostName,
  site,
  existingMonitoringData,
  incrementalFrom
}) {
  const now = new Date();
  const eventsEndTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  const eventsStartTime = incrementalFrom ? new Date(new Date(incrementalFrom).getTime() - 24 * 60 * 60 * 1000) : (() => {
    const d = new Date(eventsEndTime);
    d.setFullYear(d.getFullYear() - 10);
    d.setHours(0, 0, 0, 0);
    return d;
  })();
  const siteParam = site || null;
  const queryBase = {
    site: siteParam
  };
  const [services, events, hostDetails, hostEventsDetailed, avail1m, avail3m, avail1y] = await Promise.all([internalCheckMKGet(req, `/services/${encodeURIComponent(hostName)}`, {
    ...queryBase,
    start_time: eventsStartTime.toISOString(),
    end_time: eventsEndTime.toISOString()
  }), internalCheckMKGet(req, `/events-period/${encodeURIComponent(hostName)}`, {
    ...queryBase,
    start_time: eventsStartTime.toISOString(),
    end_time: eventsEndTime.toISOString()
  }), internalCheckMKGet(req, `/host/${encodeURIComponent(hostName)}`, queryBase), internalCheckMKGet(req, `/host-events/${encodeURIComponent(hostName)}`, {
    ...queryBase,
    start_time: eventsStartTime.toISOString(),
    end_time: eventsEndTime.toISOString()
  }), (async () => {
    const {
      startTime,
      endTime
    } = getAvailabilityPeriodRange('1m');
    const data = await internalCheckMKGet(req, `/availability-table/${encodeURIComponent(hostName)}`, {
      ...queryBase,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString()
    });
    return data?.availability ?? null;
  })(), (async () => {
    const {
      startTime,
      endTime
    } = getAvailabilityPeriodRange('3m');
    const data = await internalCheckMKGet(req, `/availability-table/${encodeURIComponent(hostName)}`, {
      ...queryBase,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString()
    });
    return data?.availability ?? null;
  })(), (async () => {
    const {
      startTime,
      endTime
    } = getAvailabilityPeriodRange('1y');
    const data = await internalCheckMKGet(req, `/availability-table/${encodeURIComponent(hostName)}`, {
      ...queryBase,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString()
    });
    return data?.availability ?? null;
  })()]);
  const prev = existingMonitoringData || {};
  const mergedEvents = events ? {
    ...events,
    events: mergeEventLists(prev.events?.events || [], events.events || []),
    events_count: mergeEventLists(prev.events?.events || [], events.events || []).length
  } : prev.events || null;
  const mergedHostEvents = hostEventsDetailed ? {
    ...hostEventsDetailed,
    events: mergeEventLists(prev.hostEventsDetailed?.events || [], hostEventsDetailed.events || []),
    events_count: mergeEventLists(prev.hostEventsDetailed?.events || [], hostEventsDetailed.events || []).length
  } : prev.hostEventsDetailed || null;
  const availabilityByPeriod = {
    ...(prev.availabilityByPeriod || {}),
    ...(avail1m != null ? {
      '1m': avail1m
    } : {}),
    ...(avail3m != null ? {
      '3m': avail3m
    } : {}),
    ...(avail1y != null ? {
      '1y': avail1y
    } : {})
  };
  return {
    monitoringData: {
      services: services || prev.services || null,
      events: mergedEvents,
      hostEventsDetailed: mergedHostEvents,
      availabilityByPeriod,
      availability: availabilityByPeriod['1m'] ?? prev.availability ?? null
    },
    hostDetails: hostDetails || prev.hostDetails || null
  };
}
export async function runEquipmentMonitoringSync(req, {
  equipmentId,
  clientId,
  family,
  hostName,
  site,
  force = false,
  availabilityPeriod = '1m'
}) {
  if (!equipmentId || !clientId || !family || !hostName) {
    throw new Error('Missing parameters: equipmentId, clientId, family, hostName are required.');
  }
  const isMapped = await verifyEquipmentMapping(equipmentId, clientId, family, hostName);
  if (!isMapped) {
    throw new Error('Equipment not found or not mapped to this CheckMK host.');
  }
  const existing = await getStoredMonitoring(equipmentId);
  if (!force && existing?.last_synced_at) {
    const lastSyncMs = new Date(existing.last_synced_at).getTime();
    if (!Number.isNaN(lastSyncMs) && Date.now() - lastSyncMs < SYNC_MIN_INTERVAL_MS) {
      return {
        ...rowToResponse(existing, availabilityPeriod),
        skipped: true,
        message: 'Recent synchronization (< 30 min), using database data.'
      };
    }
  }
  const {
    monitoringData,
    hostDetails
  } = await fetchAndMergeCheckMKData(req, {
    hostName,
    site,
    existingMonitoringData: existing?.monitoring_data || {},
    incrementalFrom: existing?.last_synced_at || null
  });
  const nowIso = new Date().toISOString();
  if (existing) {
    await pool.query(`UPDATE ${TABLE}
       SET monitoring_data = $1::jsonb,
           host_details = $2::jsonb,
           checkmk_host_name = $3,
           checkmk_site = $4,
           last_synced_at = $5::timestamptz,
           updated_at = NOW()
       WHERE equipment_id = $6::uuid`, [JSON.stringify(monitoringData), hostDetails ? JSON.stringify(hostDetails) : null, hostName, site || null, nowIso, equipmentId]);
  } else {
    await pool.query(`INSERT INTO ${TABLE}
         (equipment_id, client_id, equipment_family, checkmk_host_name, checkmk_site,
          monitoring_data, host_details, last_synced_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz)`, [equipmentId, clientId, family, hostName, site || null, JSON.stringify(monitoringData), hostDetails ? JSON.stringify(hostDetails) : null, nowIso]);
  }
  const updated = await getStoredMonitoring(equipmentId);
  const summary = computeMonitoringSummary(monitoringData, nowIso);
  evaluateMonitoringAlert({
    clientId,
    equipmentId,
    equipmentFamily: family,
    equipmentName: hostName,
    monitorStatus: summary.status,
    source: "checkmk",
    details: summary
  }).catch(err => {
    console.error("[checkmk] evaluateMonitoringAlert:", err.message);
  });
  return {
    ...rowToResponse(updated, availabilityPeriod),
    skipped: false,
    message: 'Synchronization completed.'
  };
}
router.post('/equipment-monitoring/summaries', verifyJWT, async (req, res) => {
  try {
    const {
      clientId,
      equipmentIds
    } = req.body || {};
    let rows = [];
    if (clientId != null) {
      const r = await pool.query(`SELECT equipment_id, monitoring_data, last_synced_at FROM ${TABLE} WHERE client_id = $1`, [clientId]);
      rows = r.rows;
    } else if (Array.isArray(equipmentIds) && equipmentIds.length > 0) {
      const r = await pool.query(`SELECT equipment_id, monitoring_data, last_synced_at FROM ${TABLE} WHERE equipment_id = ANY($1::uuid[])`, [equipmentIds]);
      rows = r.rows;
    } else {
      return res.json({
        summaries: {}
      });
    }
    const summaries = {};
    for (const row of rows) {
      summaries[row.equipment_id] = computeMonitoringSummary(row.monitoring_data, row.last_synced_at);
    }
    res.json({
      summaries
    });
  } catch (err) {
    console.error('POST /checkmk/equipment-monitoring/summaries:', err);
    res.status(500).json({
      error: err.message || 'Error reading monitoring summaries'
    });
  }
});
router.get('/equipment-monitoring/:equipmentId', verifyJWT, async (req, res) => {
  try {
    const {
      equipmentId
    } = req.params;
    const availabilityPeriod = req.query.availability_period || '1m';
    const row = await getStoredMonitoring(equipmentId);
    if (!row) {
      return res.json({
        equipmentId,
        lastSyncedAt: null,
        checkmkData: null,
        hostDetails: null,
        availabilityByPeriod: {}
      });
    }
    res.json(rowToResponse(row, availabilityPeriod));
  } catch (err) {
    console.error('GET /checkmk/equipment-monitoring:', err);
    res.status(500).json({
      error: err.message || 'Error reading monitoring data'
    });
  }
});
router.post('/equipment-monitoring/sync', verifyJWT, async (req, res) => {
  try {
    const {
      equipmentId,
      clientId,
      family,
      hostName,
      site,
      force = false,
      availabilityPeriod = '1m'
    } = req.body || {};
    const result = await runEquipmentMonitoringSync(req, {
      equipmentId,
      clientId,
      family,
      hostName,
      site,
      force: force === true || force === 'true' || force === 1,
      availabilityPeriod
    });
    res.json(result);
  } catch (err) {
    console.error('POST /checkmk/equipment-monitoring/sync:', err);
    const msg = err.message || 'Error during synchronization';
    if (msg.includes('not found') || msg.includes('not mapped')) {
      return res.status(404).json({
        error: msg
      });
    }
    if (msg.includes('Missing parameters')) {
      return res.status(400).json({
        error: msg
      });
    }
    res.status(500).json({
      error: msg
    });
  }
});
export default router;
