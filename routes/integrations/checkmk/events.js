// ───────────────────────────────────────────────
// 📊 Check MK event routes
// ───────────────────────────────────────────────

import express from 'express';
import fetch from 'node-fetch';
import verifyJWT from '../../../middleware/auth.js';
import {
  getCheckMKSettings,
  authenticateCheckMK,
  computeCheckMKLogtimeFromDays,
  filterCheckMKEventsByPeriod,
} from './utils.js';

const router = express.Router();

// ───────────────────────────────────────────────
// 📊 GET /api/checkmk/events/:hostName — Fetch open event count for a host
// ───────────────────────────────────────────────
router.get('/events/:hostName', verifyJWT, async (req, res) => {
  try {
    const { hostName } = req.params;
    
    // Fetch Check MK settings
    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({ 
        error: 'Configuration Check MK incomplète. Veuillez configurer les paramètres dans Settings.' 
      });
    }
    
    // Authenticate with Check MK
    const authData = await authenticateCheckMK(
      settings.apiUrl,
      settings.username,
      settings.password
    );
    
    // Build Check MK API URL for events
    const normalizedApiUrl = settings.apiUrl.replace(/\/+$/, '');
    const eventsUrl = `${normalizedApiUrl}/domain-types/event_console/collections/all`;
    
    // Build the request to fetch non-OK events (state != '0') for this host
    const queryExpression = JSON.stringify({
      op: "and",
      expr: [
        { op: "=", left: "host_name", right: hostName },
        { op: "!=", left: "state", right: "0" }
      ]
    });
    
    // Build the URL with query parameters
    const urlWithParams = new URL(eventsUrl);
    urlWithParams.searchParams.set('query', queryExpression);
    
    try {
      const response = await fetch(urlWithParams.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': authData.auth_header
        }
      });
      
      if (!response.ok) {
        // If the endpoint does not exist or errors, return 0 events
        if (response.status === 404) {
          return res.json({ 
            host_name: hostName,
            events_count: 0,
            events: []
          });
        }
        
        const errorText = await response.text().catch(() => '');
        return res.json({ 
          host_name: hostName,
          events_count: 0,
          events: [],
          warning: `Impossible de récupérer les événements: ${response.status}`
        });
      }
      
      const data = await response.json();
      
      // Extract events from the response
      let events = [];
      if (data.value && Array.isArray(data.value)) {
        events = data.value;
      } else if (Array.isArray(data)) {
        events = data;
      }
      
      // Filter non-OK events for this host
      const filteredEvents = events.filter(event => {
        const eventHost = event.host || event.host_name || event.hostname;
        const eventState = event.state || event.state_type || event.state_num;
        
        // Verify this event belongs to the correct host
        if (eventHost && eventHost !== hostName) {
          return false;
        }
        
        // Skip OK state (0)
        if (eventState === 0 || eventState === '0' || eventState === 'ok' || eventState === 'OK') {
          return false;
        }
        
        return true;
      });
      
      res.json({
        host_name: hostName,
        events_count: filteredEvents.length,
        events: filteredEvents
      });
      
    } catch (fetchError) {
      // On error, return 0 events instead of failing
      return res.json({ 
        host_name: hostName,
        events_count: 0,
        events: [],
        warning: `Erreur lors de la récupération des événements: ${fetchError.message}`
      });
    }
    
  } catch (error) {
    // On error, return 0 events rather than an error response
    res.json({ 
      host_name: req.params.hostName,
      events_count: 0,
      events: [],
      error: error.message 
    });
  }
});

