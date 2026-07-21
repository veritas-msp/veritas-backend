import express from 'express';
import fetch from 'node-fetch';
import verifyJWT from '../../../middleware/auth.js';
import { getCheckMKSettings, authenticateCheckMK, getHostServices } from './utils.js';
const router = express.Router();
router.get('/services/:hostName', verifyJWT, async (req, res) => {
  try {
    const {
      hostName
    } = req.params;
    const {
      site,
      start_time,
      end_time
    } = req.query;
    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({
        error: 'Check MK configuration incomplete. Please configure settings in Settings.'
      });
    }
    const authData = await authenticateCheckMK(settings.apiUrl, settings.username, settings.password);
    const services = await getHostServices(settings.apiUrl, authData.auth_header, hostName, site || settings.site);
    res.json({
      host_name: hostName,
      services: services
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error retrieving services',
      details: error.message
    });
  }
});
router.get('/service-data/:hostName/:serviceName', verifyJWT, async (req, res) => {
  try {
    let {
      hostName,
      serviceName
    } = req.params;
    const {
      site
    } = req.query;
    hostName = decodeURIComponent(hostName);
    serviceName = decodeURIComponent(serviceName);
    if (serviceName.startsWith(`${hostName}:`)) {
      serviceName = serviceName.substring(hostName.length + 1);
    }
    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({
        error: 'Check MK configuration incomplete. Please configure settings in Settings.'
      });
    }
    const authData = await authenticateCheckMK(settings.apiUrl, settings.username, settings.password);
    const apiSite = site || settings.site;
    const parseDatesFromOutput = output => {
      if (!output) return {
        creation_time: null,
        end_time: null
      };
      const parseEuropeanDate = dateStr => {
        const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
        if (match) {
          const [, day, month, year, hour, minute, second] = match;
          return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
        }
        return null;
      };
      const creationPatterns = [/(?:created|creation|start|started)[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i, /creation[\s_]*time[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i, /start[\s_]*time[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i, /(?:created|creation|start|started)[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i, /creation[\s_]*time[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i, /start[\s_]*time[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i];
      const endPatterns = [/(?:end|ended|finish|finished)[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i, /end[\s_]*time[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i, /finish[\s_]*time[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i, /(?:end|ended|finish|finished)[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i, /end[\s_]*time[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i, /finish[\s_]*time[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i];
      let creation_time = null;
      let end_time = null;
      for (const pattern of creationPatterns) {
        const match = output.match(pattern);
        if (match) {
          try {
            const dateStr = match[1];
            if (dateStr.includes('.')) {
              const isoDate = parseEuropeanDate(dateStr);
              if (isoDate) {
                creation_time = new Date(isoDate).toISOString();
                break;
              }
            } else {
              creation_time = new Date(dateStr.replace(' ', 'T')).toISOString();
              break;
            }
          } catch (e) {}
        }
      }
      for (const pattern of endPatterns) {
        const match = output.match(pattern);
        if (match) {
          try {
            const dateStr = match[1];
            if (dateStr.includes('.')) {
              const isoDate = parseEuropeanDate(dateStr);
              if (isoDate) {
                end_time = new Date(isoDate).toISOString();
                break;
              }
            } else {
              end_time = new Date(dateStr.replace(' ', 'T')).toISOString();
              break;
            }
          } catch (e) {}
        }
      }
      return {
        creation_time,
        end_time
      };
    };
    const getServiceEvents = async () => {
      try {
        const normalizedApiUrl = settings.apiUrl.replace(/\/+$/, '');
        const eventsUrl = `${normalizedApiUrl}/domain-types/event_console/collections/all`;
        const queryExpression = JSON.stringify({
          op: "and",
          expr: [{
            op: "=",
            left: "host_name",
            right: hostName
          }]
        });
        const urlWithParams = new URL(eventsUrl);
        urlWithParams.searchParams.set('query', queryExpression);
        const response = await fetch(urlWithParams.toString(), {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': authData.auth_header
          }
        });
        if (response.ok) {
          const data = await response.json();
          const allEvents = data.value || data.items || [];
          const serviceEvents = allEvents.filter(event => {
            const eventService = event.service || event.service_name || event.service_description || '';
            const normalizedEventService = String(eventService).trim();
            const normalizedServiceName = String(serviceName).trim();
            if (normalizedEventService === normalizedServiceName) return true;
            if (normalizedEventService === `${hostName}:${normalizedServiceName}`) return true;
            if (normalizedEventService.toLowerCase() === normalizedServiceName.toLowerCase()) return true;
            if (normalizedEventService.includes(normalizedServiceName) || normalizedServiceName.includes(normalizedEventService)) return true;
            return false;
          });
          return serviceEvents;
        }
      } catch (error) {
        return [];
      }
      return [];
    };
    const calculateAvailability = async serviceEvents => {
      if (!serviceEvents || serviceEvents.length === 0) {
        return {
          availability_percent: null,
          events_count: 0
        };
      }
      const okEvents = serviceEvents.filter(e => (e.state || e.state_type || 0) === 0).length;
      const totalEvents = serviceEvents.length;
      const availability_percent = totalEvents > 0 ? Math.round(okEvents / totalEvents * 100) : null;
      return {
        availability_percent,
        events_count: totalEvents,
        ok_events: okEvents,
        warn_events: serviceEvents.filter(e => (e.state || e.state_type || 0) === 1).length,
        crit_events: serviceEvents.filter(e => (e.state || e.state_type || 0) === 2).length,
        unknown_events: serviceEvents.filter(e => (e.state || e.state_type || 0) === 3).length
      };
    };
    let serviceData = null;
    let pluginOutput = null;
    let longPluginOutput = null;
    try {
      let baseUrl = settings.apiUrl;
      if (baseUrl.includes('/api/1.0')) {
        baseUrl = baseUrl.replace('/api/1.0', '');
      }
      baseUrl = baseUrl.replace(/\/+$/, '');
      const viewPyUrl = `${baseUrl}/view.py`;
      const viewParams = new URLSearchParams();
      viewParams.append('host', hostName);
      viewParams.append('service', serviceName);
      viewParams.append('view_name', 'service');
      viewParams.append('output_format', 'json_export');
      if (apiSite) {
        viewParams.append('site', apiSite);
      }
      const viewUrl = `${viewPyUrl}?${viewParams.toString()}`;
      const viewResponse = await fetch(viewUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': authData.auth_header
        }
      });
      if (viewResponse.ok) {
        const viewData = await viewResponse.json();
        if (Array.isArray(viewData) && viewData.length >= 2) {
          const headers = viewData[0];
          const values = viewData[1];
          const svcPluginOutputIdx = headers.indexOf('svc_plugin_output');
          const svcLongPluginOutputIdx = headers.indexOf('svc_long_plugin_output');
          const serviceStateIdx = headers.indexOf('service_state');
          const serviceDescriptionIdx = headers.indexOf('service_description');
          const svcPerfDataIdx = headers.indexOf('svc_perf_data');
          if (svcPluginOutputIdx >= 0 && values[svcPluginOutputIdx]) {
            pluginOutput = values[svcPluginOutputIdx];
          }
          if (svcLongPluginOutputIdx >= 0 && values[svcLongPluginOutputIdx]) {
            longPluginOutput = values[svcLongPluginOutputIdx];
          }
          serviceData = {
            description: serviceDescriptionIdx >= 0 ? values[serviceDescriptionIdx] : serviceName,
            state: serviceStateIdx >= 0 ? values[serviceStateIdx] === 'OK' ? 0 : values[serviceStateIdx] === 'WARN' ? 1 : values[serviceStateIdx] === 'CRIT' ? 2 : 3 : null,
            performance_data: svcPerfDataIdx >= 0 ? values[svcPerfDataIdx] : null
          };
        }
      } else {
        const errorText = await viewResponse.text().catch(() => '');
        throw new Error(`Error retrieving service data: ${viewResponse.status}`);
      }
    } catch (viewError) {
      return res.status(500).json({
        error: `Error retrieving data for service ${serviceName}`,
        details: viewError.message
      });
    }
    if (!serviceData || !pluginOutput && !longPluginOutput) {
      return res.status(404).json({
        error: `Service ${serviceName} not found for host ${hostName}`,
        details: 'No data retrieved via view.py'
      });
    }
    const serviceEvents = await getServiceEvents();
    const availability = await calculateAvailability(serviceEvents);
    const outputToParse = longPluginOutput || pluginOutput;
    const dates = parseDatesFromOutput(outputToParse);
    const formattedData = {
      id: `${hostName}:${serviceName}`,
      title: serviceData.description || serviceName,
      description: serviceData.description || serviceName,
      state: serviceData.state,
      state_type: null,
      plugin_output: pluginOutput,
      long_plugin_output: longPluginOutput,
      performance_data: serviceData.performance_data || null,
      last_check: null,
      last_state_change: null,
      host_name: hostName,
      service_name: serviceName,
      events_count: availability.events_count,
      availability_percent: availability.availability_percent,
      events: {
        total: availability.events_count,
        ok: availability.ok_events,
        warn: availability.warn_events,
        crit: availability.crit_events,
        unknown: availability.unknown_events
      },
      creation_time: dates.creation_time,
      end_time: dates.end_time,
      raw: serviceData,
      output: pluginOutput,
      metrics: serviceData.performance_data || null,
      service_info: {
        state: serviceData.state,
        state_type: null,
        last_check: null,
        last_state_change: null
      }
    };
    return res.json(formattedData);
  } catch (error) {
    res.status(500).json({
      error: 'Error retrieving service data',
      details: error.message
    });
  }
});
export default router;
