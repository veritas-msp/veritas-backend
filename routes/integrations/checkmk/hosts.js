// ───────────────────────────────────────────────
// 🏠 Check MK host routes
// ───────────────────────────────────────────────

import express from 'express';
import fetch from 'node-fetch';
import verifyJWT from '../../../middleware/auth.js';
import { getCheckMKSettings, authenticateCheckMK } from './utils.js';

const router = express.Router();

// ───────────────────────────────────────────────
// 🏠 GET /api/checkmk/host/:hostName — Fetch details for a host (labels, OS, etc.)
// ───────────────────────────────────────────────
router.get('/host/:hostName', verifyJWT, async (req, res) => {
  try {
    const { hostName } = req.params;
    const { site } = req.query;
    
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
    
    // Try to fetch host details
    const possibleEndpoints = [
      `${settings.apiUrl}/objects/host/${encodeURIComponent(hostName)}`,
      `${settings.apiUrl}/domain-types/host/objects/${encodeURIComponent(hostName)}`,
      `${settings.apiUrl}/objects/host_config/${encodeURIComponent(hostName)}`
    ];
    
    let hostDetails = null;
    let lastError = null;
    let runtimeData = null;
    let configData = null;
    let statusData = null;

    const extractHostParts = (data) => {
      const extensions = data?.extensions || {};
      const attributes = extensions.attributes || data?.attributes || {};
      return { extensions, attributes };
    };

    const pickValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');
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
          lastError = `Erreur ${response.status}`;
        }
      } catch (fetchError) {
        lastError = fetchError.message;
        continue;
      }
    }

    try {
      const columns = [
        'name',
        'alias',
        'address',
        'state',
        'state_type',
        'plugin_output',
        'long_plugin_output',
        'perf_data',
        'performance_data',
        'last_check',
        'last_state_change',
        'last_time_up',
        'last_time_down',
        'last_time_unreachable',
        'num_services',
        'num_services_ok',
        'num_services_warn',
        'num_services_crit',
        'num_services_unknown',
        'worst_service_state',
        'labels',
        'label_sources',
        'label_source_names',
        'label_source_values',
        // Additional information
        'scheduled_downtime_depth',
        'in_downtime',
        'problem_has_been_acknowledged',
        'acknowledged',
        'check_interval',
        'retry_interval',
        'notification_period',
        'check_command',
        'custom_variables',
        'groups',
        'contact_groups',
        'current_attempt',
        'display_name'
      ];

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
    } catch (statusError) {
      // Ignores status fetch errors and keep database host details.
    }

    const primaryData = runtimeData || configData;
    if (primaryData) {
      const runtimeParts = extractHostParts(runtimeData);
      const configParts = extractHostParts(configData);

      const statusExtensions = statusData?.extensions || {};
      const statusAttributes = statusExtensions.attributes || statusData?.attributes || {};
      
      // Merge labels from all sources
      const allLabels = {
        ...pickObject(configParts.attributes.labels || configParts.extensions.labels),
        ...pickObject(runtimeParts.attributes.labels || runtimeParts.extensions.labels),
        ...pickObject(statusAttributes.labels || statusExtensions.labels),
        // Also add discovered/auto labels
        ...pickObject(
          runtimeParts.attributes.discovered_labels || runtimeParts.extensions.discovered_labels
        ),
        ...pickObject(
          configParts.attributes.discovered_labels || configParts.extensions.discovered_labels
        )
      };
      
      const labels = pickObject(allLabels);

      hostDetails = {
        hostName: hostName,
        title: primaryData.title || hostName,
        // All labels (manual + discovered)
        labels: labels,
        discoveredLabels: {},
        // OS information
        os: pickValue(runtimeParts.attributes.os, runtimeParts.attributes.agent_os, configParts.attributes.os, configParts.attributes.agent_os) || null,
        osFamily: pickValue(runtimeParts.attributes.os_family, configParts.attributes.os_family) || null,
        agentVersion: pickValue(runtimeParts.attributes.agent_version, configParts.attributes.agent_version) || null,
        // Other useful information
        alias: pickValue(runtimeParts.attributes.alias, configParts.attributes.alias) || null,
        ipAddress: pickValue(runtimeParts.attributes.ipaddress, runtimeParts.attributes.ip_address, statusAttributes.address, configParts.attributes.ipaddress, configParts.attributes.ip_address) || null,
        tags: pickObject(runtimeParts.attributes.tag_groups || runtimeParts.attributes.tags, configParts.attributes.tag_groups || configParts.attributes.tags),
        // Network hierarchy
        parents: pickArray(runtimeParts.attributes.parents || runtimeParts.extensions.parents, configParts.attributes.parents || configParts.extensions.parents),
        children: pickArray(runtimeParts.attributes.children || runtimeParts.extensions.children, configParts.attributes.children || configParts.extensions.children),
        // State host
        state: (() => {
          const rawState = pickValue(runtimeParts.attributes.state, statusAttributes.state, configParts.attributes.state);
          // Normalize value state
          if (rawState === null || rawState === undefined) return null;
          const stateStr = String(rawState).toUpperCase().trim();
          // If it is already a string (UP, DOWN, UNREACHABLE)
          if (stateStr === 'UP' || stateStr === 'DOWN' || stateStr === 'UNREACHABLE') {
            return stateStr;
          }
          // If it is a number, convert it
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
        // Check and notification information
        checkInterval: pickValue(statusAttributes.check_interval, configParts.attributes.check_interval) || null,
        retryInterval: pickValue(statusAttributes.retry_interval, configParts.attributes.retry_interval) || null,
        notificationPeriod: pickValue(statusAttributes.notification_period, configParts.attributes.notification_period) || null,
        checkCommand: pickValue(statusAttributes.check_command, configParts.attributes.check_command) || null,
        currentAttempt: pickValue(statusAttributes.current_attempt) || null,
        contactGroups: pickArray(statusAttributes.contact_groups, configParts.attributes.contact_groups),
        hostGroups: pickArray(statusAttributes.groups, configParts.attributes.groups),
        customVariables: pickObject(statusAttributes.custom_variables, configParts.attributes.custom_variables),
        // Monitoring information
        inDowntime: (runtimeParts.attributes.scheduled_downtime_depth > 0) || (configParts.attributes.scheduled_downtime_depth > 0) || false,
        acknowledged: runtimeParts.attributes.problem_has_been_acknowledged || configParts.attributes.problem_has_been_acknowledged || false,
        // Raw data
        raw: primaryData,
        statusRaw: statusData || null
      };
    }
    
    if (!hostDetails) {
      return res.status(404).json({ 
        error: 'Host non trouvé',
        details: lastError || 'Aucun endpoint disponible'
      });
    }
    
    res.json(hostDetails);
    
  } catch (error) {
    res.status(500).json({ 
      error: 'Erreur lors de la récupération des détails du host',
      details: error.message 
    });
  }
});