// ───────────────────────────────────────────────
// 📊 GET /api/checkmk/host-events/:hostName — Fetch detailed events for a host
// ───────────────────────────────────────────────
router.get('/host-events/:hostName', verifyJWT, async (req, res) => {
  try {
    const { hostName } = req.params;
    const { start_time, end_time, site } = req.query;

    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({ 
        error: 'Configuration Check MK incomplète. Veuillez configurer les paramètres dans Settings.' 
      });
    }

    const authData = await authenticateCheckMK(
      settings.apiUrl,
      settings.username,
      settings.password
    );

    const normalizedApiUrl = settings.apiUrl.replace(/\/+$/, '');
    const possibleEndpoints = [
      `${normalizedApiUrl}/domain-types/eventconsoleevent/collections/all`,
      `${normalizedApiUrl}/domain-types/event_console/collections/all`
    ];

    const columns = [
      'event_id',
      'event_phase',
      'event_state',
      'event_text',
      'event_first',
      'event_last',
      'event_count',
      'event_owner',
      'event_rule_id',
      'event_core_host',
      'event_host'
    ];

    const queryExpression = JSON.stringify({
      op: 'or',
      expr: [
        { op: '=', left: 'event_core_host', right: hostName },
        { op: '=', left: 'event_host', right: hostName },
        { op: '=', left: 'event_orig_host', right: hostName }
      ]
    });

    let events = [];
    let lastError = null;

    for (const endpoint of possibleEndpoints) {
      try {
        const url = new URL(endpoint);
        url.searchParams.set('query', queryExpression);
        url.searchParams.set('columns', columns.join(','));
        if (start_time) url.searchParams.set('start_time', start_time);
        if (end_time) url.searchParams.set('end_time', end_time);
        if (site || settings.site) url.searchParams.set('site', site || settings.site);

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': authData.auth_header
          }
        });

        if (response.ok) {
          const data = await response.json();
          const items = data.value || data.items || data || [];
          events = Array.isArray(items) ? items : [];
          break;
        } else if (response.status !== 404) {
          lastError = `Erreur ${response.status}`;
        }
      } catch (fetchError) {
        lastError = fetchError.message;
      }
    }

    return res.json({
      host_name: hostName,
      events_count: events.length,
      events,
      warning: events.length === 0 && lastError ? lastError : undefined
    });
  } catch (error) {
    return res.status(500).json({
      host_name: req.params.hostName,
      events_count: 0,
      events: [],
      error: error.message
    });
  }
});

