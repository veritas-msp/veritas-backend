import express from 'express';
import fetch from 'node-fetch';
import verifyJWT from '../../../middleware/auth.js';
import { getCheckMKSettings, authenticateCheckMK } from './utils.js';
const router = express.Router();
router.get('/host/:hostName', verifyJWT, async (req, res) => {
  try {
    const {
      hostName
    } = req.params;
    const {
      site
    } = req.query;
    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({
        error: 'Check MK configuration incomplete. Please configure settings in Settings.'
      });
    }
    const authData = await authenticateCheckMK(settings.apiUrl, settings.username, settings.password);
    const possibleEndpoints = [`${settings.apiUrl}/objects/host/${encodeURIComponent(hostName)}`, `${settings.apiUrl}/domain-types/host/objects/${encodeURIComponent(hostName)}`, `${settings.apiUrl}/objects/host_config/${encodeURIComponent(hostName)}`];
    let hostDetails = null;
    let lastError = null;
    let runtimeData = null;
    let configData = null;
    let statusData = null;
    const extractHostParts = data => {
      const extensions = data?.extensions || {};
      const attributes = extensions.attributes || data?.attributes || {};
      return {
        extensions,
        attributes
      };
    };
    const pickValue = (...values) => values.find(value => value !== undefined && value !== null && value !== '');
    const pickObject = (primary, fallback) => {
      if (primary && typeof primary === 'object' && Object.keys(primary).length > 0) return primary;
      return fallback && typeof fallback === 'object' ? fallback : {};
    };
    const pickArray = (primary, fallback) => {
      if (Array.isArray(primary) && primary.length > 0) return primary;
      return Array.isArray(fallback) ? fallback : [];
    };
    for (const endpoint of possibleEndpoints) {
      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': authData.auth_header
          }
        });
        if (response.ok) {
          const data = await response.json();
          if (endpoint.includes('/host_config/')) {
            configData = data;
          } else {
            runtimeData = data;
          }
          if (runtimeData && configData) {
            break;
          }
        } else if (response.status !== 404) {
          lastError = `Error ${response.status}`;
        }
      } catch (fetchError) {
        lastError = fetchError.message;
        continue;
      }
    }
    try {
      const columns = ['name', 'alias', 'address', 'state', 'state_type', 'plugin_output', 'long_plugin_output', 'perf_data', 'performance_data', 'last_check', 'last_state_change', 'last_time_up', 'last_time_down', 'last_time_unreachable', 'num_services', 'num_services_ok', 'num_services_warn', 'num_services_crit', 'num_services_unknown', 'worst_service_state', 'labels', 'label_sources', 'label_source_names', 'label_source_values', 'scheduled_downtime_depth', 'in_downtime', 'problem_has_been_acknowledged', 'acknowledged', 'check_interval', 'retry_interval', 'notification_period', 'check_command', 'custom_variables', 'groups', 'contact_groups', 'current_attempt', 'display_name'];
      const queryExpression = JSON.stringify({
        op: '=',
        left: 'name',
        right: hostName
      });
      const statusUrl = new URL(`${settings.apiUrl}/domain-types/host/collections/all`);
      statusUrl.searchParams.set('columns', columns.join(','));
      statusUrl.searchParams.set('query', queryExpression);
      if (site) {
        statusUrl.searchParams.set('site', site);
      }
      const statusResponse = await fetch(statusUrl.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': authData.auth_header
        }
      });
      if (statusResponse.ok) {
        const statusBody = await statusResponse.json();
        const statusItems = statusBody.value || statusBody.items || statusBody || [];
        statusData = Array.isArray(statusItems) ? statusItems[0] : statusItems;
      }
    } catch (statusError) {}
    const primaryData = runtimeData || configData;
    if (primaryData) {
      const runtimeParts = extractHostParts(runtimeData);
      const configParts = extractHostParts(configData);
      const statusExtensions = statusData?.extensions || {};
      const statusAttributes = statusExtensions.attributes || statusData?.attributes || {};
      const allLabels = {
        ...pickObject(configParts.attributes.labels || configParts.extensions.labels),
        ...pickObject(runtimeParts.attributes.labels || runtimeParts.extensions.labels),
        ...pickObject(statusAttributes.labels || statusExtensions.labels),
        ...pickObject(runtimeParts.attributes.discovered_labels || runtimeParts.extensions.discovered_labels),
        ...pickObject(configParts.attributes.discovered_labels || configParts.extensions.discovered_labels)
      };
      const labels = pickObject(allLabels);
      hostDetails = {
        hostName: hostName,
        title: primaryData.title || hostName,
        labels: labels,
        discoveredLabels: {},
        os: pickValue(runtimeParts.attributes.os, runtimeParts.attributes.agent_os, configParts.attributes.os, configParts.attributes.agent_os) || null,
        osFamily: pickValue(runtimeParts.attributes.os_family, configParts.attributes.os_family) || null,
        agentVersion: pickValue(runtimeParts.attributes.agent_version, configParts.attributes.agent_version) || null,
        alias: pickValue(runtimeParts.attributes.alias, configParts.attributes.alias) || null,
        ipAddress: pickValue(runtimeParts.attributes.ipaddress, runtimeParts.attributes.ip_address, statusAttributes.address, configParts.attributes.ipaddress, configParts.attributes.ip_address) || null,
        tags: pickObject(runtimeParts.attributes.tag_groups || runtimeParts.attributes.tags, configParts.attributes.tag_groups || configParts.attributes.tags),
        parents: pickArray(runtimeParts.attributes.parents || runtimeParts.extensions.parents, configParts.attributes.parents || configParts.extensions.parents),
        children: pickArray(runtimeParts.attributes.children || runtimeParts.extensions.children, configParts.attributes.children || configParts.extensions.children),
        state: (() => {
          const rawState = pickValue(runtimeParts.attributes.state, statusAttributes.state, configParts.attributes.state);
          if (rawState === null || rawState === undefined) return null;
          const stateStr = String(rawState).toUpperCase().trim();
          if (stateStr === 'UP' || stateStr === 'DOWN' || stateStr === 'UNREACHABLE') {
            return stateStr;
          }
          const stateNum = parseInt(rawState);
          if (!isNaN(stateNum)) {
            if (stateNum === 0) return 'UP';
            if (stateNum === 1) return 'DOWN';
            if (stateNum === 2) return 'UNREACHABLE';
          }
          return rawState;
        })(),
        stateType: pickValue(runtimeParts.attributes.state_type, statusAttributes.state_type, configParts.attributes.state_type) || null,
        pluginOutput: pickValue(statusAttributes.plugin_output, statusAttributes.long_plugin_output) || null,
        perfData: pickValue(statusAttributes.perf_data, statusAttributes.performance_data) || null,
        lastCheck: pickValue(statusAttributes.last_check) || null,
        lastStateChange: pickValue(statusAttributes.last_state_change) || null,
        serviceStats: {
          total: pickValue(statusAttributes.num_services) || null,
          ok: pickValue(statusAttributes.num_services_ok) || null,
          warn: pickValue(statusAttributes.num_services_warn) || null,
          crit: pickValue(statusAttributes.num_services_crit) || null,
          unknown: pickValue(statusAttributes.num_services_unknown) || null,
          worstState: pickValue(statusAttributes.worst_service_state) || null
        },
        checkInterval: pickValue(statusAttributes.check_interval, configParts.attributes.check_interval) || null,
        retryInterval: pickValue(statusAttributes.retry_interval, configParts.attributes.retry_interval) || null,
        notificationPeriod: pickValue(statusAttributes.notification_period, configParts.attributes.notification_period) || null,
        checkCommand: pickValue(statusAttributes.check_command, configParts.attributes.check_command) || null,
        currentAttempt: pickValue(statusAttributes.current_attempt) || null,
        contactGroups: pickArray(statusAttributes.contact_groups, configParts.attributes.contact_groups),
        hostGroups: pickArray(statusAttributes.groups, configParts.attributes.groups),
        customVariables: pickObject(statusAttributes.custom_variables, configParts.attributes.custom_variables),
        inDowntime: runtimeParts.attributes.scheduled_downtime_depth > 0 || configParts.attributes.scheduled_downtime_depth > 0 || false,
        acknowledged: runtimeParts.attributes.problem_has_been_acknowledged || configParts.attributes.problem_has_been_acknowledged || false,
        raw: primaryData,
        statusRaw: statusData || null
      };
    }
    if (!hostDetails) {
      return res.status(404).json({
        error: 'Host not found',
        details: lastError || 'No endpoint available'
      });
    }
    res.json(hostDetails);
  } catch (error) {
    res.status(500).json({
      error: 'Error retrieving host details',
      details: error.message
    });
  }
});
router.get('/hosts', verifyJWT, async (req, res) => {
  try {
    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({
        success: false,
        error: 'Check MK configuration incomplete',
        details: 'Please configure the URL, username and password in settings'
      });
    }
    let authData;
    try {
      authData = await authenticateCheckMK(settings.apiUrl, settings.username, settings.password);
    } catch (authError) {
      return res.status(401).json({
        success: false,
        error: 'Check MK authentication error',
        details: authError.message || 'Invalid credentials'
      });
    }
    const possibleEndpoints = [`${settings.apiUrl}/domain-types/host_config/collections/all`, `${settings.apiUrl}/objects/host`, `${settings.apiUrl}/objects/host_config`, `${settings.apiUrl}/hosts`];
    let hostsUrl = possibleEndpoints[0];
    let response;
    let lastError;
    for (const endpoint of possibleEndpoints) {
      try {
        response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': authData.auth_header
          }
        });
        if (response.ok) {
          hostsUrl = endpoint;
          break;
        } else if (response.status !== 404) {
          hostsUrl = endpoint;
          break;
        }
        lastError = `404 - Endpoint not found: ${endpoint}`;
      } catch (fetchError) {
        lastError = fetchError.message;
        continue;
      }
    }
    if (!response) {
      throw new Error(`No valid endpoint found. Last error: ${lastError}`);
    }
    const responseText = await response.text();
    if (!response.ok) {
      let errorDetails = responseText;
      try {
        const errorJson = JSON.parse(responseText);
        errorDetails = errorJson.title || errorJson.detail || errorJson.message || responseText;
      } catch (e) {}
      return res.status(response.status === 401 ? 401 : 500).json({
        success: false,
        error: `Check MK error (${response.status})`,
        details: errorDetails,
        url: hostsUrl
      });
    }
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      return res.status(500).json({
        success: false,
        error: 'Invalid Check MK response (non-JSON)',
        details: responseText.substring(0, 500)
      });
    }
    res.json(data);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Error retrieving hosts',
      details: error.message || 'Unknown error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});