// ───────────────────────────────────────────────
// 🔍 GET /api/checkmk/hosts — List available Check MK hosts
// ───────────────────────────────────────────────
router.get('/hosts', verifyJWT, async (req, res) => {
  try {
    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({ 
        success: false,
        error: 'Configuration Check MK incomplète',
        details: 'Veuillez configurer l\'URL, le nom d\'utilisateur et le mot de passe dans les paramètres'
      });
    }
    
    // Authenticate
    let authData;
    try {
      authData = await authenticateCheckMK(
        settings.apiUrl,
        settings.username,
        settings.password
      );
    } catch (authError) {
      
      return res.status(401).json({
        success: false,
        error: 'Erreur d\'authentification Check MK',
        details: authError.message || 'Identifiants invalides'
      });
    }
    
    // Fetch host list
    // For CheckMK v1.0, try several possible endpoints
    // Format v1.0: /objects/host or /domain-types/host_config/collections/all
    const possibleEndpoints = [
      `${settings.apiUrl}/domain-types/host_config/collections/all`,
      `${settings.apiUrl}/objects/host`,
      `${settings.apiUrl}/objects/host_config`,
      `${settings.apiUrl}/hosts`
    ];
    
    let hostsUrl = possibleEndpoints[0];
    let response;
    let lastError;
    
    // Try each endpoint until one works
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
          // If this is not a 404, keep this response for the error
          hostsUrl = endpoint;
          break;
        }
        // If 404, continue with the next endpoint
        lastError = `404 - Endpoint non trouvé: ${endpoint}`;
      } catch (fetchError) {
        lastError = fetchError.message;
        continue;
      }
    }
    
    if (!response) {
      throw new Error(`Aucun endpoint valide trouvé. Dernière erreur: ${lastError}`);
    }
    
    const responseText = await response.text();
    
    if (!response.ok) {
      let errorDetails = responseText;
      try {
        const errorJson = JSON.parse(responseText);
        errorDetails = errorJson.title || errorJson.detail || errorJson.message || responseText;
      } catch (e) {
        // Keep raw text when this is not JSON
      }
      
      return res.status(response.status === 401 ? 401 : 500).json({
        success: false,
        error: `Erreur Check MK (${response.status})`,
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
        error: 'Réponse Check MK invalide (non-JSON)',
        details: responseText.substring(0, 500)
      });
    }
    
    res.json(data);
    
  } catch (error) {
    
    
    
    
    res.status(500).json({ 
      success: false,
      error: 'Erreur lors de la récupération des hosts',
      details: error.message || 'Erreur inconnue',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ───────────────────────────────────────────────
// 📊 GET /api/checkmk/availability-table/:hostName — Fetch availability array for a host
// ───────────────────────────────────────────────
router.get('/availability-table/:hostName', verifyJWT, async (req, res) => {
  try {
    const { hostName } = req.params;
    const { site, start_time, end_time } = req.query;
    
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
    
    // Build the view.py URL to fetch the availability table
    // Format: https://monitoring.psi.fr/clients/check_mk/view.py?host=...&mode=availability&output_format=json_export&site=clients&view_name=hoststatus
    const viewUrl = `${baseUrl}/check_mk/view.py`;
    
    const urlParams = new URLSearchParams({
      host: hostName,
      mode: 'availability',
      output_format: 'json_export',
      view_name: 'hoststatus'
    });
    
    // Add site to query settings when available
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
          availability: null,
          warning: `Impossible de récupérer la disponibilité: ${response.status}`
        });
      }
      
      // CheckMK may return HTML even with json_export; parse the HTML
      const html = await response.text();
      
      // Parse HTML to extract availability data
      // HTML format: <tr class="data even0">...<td><span>100.00%</span></td>...
      let availabilityData = null;
      
      // Find the data row for this host
      // Pattern: <tr class="data ..."> followed by <td>...<a>hostName</a>... then values in <span>
      const hostPattern = new RegExp(`<tr[^>]*class="data[^"]*"[^>]*>.*?<td[^>]*>.*?<a[^>]*>${hostName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>.*?</td>(.*?)</tr>`, 'is');
      const match = html.match(hostPattern);
      
      if (match && match[1]) {
        // Extract all <span>X.XX%</span> values from this row
        const spanPattern = /<span[^>]*>([0-9.]+)%<\/span>/g;
        const values = [];
        let spanMatch;
        
        while ((spanMatch = spanPattern.exec(match[1])) !== null) {
          values.push(parseFloat(spanMatch[1]));
        }
        
        // Columns are ordered: Host (ignored), UP, DOWN, UNREACH, Flapping, Downtime, N/A
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
      
      // If the pattern did not match, try an alternative approach
      if (!availabilityData) {
        // Search all data rows
        const allRowsPattern = /<tr[^>]*class="data[^"]*"[^>]*>(.*?)<\/tr>/gs;
        let rowMatch;
        
        while ((rowMatch = allRowsPattern.exec(html)) !== null) {
          const rowContent = rowMatch[1];
          
          // Check whether this line contains hostName
          if (rowContent.includes(hostName)) {
            // Extract all <span>X.XX%</span> values
            const spanPattern = /<span[^>]*>([0-9.]+)%<\/span>/g;
            const values = [];
            let spanMatch;
            
            while ((spanMatch = spanPattern.exec(rowContent)) !== null) {
              values.push(parseFloat(spanMatch[1]));
            }
            
            // Columns are ordered: Host (ignored), UP, DOWN, UNREACH, Flapping, Downtime, N/A
            // There may be <td> cells with buttons first, so take the last values
            if (values.length >= 6) {
              // Take the last 6 values (ignore leading cells that may be buttons)
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
        warning: `Erreur lors de la récupération de la disponibilité: ${fetchError.message}`
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
