import express from 'express';
import fetch from 'node-fetch';
import { pool } from '../../../database/db.js';
import verifyJWT from '../../../middleware/auth.js';
import { getCheckMKSettings, authenticateCheckMK, getHostServices, getServicePluginOutputViaViewPy } from './utils.js';
const router = express.Router();
const SAVE_TABLE = 'v_b_clients_m_save';
const SETTINGS_TABLE = 'v_b_settings';
const LAST_SYNC_SECTION = 'checkmk';
const LAST_SYNC_KEY = 'checkmk_save_jobs_last_sync';
let lastSaveJobsSyncAt = null;
async function loadLastSyncFromDb() {
  try {
    const r = await pool.query(`SELECT value FROM ${SETTINGS_TABLE} WHERE section = $1 AND key = $2`, [LAST_SYNC_SECTION, LAST_SYNC_KEY]);
    if (r.rows[0]?.value) lastSaveJobsSyncAt = r.rows[0].value;
  } catch (_) {}
}
async function saveLastSyncToDb(isoDate) {
  try {
    const r = await pool.query(`UPDATE ${SETTINGS_TABLE} SET value = $1 WHERE section = $2 AND key = $3`, [isoDate, LAST_SYNC_SECTION, LAST_SYNC_KEY]);
    if (r.rowCount === 0) {
      await pool.query(`INSERT INTO ${SETTINGS_TABLE} (section, key, value) VALUES ($1, $2, $3)`, [LAST_SYNC_SECTION, LAST_SYNC_KEY, isoDate]);
    }
  } catch (err) {
    console.warn('[checkmk save-jobs] Unable to save lastSync to database:', err.message);
  }
}
async function fetchShowService(apiUrl, authHeader, hostName, serviceDescription, site) {
  const showUrl = new URL(`${apiUrl}/objects/host/${encodeURIComponent(hostName)}/actions/show_service/invoke`);
  showUrl.searchParams.set('service_description', serviceDescription);
  if (site) showUrl.searchParams.set('site', site);
  const res = await fetch(showUrl.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader
    }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const ext = data?.extensions || {};
  return ext.plugin_output || ext.long_plugin_output || null;
}
function formatDurationSeconds(seconds) {
  const s = Math.floor(Number(seconds));
  if (Number.isNaN(s) || s < 0) return null;
  const minutes = Math.floor(s / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0) return `${hours}h ${remainingMinutes}min`;
  return `${minutes}min`;
}
function parseDurationFromPerfData(perfData) {
  if (!perfData || typeof perfData !== 'string') return null;
  const str = String(perfData);
  const keys = ['duration', 'backup_duration', 'last_duration', 'duration_sec', 'backup_time', 'time'];
  for (const key of keys) {
    const re = new RegExp(`\\b${key}=([\\d.]+)`, 'i');
    const m = str.match(re);
    if (m) {
      const formatted = formatDurationSeconds(parseFloat(m[1]));
      if (formatted) return formatted;
    }
  }
  return null;
}
function parseDurationFromPluginOutput(pluginOutput) {
  if (!pluginOutput || typeof pluginOutput !== 'string') return null;
  const out = pluginOutput;
  const creationMatch = out.match(/Creation time:\s*([^,\n]+)/i);
  const endMatch = out.match(/End time:\s*([^,\n]+)/i);
  if (creationMatch && endMatch) {
    try {
      const parseDate = dateStr => {
        const str = dateStr.trim();
        const parts = str.split(' ');
        const datePart = parts[0] || '';
        const timePart = parts[1] || '00:00:00';
        const segs = datePart.split('.').map(x => parseInt(x, 10));
        const t = timePart.split(':').map(x => parseInt(x, 10) || 0);
        const hour = t[0] || 0,
          minute = t[1] || 0,
          second = t[2] || 0;
        if (segs.length === 3 && segs[2] >= 2000 && segs[2] <= 2100) {
          const day = segs[0],
            month = segs[1],
            year = segs[2];
          if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            const d = new Date(year, month - 1, day, hour, minute, second);
            if (!isNaN(d.getTime())) return d;
          }
        }
        return new Date(NaN);
      };
      const start = parseDate(creationMatch[1].trim());
      const end = parseDate(endMatch[1].trim());
      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        const diffMs = end.getTime() - start.getTime();
        const diffMinutes = Math.floor(diffMs / 60000);
        if (diffMinutes < 0 || diffMinutes > 10080) return null;
        const diffHours = Math.floor(diffMinutes / 60);
        const remainingMinutes = diffMinutes % 60;
        if (diffHours > 0) return `${diffHours}h ${remainingMinutes}min`;
        return `${diffMinutes}min`;
      }
    } catch (e) {}
  }
  const durationLabels = [/Duration:\s*([^\n,]+)/i, /Backup duration:\s*([^\n,]+)/i, /Dauer:\s*([^\n,]+)/i, /Last backup duration:\s*([^\n,]+)/i];
  for (const re of durationLabels) {
    const m = out.match(re);
    if (m) {
      const raw = m[1].trim();
      if (/^\d+\s*h(?:ours?)?\s*\d+\s*min/i.test(raw) || /^\d+\s*min/i.test(raw) || /^\d+\s*s/i.test(raw)) return raw;
      const secMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secondes?)/i);
      if (secMatch) {
        const formatted = formatDurationSeconds(parseFloat(secMatch[1]));
        if (formatted) return formatted;
      }
      const minMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:m|min|minutes?)/i);
      if (minMatch) return `${Math.floor(parseFloat(minMatch[1]))}min`;
    }
  }
  const preFormatted = out.match(/(\d+)\s*h(?:ours?)?\s*(\d+)\s*min/i) || out.match(/(\d+)\s*min(?:utes?)?/i);
  if (preFormatted) {
    if (preFormatted[2] !== undefined) return `${preFormatted[1]}h ${preFormatted[2]}min`;
    return `${preFormatted[1]}min`;
  }
  return null;
}
function parseCreationTimeFromPluginOutput(pluginOutput) {
  if (!pluginOutput || typeof pluginOutput !== 'string') return null;
  const creationMatch = pluginOutput.match(/Creation time:\s*([^,\n]+)/i);
  if (!creationMatch) return null;
  try {
    const parts = creationMatch[1].trim().split(' ');
    const datePart = parts[0] || '';
    const timePart = parts[1] || '00:00:00';
    const segs = datePart.split('.').map(x => parseInt(x, 10));
    const t = timePart.split(':').map(x => parseInt(x, 10) || 0);
    const hour = t[0] || 0,
      minute = t[1] || 0,
      second = t[2] || 0;
    if (segs.length === 3 && segs[2] >= 2000 && segs[2] <= 2100) {
      const day = segs[0],
        month = segs[1],
        year = segs[2];
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const d = new Date(year, month - 1, day, hour, minute, second);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
    }
  } catch (e) {}
  return null;
}
function toLastBackupDate(lastCheck) {
  if (lastCheck == null) return null;
  if (typeof lastCheck === 'number') {
    const d = new Date(lastCheck * 1000);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof lastCheck === 'string') {
    const d = new Date(lastCheck);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
export async function runSaveJobsSync({
  clientId
} = {}) {
  const columnsResult = await pool.query(`SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`, [SAVE_TABLE]);
  const columns = new Set(columnsResult.rows.map(r => r.column_name));
  const hasLastBackupDate = columns.has('last_backup_date');
  const hasLastBackupDuration = columns.has('last_backup_duration');
  const hasLastBackupStart = columns.has('last_backup_start');
  if (!hasLastBackupDate || !hasLastBackupDuration) {
    throw new Error('Columns last_backup_date / last_backup_duration missing. Run migration add_last_backup_to_save.sql.');
  }
  const queryParams = [];
  let clientFilter = '';
  if (clientId != null) {
    queryParams.push(clientId);
    clientFilter = ` AND client_id = $${queryParams.length}`;
  }
  const jobsResult = await pool.query(`SELECT id, client_id, item_key, data, checkmk_host_name, checkmk_site, checkmk_service_name
     FROM ${SAVE_TABLE}
     WHERE checkmk_host_name IS NOT NULL AND checkmk_host_name != ''
       AND (
         (item_key IS NOT NULL AND item_key LIKE 'job-%')
         OR (data IS NOT NULL AND (data::jsonb->>'type') = 'job')
       )${clientFilter}`, queryParams);
  const jobs = jobsResult.rows;
  if (jobs.length === 0) {
    lastSaveJobsSyncAt = new Date().toISOString();
    await saveLastSyncToDb(lastSaveJobsSyncAt);
    return {
      message: 'No mapped job to synchronize',
      updated: 0,
      total: 0,
      lastSync: lastSaveJobsSyncAt
    };
  }
  const settings = await getCheckMKSettings();
  if (!settings?.apiUrl || !settings.username || !settings.password) {
    throw new Error('Check MK configuration incomplete.');
  }
  const authData = await authenticateCheckMK(settings.apiUrl, settings.username, settings.password);
  if (!authData?.auth_header) {
    throw new Error('Unable to authenticate to Check MK.');
  }
  let updated = 0;
  for (const job of jobs) {
    const hostName = job.checkmk_host_name;
    const site = job.checkmk_site ?? settings.site ?? '';
    const serviceName = (job.checkmk_service_name || '').trim() || (job.data?.nom || '').trim();
    if (!serviceName) continue;
    try {
      const services = await getHostServices(settings.apiUrl, authData.auth_header, hostName, site);
      const getServiceDesc = s => s.description || (s.id && s.id.includes(':') ? s.id.split(':').slice(1).join(':') : '') || s.title || s.id || '';
      const svc = services.find(s => {
        const desc = getServiceDesc(s);
        return desc === serviceName || s.title && s.title === serviceName || s.id && s.id.endsWith(serviceName);
      });
      if (!svc) continue;
      const lastBackupDate = toLastBackupDate(svc.lastCheck);
      let pluginOutputForCreation = svc.longPluginOutput || svc.pluginOutput || null;
      let lastBackupDuration = parseDurationFromPerfData(svc.performanceData) || parseDurationFromPerfData(svc.pluginOutput) || parseDurationFromPluginOutput(svc.pluginOutput) || parseDurationFromPluginOutput(svc.longPluginOutput);
      if (!lastBackupDuration && !svc.pluginOutput && !svc.longPluginOutput) {
        const serviceDescription = serviceName.includes(':') ? serviceName.split(':').slice(1).join(':').trim() : serviceName;
        const showOutput = await fetchShowService(settings.apiUrl, authData.auth_header, hostName, serviceDescription, site);
        if (showOutput) {
          pluginOutputForCreation = showOutput;
          lastBackupDuration = parseDurationFromPluginOutput(showOutput) || parseDurationFromPerfData(showOutput);
        }
      }
      let viewPyData = null;
      if (!lastBackupDuration) {
        const serviceNameForView = (serviceName || '').trim().startsWith(`${hostName}:`) ? (serviceName || '').trim().substring(hostName.length + 1).trim() : (serviceName || '').trim();
        viewPyData = await getServicePluginOutputViaViewPy(settings.apiUrl, authData.auth_header, hostName, serviceNameForView || serviceName, site);
        if (viewPyData) {
          const out = viewPyData.longPluginOutput || viewPyData.pluginOutput;
          if (!pluginOutputForCreation) pluginOutputForCreation = out;
          lastBackupDuration = parseDurationFromPerfData(viewPyData.performanceData) || parseDurationFromPerfData(out) || parseDurationFromPluginOutput(viewPyData.longPluginOutput) || parseDurationFromPluginOutput(viewPyData.pluginOutput);
        }
      }
      if (!lastBackupDuration) {
        const snippet = viewPyData ? (viewPyData.longPluginOutput || viewPyData.pluginOutput || viewPyData.performanceData || '').toString().slice(0, 200) : '(view.py with no data)';
        console.warn(`[checkmk save-jobs sync] Duration not found for job id=${job.id} (${serviceName}), host=${hostName}. Preview: ${snippet}`);
      }
      if (!pluginOutputForCreation && hasLastBackupStart) {
        const serviceNameForView = (serviceName || '').trim().startsWith(`${hostName}:`) ? (serviceName || '').trim().substring(hostName.length + 1).trim() : (serviceName || '').trim();
        const viewPyForStart = await getServicePluginOutputViaViewPy(settings.apiUrl, authData.auth_header, hostName, serviceNameForView || serviceName, site);
        if (viewPyForStart) {
          pluginOutputForCreation = viewPyForStart.longPluginOutput || viewPyForStart.pluginOutput || null;
        }
        if (!pluginOutputForCreation) {
          const serviceDescription = serviceName.includes(':') ? serviceName.split(':').slice(1).join(':').trim() : serviceName;
          const showOutput = await fetchShowService(settings.apiUrl, authData.auth_header, hostName, serviceDescription, site);
          if (showOutput) pluginOutputForCreation = showOutput;
        }
      }
      const lastBackupStart = pluginOutputForCreation ? parseCreationTimeFromPluginOutput(pluginOutputForCreation) : null;
      if (hasLastBackupStart) {
        await pool.query(`UPDATE ${SAVE_TABLE}
           SET last_backup_date = $1::timestamptz, last_backup_duration = $2::varchar, last_backup_start = $4::timestamptz, updated_at = NOW()
           WHERE id = $3`, [lastBackupDate, lastBackupDuration || null, job.id, lastBackupStart || null]);
      } else {
        await pool.query(`UPDATE ${SAVE_TABLE}
           SET last_backup_date = $1::timestamptz, last_backup_duration = $2::varchar, updated_at = NOW()
           WHERE id = $3`, [lastBackupDate, lastBackupDuration || null, job.id]);
      }
      updated += 1;
    } catch (err) {
      console.error(`[checkmk save-jobs sync] Job id=${job.id} (${serviceName}):`, err.message);
    }
  }
  lastSaveJobsSyncAt = new Date().toISOString();
  await saveLastSyncToDb(lastSaveJobsSyncAt);
  return {
    message: 'Synchronization completed',
    updated,
    total: jobs.length,
    lastSync: lastSaveJobsSyncAt
  };
}
router.get('/save-jobs/last-sync', verifyJWT, async (req, res) => {
  if (lastSaveJobsSyncAt == null) await loadLastSyncFromDb();
  res.json({
    lastSync: lastSaveJobsSyncAt
  });
});
router.post('/save-jobs/sync', verifyJWT, async (req, res) => {
  try {
    const clientId = req.body?.clientId ?? null;
    const result = await runSaveJobsSync({
      clientId
    });
    res.json(result);
  } catch (err) {
    console.error('POST /checkmk/save-jobs/sync:', err);
    const msg = err.message || 'Error synchronizing jobs';
    if (err.message?.includes('Colonnes')) return res.status(501).json({
      error: msg
    });
    if (err.message?.includes('Configuration')) return res.status(500).json({
      error: msg
    });
    if (err.message?.includes('authentifier')) return res.status(502).json({
      error: msg
    });
    res.status(500).json({
      error: msg
    });
  }
});
export default router;
