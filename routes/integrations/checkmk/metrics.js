import express from 'express';
import fetch from 'node-fetch';
import verifyJWT from '../../../middleware/auth.js';
import { getCheckMKSettings, authenticateCheckMK } from './utils.js';
const router = express.Router();
router.get('/metrics/:clientId', verifyJWT, async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const {
      hostname,
      metric,
      service_description,
      start_time,
      end_time,
      site
    } = req.query;
    if (!hostname || !metric || !start_time || !end_time) {
      return res.status(400).json({
        error: 'Missing parameters: hostname, metric, start_time et end_time are required'
      });
    }
    const serviceDesc = service_description || metric;
    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({
        error: 'Check MK configuration incomplete. Please configure settings in Settings.'
      });
    }
    const authData = await authenticateCheckMK(settings.apiUrl, settings.username, settings.password);
    const checkmkSite = site || settings.site || '';
    const apiUrl = settings.apiUrl;
    const normalizedApiUrl = apiUrl.replace(/\/+$/, '');
    const formatDateTime = isoString => {
      const date = new Date(isoString);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      const microseconds = String(date.getMilliseconds() * 1000).padStart(6, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${microseconds}`;
    };
    const reduceTypes = ['min', 'max', 'average'];
    const results = {};
    const filter = {
      host: {
        host: hostname
      }
    };
    if (checkmkSite) {
      filter.siteopt = {
        site: checkmkSite
      };
    }
    if (serviceDesc) {
      filter.service = {
        service: serviceDesc
      };
    }
    for (const reduceType of reduceTypes) {
      const possibleEndpoints = [`${normalizedApiUrl}/cmk/gui/openapi/endpoints/metric/get_graph`, `${normalizedApiUrl}/objects/host/${encodeURIComponent(hostname)}/actions/get_graph/invoke`, `${normalizedApiUrl}/domain-types/metric/actions/get_graph/invoke`];
      const requestBody = {
        time_range: {
          start: formatDateTime(start_time),
          end: formatDateTime(end_time)
        },
        reduce: reduceType,
        filter: filter,
        aggregation: 'off',
        type: 'single_metric',
        metric_id: metric
      };
      let success = false;
      for (const endpointUrl of possibleEndpoints) {
        try {
          const response = await fetch(endpointUrl, {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': authData.auth_header
            },
            body: JSON.stringify(requestBody)
          });
          if (response.ok) {
            const data = await response.json();
            if (data.metrics && Array.isArray(data.metrics) && data.metrics.length > 0) {
              const metricData = data.metrics[0];
              if (metricData.data_points && Array.isArray(metricData.data_points) && metricData.data_points.length > 0) {
                const values = metricData.data_points.filter(v => v !== null && v !== undefined && !isNaN(v) && isFinite(v));
                if (values.length > 0) {
                  if (reduceType === 'average') {
                    results.average = values.reduce((a, b) => a + b, 0) / values.length;
                  } else {
                    results[reduceType] = reduceType === 'min' ? Math.min(...values) : Math.max(...values);
                  }
                  success = true;
                  break;
                }
              }
            }
          } else if (response.status !== 404) {
            continue;
          }
        } catch (fetchError) {
          continue;
        }
      }
    }
    let metricsData = null;
    let lastError = null;
    if (!results.min && !results.max && !results.average) {
      const possibleEndpoints = [{
        url: `${normalizedApiUrl}/domain-types/metric/actions/get_graph/invoke`,
        method: 'POST',
        body: {
          hostname: hostname,
          metric: metric,
          query_time_range: {
            start_time: start_time,
            end_time: end_time
          },
          ...(checkmkSite && {
            site: checkmkSite
          })
        }
      }];
      for (const endpointConfig of possibleEndpoints) {
        try {
          const url = endpointConfig.url;
          const fetchOptions = {
            method: endpointConfig.method,
            headers: {
              'Accept': 'application/json',
              'Authorization': authData.auth_header
            }
          };
          if (endpointConfig.method === 'POST' && endpointConfig.body) {
            fetchOptions.headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify(endpointConfig.body);
          }
          const response = await fetch(url, fetchOptions);
          if (response.ok) {
            const data = await response.json();
            metricsData = data;
            break;
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
    }
    if (results.min || results.max || results.average) {
      return res.json({
        hostname,
        metric,
        min: results.min !== null && results.min !== undefined ? Math.round(results.min * 100) / 100 : null,
        max: results.max !== null && results.max !== undefined ? Math.round(results.max * 100) / 100 : null,
        average: results.average !== null && results.average !== undefined ? Math.round(results.average * 100) / 100 : null
      });
    }
    if (!metricsData) {
      return res.json({
        hostname,
        metric,
        min: null,
        max: null,
        average: null,
        error: lastError || 'No metrics endpoint available'
      });
    }
    let min = null;
    let max = null;
    let average = null;
    if (metricsData.metrics && Array.isArray(metricsData.metrics) && metricsData.metrics.length > 0) {
      const metricData = metricsData.metrics[0];
      if (metricData.data_points && Array.isArray(metricData.data_points) && metricData.data_points.length > 0) {
        const values = metricData.data_points.filter(v => v !== null && v !== undefined && !isNaN(v) && isFinite(v));
        if (values.length > 0) {
          min = Math.min(...values);
          max = Math.max(...values);
          average = values.reduce((a, b) => a + b, 0) / values.length;
        }
      }
    } else if (metricsData.curves && Array.isArray(metricsData.curves) && metricsData.curves.length > 0) {
      const curve = metricsData.curves[0];
      if (curve.data_points && Array.isArray(curve.data_points) && curve.data_points.length > 0) {
        const values = curve.data_points.map(dp => {
          if (Array.isArray(dp)) {
            return dp.length > 1 ? dp[1] : dp[0];
          } else if (typeof dp === 'object' && dp.value !== undefined) {
            return dp.value;
          }
          return dp;
        }).filter(v => v !== null && v !== undefined && !isNaN(v) && isFinite(v));
        if (values.length > 0) {
          min = Math.min(...values);
          max = Math.max(...values);
          average = values.reduce((a, b) => a + b, 0) / values.length;
        }
      }
    }
    res.json({
      hostname,
      metric,
      min: min !== null ? Math.round(min * 100) / 100 : null,
      max: max !== null ? Math.round(max * 100) / 100 : null,
      average: average !== null ? Math.round(average * 100) / 100 : null
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error retrieving metrics'
    });
  }
});
export default router;
