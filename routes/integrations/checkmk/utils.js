import fetch from 'node-fetch';
import { getSettingsMap } from '../../../utils/settingsHelper.js';
export function extractPerformanceValue(performanceData, pluginOutput) {
  if (!performanceData && !pluginOutput) return null;
  if (performanceData) {
    const perfStr = String(performanceData);
    const patterns = [/(\d+(?:\.\d+)?)\s*(%|GB|MB|KB|ms|s)/i, /=\s*(\d+(?:\.\d+)?)\s*(%|GB|MB|KB)/i, /(\d+(?:\.\d+)?)\s*%/i];
    for (const pattern of patterns) {
      const match = perfStr.match(pattern);
      if (match) {
        return {
          value: parseFloat(match[1]),
          unit: match[2] || '%',
          raw: performanceData
        };
      }
    }
  }
  if (pluginOutput) {
    const output = String(pluginOutput);
    const patterns = [/(\d+(?:\.\d+)?)\s*(%|GB|MB|KB|ms|s)/i, /:\s*(\d+(?:\.\d+)?)\s*(%|GB|MB|KB)/i, /(\d+(?:\.\d+)?)\s*%/i];
    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        return {
          value: parseFloat(match[1]),
          unit: match[2] || '%',
          raw: pluginOutput
        };
      }
    }
  }
  return {
    raw: performanceData || pluginOutput
  };
}
export async function getCheckMKSettings() {
  try {
    const settings = await getSettingsMap(['CHECKMK_API_URL', 'CHECKMK_USERNAME', 'CHECKMK_PASSWORD', 'CHECKMK_SITE']);
    let apiUrl = (settings.CHECKMK_API_URL || '').trim();
    while (apiUrl && apiUrl.endsWith('/')) {
      apiUrl = apiUrl.slice(0, -1);
    }
    return {
      apiUrl: apiUrl,
      username: settings.CHECKMK_USERNAME || '',
      password: settings.CHECKMK_PASSWORD || '',
      site: settings.CHECKMK_SITE || ''
    };
  } catch (error) {
    return null;
  }
}
export async function authenticateCheckMK(apiUrl, username, password) {
  try {
    if (!apiUrl || !username || !password) {
      throw new Error('URL, username and password required');
    }
    const authHeader = `Bearer ${username} ${password}`;
    const testUrl = `${apiUrl}/version`;
    let testResponse;
    try {
      testResponse = await fetch(testUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': authHeader
        }
      });
    } catch (fetchError) {
      throw new Error(`Unable to connect to Check MK: ${fetchError.message}`);
    }
    if (testResponse.ok || testResponse.status === 404) {
      return {
        auth_token: authHeader,
        auth_type: 'bearer',
        auth_header: authHeader
      };
    }
    if (testResponse.status === 401 || testResponse.status === 403) {
      const errorText = await testResponse.text().catch(() => '');
      throw new Error(`Invalid Check MK credentials (${testResponse.status}): ${errorText.substring(0, 200)}`);
    }
    return {
      auth_token: authHeader,
      auth_type: 'bearer',
      auth_header: authHeader
    };
  } catch (error) {
    throw error;
  }
}
export async function getHostServices(apiUrl, authToken, hostName, site = '') {
  try {
    const columns = ['host_name', 'description', 'display_name', 'state', 'state_type', 'plugin_output', 'long_plugin_output', 'perf_data', 'performance_data', 'last_check', 'last_state_change', 'check_command', 'check_command_expanded', 'acknowledged', 'scheduled_downtime_depth', 'labels', 'label_sources', 'label_source_names', 'label_source_values'];
    const normalizeServices = items => {
      const statusItems = items || [];
      return statusItems.map(item => {
        const extensions = item.extensions || {};
        const attributes = extensions.attributes || item.attributes || {};
        const data = Object.keys(attributes).length > 0 ? attributes : extensions;
        const id = item.id || data.description || data.display_name || 'unknown';
        const title = data.display_name || data.description || id;
        const description = data.description || data.display_name || '';
        const state = data.state;
        const stateType = data.state_type;
        const pluginOutput = data.plugin_output || data.long_plugin_output;
        const longPluginOutput = data.long_plugin_output;
        const performanceData = data.perf_data || data.performance_data;
        const lastCheck = data.last_check;
        const lastStateChange = data.last_state_change;
        const labels = data.labels || {};
        const performanceValue = extractPerformanceValue(performanceData, pluginOutput);
        return {
          id,
          title,
          description,
          state,
          stateType,
          pluginOutput,
          longPluginOutput,
          performanceData,
          lastCheck,
          lastStateChange,
          labels,
          performanceValue,
          raw: item
        };
      });
    };
    const getServiceDescription = service => {
      if (service.description) return service.description;
      if (service.id && service.id.includes(':')) {
        return service.id.split(':').slice(1).join(':');
      }
      return service.title || service.id || '';
    };
    const enrichServiceFromShowService = async service => {
      const needsState = service.state === undefined || service.state === null;
      const needsStateType = service.stateType === undefined || service.stateType === null;
      const needsLastCheck = service.lastCheck === undefined || service.lastCheck === null;
      const needsPluginOutput = !service.pluginOutput && !service.longPluginOutput;
      if (!needsState && !needsStateType && !needsLastCheck && !needsPluginOutput) return service;
      const description = getServiceDescription(service);
      if (!description) return service;
      const showUrl = new URL(`${apiUrl}/objects/host/${encodeURIComponent(hostName)}/actions/show_service/invoke`);
      showUrl.searchParams.set('service_description', description);
      if (site) {
        showUrl.searchParams.set('site', site);
      }
      try {
        const response = await fetch(showUrl.toString(), {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': authToken
          }
        });
        if (!response.ok) return service;
        const data = await response.json();
        const extensions = data?.extensions || {};
        return {
          ...service,
          state: service.state ?? extensions.state,
          stateType: service.stateType ?? extensions.state_type,
          lastCheck: service.lastCheck ?? extensions.last_check,
          pluginOutput: service.pluginOutput ?? extensions.plugin_output ?? service.pluginOutput,
          longPluginOutput: service.longPluginOutput ?? extensions.long_plugin_output ?? service.longPluginOutput,
          performanceData: service.performanceData ?? extensions.perf_data ?? extensions.performance_data ?? service.performanceData
        };
      } catch (error) {
        return service;
      }
    };
    const enrichServices = async services => {
      const needsEnrichment = services.some(service => service.state === undefined || service.state === null || service.stateType === undefined || service.stateType === null || service.lastCheck === undefined || service.lastCheck === null || !service.pluginOutput && !service.longPluginOutput);
      if (!needsEnrichment) return services;
      const enriched = await Promise.all(services.map(service => enrichServiceFromShowService(service)));
      return enriched;
    };
    const tryFetchServicesTable = async params => {
      const statusUrl = new URL(`${apiUrl}/domain-types/service/collections/all`);
      statusUrl.searchParams.set('columns', columns.join(','));
      Object.entries(params).forEach(([key, value]) => {
        statusUrl.searchParams.set(key, value);
      });
      if (site) {
        statusUrl.searchParams.set('site', site);
      }
      const response = await fetch(statusUrl.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': authToken
        }
      });
      if (!response.ok) return [];
      const body = await response.json();
      const items = body.value || body.items || body || [];
      const services = normalizeServices(items);
      return await enrichServices(services);
    };
    try {
      const queryExpression = JSON.stringify({
        op: 'eq',
        left: 'host_name',
        right: hostName
      });
      const services = await tryFetchServicesTable({
        query: queryExpression
      });
      if (services.length > 0) return services;
    } catch (statusError) {}
    try {
      const queryExpression = JSON.stringify({
        op: '=',
        left: 'host_name',
        right: hostName
      });
      const services = await tryFetchServicesTable({
        query: queryExpression
      });
      if (services.length > 0) return services;
    } catch (statusError) {}
    try {
      const filterExpression = JSON.stringify({
        op: 'and',
        expr: [{
          op: 'eq',
          left: 'host_name',
          right: hostName
        }]
      });
      const services = await tryFetchServicesTable({
        filter: filterExpression
      });
      if (services.length > 0) return services;
    } catch (statusError) {}
    try {
      const servicesUrl = new URL(`${apiUrl}/objects/host/${encodeURIComponent(hostName)}/collections/services`);
      if (site) {
        servicesUrl.searchParams.set('site', site);
      }
      const response = await fetch(servicesUrl.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': authToken
        }
      });
      if (response.ok) {
        const data = await response.json();
        const items = data.value || data.items || data || [];
        if (items.length > 0) {
          const services = normalizeServices(items);
          return await enrichServices(services);
        }
      }
    } catch (statusError) {}
    try {
      const hostUrl = new URL(`${apiUrl}/domain-types/host/objects/${encodeURIComponent(hostName)}`);
      if (site) {
        hostUrl.searchParams.set('site', site);
      }
      const response = await fetch(hostUrl.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': authToken
        }
      });
      if (response.ok) {
        const data = await response.json();
        const services = data?.extensions?.services || [];
        if (services.length > 0) {
          const normalized = services.map(service => ({
            id: service.id || service.title || service.name || 'unknown',
            title: service.title || service.display_name || service.id || service.name,
            description: service.description || service.display_name || '',
            state: service.state,
            stateType: service.state_type,
            pluginOutput: service.plugin_output || service.long_plugin_output,
            longPluginOutput: service.long_plugin_output,
            performanceData: service.perf_data || service.performance_data,
            lastCheck: service.last_check,
            lastStateChange: service.last_state_change,
            labels: service.labels || {},
            performanceValue: extractPerformanceValue(service.perf_data || service.performance_data, service.plugin_output),
            raw: service
          }));
          return await enrichServices(normalized);
        }
      }
    } catch (statusError) {}
    return [];
  } catch (error) {
    return [];
  }
}
const VIEW_PY_PLUGIN_OUTPUT_HEADERS = ['svc_plugin_output', 'Plugin output', 'Plugin Output', 'Service plugin output'];
const VIEW_PY_LONG_PLUGIN_HEADERS = ['svc_long_plugin_output', 'Long plugin output', 'Long Plugin Output'];
const VIEW_PY_PERF_HEADERS = ['svc_perf_data', 'Perf data', 'Performance data', 'svc_performance_data'];
function findHeaderIndex(headers, candidates) {
  if (!Array.isArray(headers)) return -1;
  for (const name of candidates) {
    const i = headers.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}
export async function getServicePluginOutputViaViewPy(apiUrl, authHeader, hostName, serviceName, site = '') {
  try {
    const rawServiceName = (serviceName || '').trim();
    if (!rawServiceName) return null;
    const serviceForView = rawServiceName.includes(':') ? rawServiceName.replace(/^[^:]+:\s*/, '').trim() : rawServiceName;
    let baseUrl = apiUrl;
    if (baseUrl.includes('/api/1.0')) baseUrl = baseUrl.replace('/api/1.0', '');
    baseUrl = baseUrl.replace(/\/+$/, '');
    const viewPyUrl = `${baseUrl}/view.py`;
    const viewParams = new URLSearchParams();
    viewParams.append('host', hostName);
    viewParams.append('service', serviceForView);
    viewParams.append('view_name', 'service');
    viewParams.append('output_format', 'json_export');
    if (site) viewParams.append('site', site);
    const viewUrl = `${viewPyUrl}?${viewParams.toString()}`;
    const response = await fetch(viewUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: authHeader
      }
    });
    if (!response.ok) return null;
    const viewData = await response.json();
    let headers = [];
    let values = [];
    if (Array.isArray(viewData) && viewData.length >= 2) {
      headers = viewData[0] || [];
      values = viewData[1] || [];
    } else if (viewData && Array.isArray(viewData.columns) && viewData.rows && viewData.rows[0]) {
      headers = viewData.columns;
      values = viewData.rows[0];
    }
    if (headers.length === 0 || values.length === 0) return null;
    const pluginOutputIdx = findHeaderIndex(headers, VIEW_PY_PLUGIN_OUTPUT_HEADERS);
    const longPluginIdx = findHeaderIndex(headers, VIEW_PY_LONG_PLUGIN_HEADERS);
    const perfIdx = findHeaderIndex(headers, VIEW_PY_PERF_HEADERS);
    const pluginOutput = pluginOutputIdx >= 0 ? values[pluginOutputIdx] : null;
    const longPluginOutput = longPluginIdx >= 0 ? values[longPluginIdx] : null;
    const performanceData = perfIdx >= 0 ? values[perfIdx] : null;
    if (!pluginOutput && !longPluginOutput) return null;
    return {
      pluginOutput: pluginOutput || null,
      longPluginOutput: longPluginOutput || null,
      performanceData: performanceData || null
    };
  } catch (e) {
    return null;
  }
}
export async function calculateAvailabilityFromHistory(apiUrl, authToken, hostName, services, startTime, endTime, site = '') {
  try {
    const possibleEndpoints = [`${apiUrl}/domain-types/event/collections/all`, `${apiUrl}/objects/host/${encodeURIComponent(hostName)}/collections/events`, `${apiUrl}/objects/host/${encodeURIComponent(hostName)}/collections/state_history`, `${apiUrl}/domain-types/event/collections/history`];
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    const totalDuration = endDate - startDate;
    if (totalDuration <= 0) {
      return null;
    }
    let events = null;
    let lastError;
    for (const endpoint of possibleEndpoints) {
      try {
        const params = new URLSearchParams();
        params.append('hostname', hostName);
        params.append('start_time', startTime);
        params.append('end_time', endTime);
        if (site) params.append('site', site);
        const url = `${endpoint}?${params.toString()}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': authToken
          }
        });
        if (response.ok) {
          const data = await response.json();
          events = data.value || data.items || data || [];
          break;
        } else if (response.status !== 404) {
          const errorText = await response.text();
          lastError = `Error ${response.status}: ${errorText}`;
          continue;
        }
        lastError = `404 - Endpoint not found: ${endpoint}`;
      } catch (fetchError) {
        lastError = fetchError.message;
        continue;
      }
    }
    if (!events || events.length === 0) {
      return null;
    }
    const availability = {};
    const serviceNames = services.map(s => s.id || s.title || s).filter(Boolean);
    if (!events || events.length === 0) {
      for (const serviceName of serviceNames) {
        const serviceHistoryEndpoints = [`${apiUrl}/objects/host/${encodeURIComponent(hostName)}/collections/services/${encodeURIComponent(serviceName)}/collections/state_history`, `${apiUrl}/objects/service/${encodeURIComponent(hostName)}/${encodeURIComponent(serviceName)}/collections/state_history`, `${apiUrl}/domain-types/service/collections/state_history`];
        for (const endpoint of serviceHistoryEndpoints) {
          try {
            const params = new URLSearchParams();
            params.append('hostname', hostName);
            params.append('service', serviceName);
            params.append('start_time', startTime);
            params.append('end_time', endTime);
            if (site) params.append('site', site);
            const url = `${endpoint}?${params.toString()}`;
            const response = await fetch(url, {
              method: 'GET',
              headers: {
                'Accept': 'application/json',
                'Authorization': authToken
              }
            });
            if (response.ok) {
              const data = await response.json();
              const serviceHistory = data.value || data.items || data || [];
              if (Array.isArray(serviceHistory) && serviceHistory.length > 0) {
                if (!events) events = [];
                serviceHistory.forEach(event => {
                  event.service_name = serviceName;
                });
                events.push(...serviceHistory);
                break;
              }
            }
          } catch (fetchError) {
            continue;
          }
        }
      }
    }
    if (!events || events.length === 0) {
      return null;
    }
    for (const serviceName of serviceNames) {
      const serviceEvents = events.filter(event => {
        const eventService = event.service || event.service_name || event.service_description || event.service_display_name;
        const normalizedEventService = eventService ? String(eventService).trim() : '';
        const normalizedServiceName = String(serviceName).trim();
        if (normalizedEventService === normalizedServiceName) return true;
        if (normalizedEventService === normalizedServiceName.replace('Filesystem ', '')) return true;
        if (normalizedEventService.replace('Filesystem ', '') === normalizedServiceName) return true;
        if (normalizedEventService.toLowerCase() === normalizedServiceName.toLowerCase()) return true;
        return false;
      });
      if (serviceEvents.length === 0) {
        continue;
      }
      let timeOK = 0;
      let timeWARN = 0;
      let timeCRIT = 0;
      serviceEvents.sort((a, b) => {
        const timeA = new Date(a.time || a.from || a.timestamp || 0).getTime();
        const timeB = new Date(b.time || b.from || b.timestamp || 0).getTime();
        return timeA - timeB;
      });
      let currentState = 0;
      let lastTime = startDate.getTime();
      for (const event of serviceEvents) {
        const eventTime = new Date(event.time || event.from || event.timestamp || startTime).getTime();
        const state = event.state || event.state_type || 0;
        const duration = Math.max(0, eventTime - lastTime);
        if (currentState === 0) timeOK += duration;else if (currentState === 1) timeWARN += duration;else if (currentState === 2) timeCRIT += duration;
        currentState = state;
        lastTime = eventTime;
      }
      const remainingDuration = Math.max(0, endDate.getTime() - lastTime);
      if (currentState === 0) timeOK += remainingDuration;else if (currentState === 1) timeWARN += remainingDuration;else if (currentState === 2) timeCRIT += remainingDuration;
      const okPercent = Math.round(timeOK / totalDuration * 100);
      const warnPercent = Math.round(timeWARN / totalDuration * 100);
      const critPercent = Math.round(timeCRIT / totalDuration * 100);
      const total = okPercent + warnPercent + critPercent;
      if (total > 0) {
        availability[serviceName] = {
          ok: okPercent,
          warn: warnPercent,
          crit: critPercent
        };
      }
    }
    return {
      availability
    };
  } catch (error) {
    return null;
  }
}
export async function getHostStateHistory(apiUrl, authToken, hostName, startTime, endTime, site = '') {
  try {
    const possibleEndpoints = [`${apiUrl}/objects/host/${encodeURIComponent(hostName)}/collections/state_history`, `${apiUrl}/objects/host_config/${encodeURIComponent(hostName)}/collections/state_history`, `${apiUrl}/domain-types/host/collections/state_history?hostname=${encodeURIComponent(hostName)}`, `${apiUrl}/objects/host/${encodeURIComponent(hostName)}/actions/state_history/invoke`];
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    const totalDuration = endDate - startDate;
    if (totalDuration <= 0) {
      return null;
    }
    let events = [];
    let lastError;
    for (const endpoint of possibleEndpoints) {
      try {
        let url = endpoint;
        if (endpoint.includes('?')) {
          url += `&start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`;
        } else {
          url += `?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`;
        }
        if (site) {
          url += `&site=${encodeURIComponent(site)}`;
        }
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': authToken
          }
        });
        if (response.ok) {
          const data = await response.json();
          events = data.value || data.items || data.events || data || [];
          break;
        } else if (response.status !== 404) {
          const errorText = await response.text();
          lastError = `Error ${response.status}: ${errorText}`;
          continue;
        }
        lastError = `404 - Endpoint not found: ${endpoint}`;
      } catch (fetchError) {
        lastError = fetchError.message;
        continue;
      }
    }
    if (!events || events.length === 0) {
      return null;
    }
    let timeUP = 0;
    let timeDOWN = 0;
    let timeUNREACHABLE = 0;
    events.sort((a, b) => {
      const timeA = new Date(a.time || a.from || a.timestamp || startTime).getTime();
      const timeB = new Date(b.time || b.from || b.timestamp || startTime).getTime();
      return timeA - timeB;
    });
    let currentState = 0;
    let lastTime = startDate.getTime();
    if (events.length > 0) {
      const firstEvent = events[0];
      const firstEventTime = new Date(firstEvent.time || firstEvent.from || firstEvent.timestamp || startTime).getTime();
      const initialDuration = Math.max(0, firstEventTime - lastTime);
      timeUP += initialDuration;
      lastTime = firstEventTime;
      currentState = firstEvent.state || firstEvent.state_type || 0;
    }
    for (const event of events) {
      const eventTime = new Date(event.time || event.from || event.timestamp || startTime).getTime();
      const state = event.state || event.state_type || 0;
      const duration = Math.max(0, eventTime - lastTime);
      if (currentState === 0) timeUP += duration;else if (currentState === 1) timeDOWN += duration;else if (currentState === 2) timeUNREACHABLE += duration;
      currentState = state;
      lastTime = eventTime;
    }
    const remainingDuration = Math.max(0, endDate.getTime() - lastTime);
    if (currentState === 0) timeUP += remainingDuration;else if (currentState === 1) timeDOWN += remainingDuration;else if (currentState === 2) timeUNREACHABLE += remainingDuration;
    const availabilityRate = totalDuration > 0 ? timeUP / totalDuration * 100 : 100;
    const incidents = events.filter(e => {
      const state = e.state || e.state_type || 0;
      return state === 1 || state === 2;
    });
    let mttr = null;
    let mtbf = null;
    if (incidents.length > 0) {
      const incidentDurations = [];
      for (let i = 0; i < incidents.length; i++) {
        const incidentStart = new Date(incidents[i].time || incidents[i].from || incidents[i].timestamp || startTime).getTime();
        const nextUP = events.find(e => {
          const eTime = new Date(e.time || e.from || e.timestamp || startTime).getTime();
          const eState = e.state || e.state_type || 0;
          return eTime > incidentStart && eState === 0;
        });
        if (nextUP) {
          const incidentEnd = new Date(nextUP.time || nextUP.from || nextUP.timestamp || startTime).getTime();
          const duration = incidentEnd - incidentStart;
          if (duration > 0) {
            incidentDurations.push(duration);
          }
        } else {
          const duration = endDate.getTime() - incidentStart;
          if (duration > 0) {
            incidentDurations.push(duration);
          }
        }
      }
      if (incidentDurations.length > 0) {
        mttr = incidentDurations.reduce((a, b) => a + b, 0) / incidentDurations.length / 1000 / 60;
      }
      if (incidents.length > 1) {
        const intervals = [];
        for (let i = 1; i < incidents.length; i++) {
          const prevTime = new Date(incidents[i - 1].time || incidents[i - 1].from || incidents[i - 1].timestamp || startTime).getTime();
          const currTime = new Date(incidents[i].time || incidents[i].from || incidents[i].timestamp || startTime).getTime();
          const interval = currTime - prevTime;
          if (interval > 0) {
            intervals.push(interval);
          }
        }
        if (intervals.length > 0) {
          mtbf = intervals.reduce((a, b) => a + b, 0) / intervals.length / 1000 / 60;
        }
      }
    }
    return {
      timeUP,
      timeDOWN,
      timeUNREACHABLE,
      availabilityRate: Math.round(availabilityRate * 100) / 100,
      mttr: mttr ? Math.round(mttr * 100) / 100 : null,
      mtbf: mtbf ? Math.round(mtbf * 100) / 100 : null,
      incidentsCount: incidents.length
    };
  } catch (error) {
    return null;
  }
}
export async function getAvailabilityAnalysis(apiUrl, authToken, hostName, startTime, endTime, site = '') {
  try {
    const availabilityEndpoints = [{
      url: `${apiUrl}/domain-types/availability/actions/analyze/invoke`,
      method: 'POST',
      body: {
        hostnames: [hostName],
        query_time_range: {
          start_time: startTime,
          end_time: endTime
        },
        ...(site && {
          site: site
        })
      }
    }, {
      url: `${apiUrl}/domain-types/availability/actions/analyze/invoke`,
      method: 'POST',
      body: {
        hostnames: [hostName],
        query_time_range: {
          start_time: startTime,
          end_time: endTime
        }
      }
    }, {
      url: `${apiUrl}/objects/host/${encodeURIComponent(hostName)}/collections/availability`,
      method: 'GET',
      params: {
        start_time: startTime,
        end_time: endTime,
        ...(site && {
          site: site
        })
      }
    }, {
      url: `${apiUrl}/domain-types/availability/collections/all`,
      method: 'GET',
      params: {
        hostname: hostName,
        start_time: startTime,
        end_time: endTime,
        ...(site && {
          site: site
        })
      }
    }, {
      url: `${apiUrl}/objects/host/${encodeURIComponent(hostName)}/actions/availability/invoke`,
      method: 'POST',
      body: {
        query_time_range: {
          start_time: startTime,
          end_time: endTime
        },
        ...(site && {
          site: site
        })
      }
    }];
    let lastError;
    for (const endpointConfig of availabilityEndpoints) {
      try {
        let url = endpointConfig.url;
        if (endpointConfig.params) {
          const params = new URLSearchParams();
          Object.entries(endpointConfig.params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
              params.append(key, value);
            }
          });
          url += '?' + params.toString();
        }
        const fetchOptions = {
          method: endpointConfig.method,
          headers: {
            'Accept': 'application/json',
            'Authorization': authToken
          }
        };
        if (endpointConfig.method === 'POST' && endpointConfig.body) {
          fetchOptions.headers['Content-Type'] = 'application/json';
          fetchOptions.body = JSON.stringify(endpointConfig.body);
        }
        const response = await fetch(url, fetchOptions);
        if (response.ok) {
          const data = await response.json();
          return data;
        } else if (response.status !== 404) {
          const errorText = await response.text();
          lastError = `Error ${response.status}: ${errorText}`;
          continue;
        }
        lastError = `404 - Endpoint not found: ${url}`;
      } catch (fetchError) {
        lastError = fetchError.message;
        continue;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}
export function parseCheckMKEventTime(event) {
  if (!event || typeof event !== 'object') return null;
  const candidates = [event.time, event.timestamp, event.date, event.log_time];
  for (const raw of candidates) {
    if (raw == null || raw === '') continue;
    if (typeof raw === 'number') {
      const ms = raw < 10000000000 ? raw * 1000 : raw;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date;
      continue;
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const europeanMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
      if (europeanMatch) {
        const [, day, month, year, hour, minute, second] = europeanMatch;
        const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
        if (!Number.isNaN(date.getTime())) return date;
      }
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) return new Date(parsed);
    }
  }
  return null;
}
export function computeCheckMKLogtimeFromDays(startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 30;
  const anchor = Math.min(start.getTime(), end.getTime());
  const daysBack = Math.ceil((Date.now() - anchor) / (1000 * 60 * 60 * 24)) + 1;
  return Math.max(1, daysBack);
}
export function filterCheckMKEventsByPeriod(events, startTime, endTime, {
  criticalOnly = false
} = {}) {
  if (!Array.isArray(events)) return [];
  const start = new Date(startTime);
  const end = new Date(endTime);
  const hasValidBounds = !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime());
  let filtered = events;
  if (hasValidBounds) {
    filtered = events.filter(event => {
      const eventDate = parseCheckMKEventTime(event);
      if (!eventDate) return false;
      return eventDate >= start && eventDate <= end;
    });
  }
  if (criticalOnly) {
    filtered = filtered.filter(event => event.state === 2);
  }
  return filterCheckMKNoiseEvents(filtered);
}
function getCheckMKEventServiceLabel(event) {
  return String(event?.service || event?.service_description || event?.display_name || event?.description || '').trim();
}
function getCheckMKEventMessage(event) {
  return String(event?.message || event?.plugin_output || event?.text || event?.output || '').trim();
}
export function isCheckMKNoiseEvent(event) {
  const service = getCheckMKEventServiceLabel(event);
  const message = getCheckMKEventMessage(event);
  const normalizedService = service.replace(/^\[+|\]+$/g, '').toLowerCase();
  if (normalizedService === 'snmp' || normalizedService === 'piggyback') {
    return true;
  }
  if (/^\[snmp\]/i.test(service) || /^\[piggyback\]/i.test(service)) {
    return true;
  }
  if (/^\[snmp\]/i.test(message) || /^\[piggyback\]/i.test(message)) {
    return true;
  }
  if (/^SNMP Error$/i.test(message) && /snmp/i.test(service)) {
    return true;
  }
  return false;
}
export function filterCheckMKNoiseEvents(events = []) {
  if (!Array.isArray(events)) return [];
  return events.filter(event => !isCheckMKNoiseEvent(event));
}