router.get('/availability-table/:hostName', verifyJWT, async (req, res) => {
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
    let baseUrl = settings.apiUrl;
    baseUrl = baseUrl.replace(/\/check_mk\/api\/1\.0\/?$/, '');
    baseUrl = baseUrl.replace(/\/check_mk\/api\/?$/, '');
    baseUrl = baseUrl.replace(/\/api\/?$/, '');
    baseUrl = baseUrl.replace(/\/+$/, '');
    const checkmkSite = site || settings.site || '';
    const viewUrl = `${baseUrl}/check_mk/view.py`;
    const urlParams = new URLSearchParams({
      host: hostName,
      mode: 'availability',
      output_format: 'json_export',
      view_name: 'hoststatus'
    });
    if (checkmkSite) {
      urlParams.append('site', checkmkSite);
    }
    if (start_time && end_time) {
      const startDate = new Date(start_time);
      const endDate = new Date(end_time);
      if (!Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime())) {
        urlParams.append('av_from', String(Math.floor(startDate.getTime() / 1000)));
        urlParams.append('av_to', String(Math.floor(endDate.getTime() / 1000)));
      }
    }
    const fullUrl = `${viewUrl}?${urlParams.toString()}`;
    const authData = await authenticateCheckMK(settings.apiUrl, settings.username, settings.password);
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
          availability: null,
          warning: `Unable to retrieve availability: ${response.status}`
        });
      }
      const html = await response.text();
      let availabilityData = null;
      const hostPattern = new RegExp(`<tr[^>]*class="data[^"]*"[^>]*>.*?<td[^>]*>.*?<a[^>]*>${hostName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>.*?</td>(.*?)</tr>`, 'is');
      const match = html.match(hostPattern);
      if (match && match[1]) {
        const spanPattern = /<span[^>]*>([0-9.]+)%<\/span>/g;
        const values = [];
        let spanMatch;
        while ((spanMatch = spanPattern.exec(match[1])) !== null) {
          values.push(parseFloat(spanMatch[1]));
        }
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
          const rowContent = rowMatch[1];
          if (rowContent.includes(hostName)) {
            const spanPattern = /<span[^>]*>([0-9.]+)%<\/span>/g;
            const values = [];
            let spanMatch;
            while ((spanMatch = spanPattern.exec(rowContent)) !== null) {
              values.push(parseFloat(spanMatch[1]));
            }
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
              break;
            }
          }
        }
      }
      res.json({
        host_name: hostName,
        availability: availabilityData
      });
    } catch (fetchError) {
      return res.json({
        host_name: hostName,
        availability: null,
        warning: `Error retrieving availability: ${fetchError.message}`
      });
    }
  } catch (error) {
    res.json({
      host_name: req.params.hostName,
      availability: null,
      error: error.message
    });
  }
});
export default router;
