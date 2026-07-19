// ───────────────────────────────────────────────
// 📊 Dedicated monitoring report route: events/notifications and availability
//     for the report period only (without changing EquipmentDetailPage calls).
// ───────────────────────────────────────────────

import express from 'express';
import fetch from 'node-fetch';
import verifyJWT from '../../../middleware/auth.js';
import {
  getCheckMKSettings,
  authenticateCheckMK,
  computeCheckMKLogtimeFromDays,
  filterCheckMKEventsByPeriod,
  parseCheckMKEventTime,
} from './utils.js';

const router = express.Router();

/**
 * GET /api/checkmk/report-period/:hostName
 * Query: start_time (ISO), end_time (ISO), site (optional)
 * Returns { events, availability } for the specified report period.
 */
router.get('/report-period/:hostName', verifyJWT, async (req, res) => {
  try {
    const { hostName } = req.params;
    const { start_time, end_time, site } = req.query;

    if (!start_time || !end_time) {
      return res.status(400).json({
        error: 'Paramètres manquants: start_time et end_time sont requis pour la période du rapport.'
      });
    }

    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({
        error: 'Configuration Check MK incomplète. Veuillez configurer les paramètres dans Settings.'
      });
    }

    let baseUrl = settings.apiUrl;
    baseUrl = baseUrl.replace(/\/check_mk\/api\/1\.0\/?$/, '');
    baseUrl = baseUrl.replace(/\/check_mk\/api\/?$/, '');
    baseUrl = baseUrl.replace(/\/api\/?$/, '');
    baseUrl = baseUrl.replace(/\/+$/, '');

    const checkmkSite = site || settings.site || '';
    const authData = await authenticateCheckMK(
      settings.apiUrl,
      settings.username,
      settings.password
    );

    const startDate = new Date(start_time);
    const endDate = new Date(end_time);
    const logtimeFromDays = computeCheckMKLogtimeFromDays(start_time, end_time);
    const viewUrl = `${baseUrl}/check_mk/view.py`;

    // ─── 1) Events / notifications (hostnotifications view, period in days)
    let eventsResult = { host_name: hostName, events_count: 0, events: [], period: { start_time, end_time } };
    try {
      const eventParams = new URLSearchParams({
        host: hostName,
        logtime_from: String(logtimeFromDays),
        logtime_from_range: '86400',
        output_format: 'json_export',
        view_name: 'hostnotifications'
      });
      if (checkmkSite) eventParams.append('site', checkmkSite);

      const eventRes = await fetch(`${viewUrl}?${eventParams.toString()}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Authorization': authData.auth_header }
      });

      if (eventRes.ok) {
        const contentType = eventRes.headers.get('content-type');
        let data;
        if (contentType && contentType.includes('application/json')) {
          data = await eventRes.json();
        } else {
          try {
            data = JSON.parse(await eventRes.text());
          } catch {
            data = [];
          }
        }

        let allEvents = [];
        if (Array.isArray(data)) {
          allEvents = data.length > 0 && Array.isArray(data[0]) ? data.slice(1) : data;
        } else if (data?.value && Array.isArray(data.value)) {
          allEvents = data.value;
        } else if (data?.events && Array.isArray(data.events)) {
          allEvents = data.events;
        } else if (data?.items && Array.isArray(data.items)) {
          allEvents = data.items;
        } else if (typeof data === 'object') {
          for (const key of Object.keys(data)) {
            if (Array.isArray(data[key])) {
              allEvents = data[key];
              break;
            }
          }
        }

        const normalizedEvents = allEvents.map((event, index) => {
          if (Array.isArray(event)) {
            const rawState = event[5];
            let stateNum = 0;
            if (typeof rawState === 'number') stateNum = rawState;
            else if (typeof rawState === 'string') {
              const m = rawState.match(/\((OK|WARNING|CRITICAL|UNKNOWN)\)/i) || rawState.match(/(OK|WARNING|CRITICAL|UNKNOWN)/i);
              if (m) {
                const t = m[1].toUpperCase();
                stateNum = t === 'OK' ? 0 : t === 'WARNING' ? 1 : t === 'CRITICAL' ? 2 : 3;
              }
            }
            // Several Check MK views (hostnotifications, hostsvcevents, etc.) use different column orders
            const serviceVal = event[4] ?? event[3] ?? null;
            const messageVal = event[6] ?? event[5] ?? event[7] ?? null;
            const timeRaw = event[1];
            let timeVal = null;
            if (typeof timeRaw === 'number') {
              timeVal = timeRaw < 10000000000 ? timeRaw : Math.floor(timeRaw / 1000);
            } else if (typeof timeRaw === 'string' && timeRaw.trim()) {
              const parsed = Date.parse(timeRaw.trim());
              if (!Number.isNaN(parsed)) {
                timeVal = Math.floor(parsed / 1000);
              }
            }
            const timestamp =
              timeVal != null
                ? new Date(timeVal * 1000).toISOString()
                : parseCheckMKEventTime({ time: timeRaw })?.toISOString() ?? null;
            return {
              id: index,
              icon: event[0] || null,
              time: timeVal ?? timeRaw,
              timestamp,
              type: event[2] || null,
              host: event[3] || null,
              service: serviceVal || null,
              state: stateNum,
              state_info: rawState,
              message: messageVal || '-',
              plugin_output: messageVal || null,
              raw: event
            };
          }
          let timeVal = event.time || event.log_time || event.timestamp || null;
          if (typeof timeVal === 'string' && timeVal.trim()) {
            const parsed = Date.parse(timeVal);
            if (!Number.isNaN(parsed)) timeVal = Math.floor(parsed / 1000);
          } else if (typeof timeVal === 'number' && timeVal > 10000000000) {
            timeVal = Math.floor(timeVal / 1000);
          }
          const timestamp =
            timeVal != null
              ? typeof timeVal === 'number'
                ? new Date(timeVal * 1000).toISOString()
                : String(timeVal)
              : parseCheckMKEventTime(event)?.toISOString() ?? null;
          return {
            id: index,
            icon: event.icon || event.log_icon || null,
            time: timeVal,
            timestamp,
            type: event.type || event.log_type || null,
            host: event.host || event.log_host || event.hostname || null,
            service: event.service || event.service_description || event.log_service_description || event.service_name || null,
            state: event.state ?? 0,
            state_info: event.state ?? event.log_state_info,
            message: event.message || event.event_text || event.plugin_output || event.log_plugin_output || event.long_plugin_output || '-',
            plugin_output: event.plugin_output || event.log_plugin_output || null
          };
        });

        const periodEvents = filterCheckMKEventsByPeriod(
          normalizedEvents,
          start_time,
          end_time
        );

        eventsResult = {
          host_name: hostName,
          events_count: periodEvents.length,
          events: periodEvents,
          period: { start_time, end_time }
        };
      }
    } catch (e) {
      console.error('[checkmk report-period] events:', e.message);
    }

    // ─── 2) Availability for the period (av_from / av_to as Unix timestamps when supported by the view)
    let availabilityResult = { host_name: hostName, availability: null };
    try {
      const avParams = new URLSearchParams({
        host: hostName,
        mode: 'availability',
        output_format: 'json_export',
        view_name: 'hoststatus'
      });
      if (checkmkSite) avParams.append('site', checkmkSite);
      const avFrom = Math.floor(startDate.getTime() / 1000);
      const avTo = Math.floor(endDate.getTime() / 1000);
      avParams.append('av_from', String(avFrom));
      avParams.append('av_to', String(avTo));

      const avRes = await fetch(`${viewUrl}?${avParams.toString()}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Authorization': authData.auth_header }
      });

      if (avRes.ok) {
        const html = await avRes.text();
        let availabilityData = null;
        const hostPattern = new RegExp(`<tr[^>]*class="data[^"]*"[^>]*>.*?<td[^>]*>.*?<a[^>]*>${hostName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>.*?</td>(.*?)</tr>`, 'is');
        const match = html.match(hostPattern);

        if (match && match[1]) {
          const spanPattern = /<span[^>]*>([0-9.]+)%<\/span>/g;
          const values = [];
          let spanMatch;
          while ((spanMatch = spanPattern.exec(match[1])) !== null) values.push(parseFloat(spanMatch[1]));
          if (values.length >= 6) {
            availabilityData = {
              up: values[0] || 0,
              down: values[1] || 0,
              unreach: values[2] || 0,
              flapping: values[3] || 0,
              downtime: values[4] || 0,
              n_a: values[5] || 0
            };
          }
        }

        if (!availabilityData) {
          const allRowsPattern = /<tr[^>]*class="data[^"]*"[^>]*>(.*?)<\/tr>/gs;
          let rowMatch;
          while ((rowMatch = allRowsPattern.exec(html)) !== null) {
            if (rowMatch[1].includes(hostName)) {
              const spanPattern = /<span[^>]*>([0-9.]+)%<\/span>/g;
              const values = [];
              let spanMatch;
              while ((spanMatch = spanPattern.exec(rowMatch[1])) !== null) values.push(parseFloat(spanMatch[1]));
              if (values.length >= 6) {
                const lastValues = values.slice(-6);
                availabilityData = {
                  up: lastValues[0] || 0,
                  down: lastValues[1] || 0,
                  unreach: lastValues[2] || 0,
                  flapping: lastValues[3] || 0,
                  downtime: lastValues[4] || 0,
                  n_a: lastValues[5] || 0
                };
              }
              break;
            }
          }
        }

        availabilityResult = { host_name: hostName, availability: availabilityData };
      }
    } catch (e) {
      console.error('[checkmk report-period] availability:', e.message);
    }

    return res.json({
      host_name: hostName,
      period: { start_time, end_time },
      events: eventsResult,
      availability: availabilityResult
    });
  } catch (error) {
    res.status(500).json({
      host_name: req.params.hostName,
      error: error.message,
      events: { host_name: req.params.hostName, events_count: 0, events: [] },
      availability: { host_name: req.params.hostName, availability: null }
    });
  }
});

export default router;