// ───────────────────────────────────────────────
// 📊 GET /api/checkmk/events-period/:hostName — Fetch event count over a period via view.py
// ───────────────────────────────────────────────
router.get('/events-period/:hostName', verifyJWT, async (req, res) => {
  try {
    const { hostName } = req.params;
    const { start_time, end_time, site, critical_only } = req.query;
    const criticalOnly = critical_only === 'true' || critical_only === '1';
    
    if (!start_time || !end_time) {
      return res.status(400).json({ 
        error: 'Paramètres manquants: start_time et end_time sont requis' 
      });
    }
    
    // Fetch Check MK settings
    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({ 
        error: 'Configuration Check MK incomplète. Veuillez configurer les paramètres dans Settings.' 
      });
    }
    
    // Extract CheckMK base URL
    let baseUrl = settings.apiUrl;
    baseUrl = baseUrl.replace(/\/check_mk\/api\/1\.0\/?$/, '');
    baseUrl = baseUrl.replace(/\/check_mk\/api\/?$/, '');
    baseUrl = baseUrl.replace(/\/api\/?$/, '');
    baseUrl = baseUrl.replace(/\/+$/, '');
    
    const checkmkSite = site || settings.site || '';
    
    const logtimeFromDays = computeCheckMKLogtimeFromDays(start_time, end_time);

    // Build the view.py URL
    const viewUrl = `${baseUrl}/check_mk/view.py`;
    
    const urlParams = new URLSearchParams({
      host: hostName,
      logtime_from: String(logtimeFromDays),
      logtime_from_range: '86400',
      output_format: 'json_export',
      view_name: 'hostsvcevents'
    });
    
    // Add site to query settings when available
    if (checkmkSite) {
      urlParams.append('site', checkmkSite);
    }
    
    const fullUrl = `${viewUrl}?${urlParams.toString()}`;
    
    // Authenticate with Check MK
    const authData = await authenticateCheckMK(
      settings.apiUrl,
      settings.username,
      settings.password
    );
    
    try {
      const response = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': authData.auth_header
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return res.json({ 
          host_name: hostName,
          events_count: 0,
          events: [],
          warning: `Impossible de récupérer les événements: ${response.status}`
        });
      }
      
      // Response may be JSON or plain text
      const contentType = response.headers.get('content-type');
      let data;
      
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        // If this is not JSON, try parsing it as plain text
        const text = await response.text();
        try {
          data = JSON.parse(text);
        } catch (parseError) {
          return res.json({ 
            host_name: hostName,
            events_count: 0,
            events: [],
            warning: 'Format de réponse inattendu'
          });
        }
      }
      
      // Extract events from the response
      let allEvents = [];
      if (Array.isArray(data)) {
        if (data.length > 0 && Array.isArray(data[0])) {
          allEvents = data.slice(1);
        } else {
          allEvents = data;
        }
      } else if (data.value && Array.isArray(data.value)) {
        allEvents = data.value;
      } else if (data.items && Array.isArray(data.items)) {
        allEvents = data.items;
      } else if (data.events && Array.isArray(data.events)) {
        allEvents = data.events;
      } else if (data.data && Array.isArray(data.data)) {
        allEvents = data.data;
      } else if (typeof data === 'object') {
        for (const key in data) {
          if (Array.isArray(data[key])) {
            allEvents = data[key];
            break;
          }
        }
      }
      
      // Normalize events: convert arrays into objects
      const normalizedEvents = allEvents.map((event, index) => {
        if (Array.isArray(event)) {
          const rawState = event[5];
          
          let stateNum = 0;
          if (typeof rawState === 'number') {
            stateNum = rawState;
          } else if (typeof rawState === 'string') {
            const match = rawState.match(/\((OK|WARNING|CRITICAL|UNKNOWN)\)/i) || 
                         rawState.match(/(OK|WARNING|CRITICAL|UNKNOWN)/i);
            if (match) {
              const statusText = match[1].toUpperCase();
              stateNum = statusText === 'OK' ? 0 : 
                        statusText === 'WARNING' ? 1 : 
                        statusText === 'CRITICAL' ? 2 : 3;
            }
          }
          
          let timeVal = null;
          const timeStr = event[1];
          if (typeof timeStr === 'number') {
            timeVal = timeStr < 10000000000 ? timeStr : Math.floor(timeStr / 1000);
          } else if (typeof timeStr === 'string' && timeStr.trim()) {
            const s = timeStr.trim();
            const relMatch = s.match(/(\d+)\s*([mhd]|min|mins|minute|minutes|hour|hours)/i);
            if (relMatch) {
              const amount = parseInt(relMatch[1], 10);
              const unit = relMatch[2].toLowerCase();
              const nowSeconds = Math.floor(Date.now() / 1000);
              let secondsAgo = 0;
              if (unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minute' || unit === 'minutes') {
                secondsAgo = amount * 60;
              } else if (unit === 'h' || unit === 'hour' || unit === 'hours') {
                secondsAgo = amount * 3600;
              } else if (unit === 'd') {
                secondsAgo = amount * 86400;
              }
              timeVal = nowSeconds - secondsAgo;
            } else {
              const parsed = Date.parse(s);
              if (!Number.isNaN(parsed)) {
                timeVal = Math.floor(parsed / 1000);
              }
            }
          }
          
          const timestamp = timeVal != null ? new Date(timeVal * 1000).toISOString() : null;
          return {
            id: index,
            icon: event[0] || null,
            time: timeVal,
            timestamp,
            type: event[2] || null,
            host: event[3] || null,
            service: event[4] || null,
            state: stateNum,
            state_info: rawState,
            message: event[6] || '-',
            plugin_output: event[6] || null,
            raw: event
          };
        } else {
          const rawState = event.state || event.log_state_info || event.event_state || 0;
          
          let stateNum = 0;
          if (typeof rawState === 'number') {
            stateNum = rawState;
          } else if (typeof rawState === 'string') {
            const match = rawState.match(/\((OK|WARNING|CRITICAL|UNKNOWN)\)/i) || 
                         rawState.match(/(OK|WARNING|CRITICAL|UNKNOWN)/i);
            if (match) {
              const statusText = match[1].toUpperCase();
              stateNum = statusText === 'OK' ? 0 : 
                        statusText === 'WARNING' ? 1 : 
                        statusText === 'CRITICAL' ? 2 : 3;
            }
          }
          
          let timeVal = event.time || event.log_time || event.timestamp || event.from || null;
          if (typeof timeVal === 'string' && timeVal.trim()) {
            const parsed = Date.parse(timeVal);
            if (!Number.isNaN(parsed)) timeVal = Math.floor(parsed / 1000);
          } else if (typeof timeVal === 'number' && timeVal > 10000000000) {
            timeVal = Math.floor(timeVal / 1000);
          }
          const timestamp = timeVal != null
            ? (typeof timeVal === 'number' ? new Date(timeVal * 1000).toISOString() : String(timeVal))
            : null;
          return {
            id: index,
            icon: event.icon || event.log_icon || null,
            time: timeVal,
            timestamp,
            type: event.type || event.log_type || null,
            host: event.host || event.log_host || event.hostname || null,
            service: event.service || event.service_description || event.log_service_description || null,
            state: stateNum,
            state_info: rawState,
            message: event.message || event.event_text || event.plugin_output || event.log_plugin_output || '-',
            plugin_output: event.plugin_output || event.log_plugin_output || event.event_text || null
          };
        }
      });

      const finalEvents = filterCheckMKEventsByPeriod(
        normalizedEvents,
        start_time,
        end_time,
        { criticalOnly }
      );

      res.json({
        host_name: hostName,
        events_count: finalEvents.length,
        total_events_count: allEvents.length,
        events: finalEvents,
        period: {
          start_time: start_time,
          end_time: end_time
        }
      });
      
    } catch (fetchError) {
      return res.json({ 
        host_name: hostName,
        events_count: 0,
        events: [],
        warning: `Erreur lors de la récupération des événements: ${fetchError.message}`
      });
    }
    
  } catch (error) {
    res.json({ 
      host_name: req.params.hostName,
      events_count: 0,
      events: [],
      error: error.message 
    });
  }
});

export default router;
