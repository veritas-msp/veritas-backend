import express from 'express';
import { pool } from '../../../database/db.js';
import verifyJWT from '../../../middleware/auth.js';
import { getCheckMKSettings, authenticateCheckMK, getHostServices, getHostStateHistory, extractPerformanceValue } from './utils.js';
const router = express.Router();
router.get('/availability/:clientId', verifyJWT, async (req, res) => {
  try {
    const {
      clientId
    } = req.params;
    const {
      start_time,
      end_time,
      equipment_id
    } = req.query;
    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({
        error: 'Check MK configuration incomplete. Please configure settings in Settings.'
      });
    }
    let query = `
      SELECT id, checkmk_host_name
       FROM v_b_clients_host_mapping
       WHERE client_id::text = $1 AND (is_active = true OR is_active IS NULL) AND checkmk_host_name IS NOT NULL
    `;
    const params = [clientId];
    const mappingResult = await pool.query(query, params);
    if (mappingResult.rows.length === 0) {
      return res.json({
        message: 'No active mapping found',
        data: []
      });
    }
    const authData = await authenticateCheckMK(settings.apiUrl, settings.username, settings.password);
    const availabilityData = [];
    for (const mapping of mappingResult.rows) {
      try {
        const site = mapping.checkmk_site ?? settings.site;
        const services = await getHostServices(settings.apiUrl, authData.auth_header, mapping.checkmk_host_name, site);
        let okCount = 0;
        let warnCount = 0;
        let critCount = 0;
        let unknownCount = 0;
        const formattedServices = services.map(service => {
          const state = service.state;
          const stateName = state === 0 ? 'ok' : state === 1 ? 'warn' : state === 2 ? 'crit' : 'unknown';
          if (state === 0) okCount++;else if (state === 1) warnCount++;else if (state === 2) critCount++;else unknownCount++;
          return {
            id: service.id,
            title: service.title,
            state: state,
            stateName: stateName,
            description: service.description,
            lastCheck: service.lastCheck || service.raw?.last_check || service.raw?.last_state_change || null,
            pluginOutput: service.pluginOutput || service.raw?.plugin_output || service.raw?.output || null,
            performanceData: service.performanceData || service.raw?.performance_data || null
          };
        });
        const serviceInfo = {
          total: services.length,
          ok: okCount,
          warn: warnCount,
          crit: critCount,
          unknown: unknownCount,
          services: formattedServices
        };
        let hostState = 'ok';
        if (serviceInfo.crit > 0) hostState = 'crit';else if (serviceInfo.warn > 0) hostState = 'warn';else if (serviceInfo.unknown > 0) hostState = 'unknown';
        let score = 100;
        if (serviceInfo.total > 0) {
          const okRatio = serviceInfo.ok / serviceInfo.total;
          const warnRatio = serviceInfo.warn / serviceInfo.total;
          const critRatio = serviceInfo.crit / serviceInfo.total;
          score = Math.round(okRatio * 100 + warnRatio * 50 + critRatio * 0 + serviceInfo.unknown / serviceInfo.total * 25);
        }
        const performanceMetrics = {
          cpu: null,
          memory: null,
          disk: null,
          uptime: null,
          network: null
        };
        formattedServices.forEach(service => {
          const serviceTitle = (service.title || service.id || '').toLowerCase();
          if (!performanceMetrics.cpu && (serviceTitle.includes('cpu') || serviceTitle.includes('utilization') || serviceTitle.includes('processor') || serviceTitle.includes('load'))) {
            performanceMetrics.cpu = {
              state: service.stateName,
              value: extractPerformanceValue(service.performanceData, service.pluginOutput),
              lastCheck: service.lastCheck
            };
          }
          if (!performanceMetrics.memory && (serviceTitle.includes('memory') || serviceTitle.includes('ram') || serviceTitle.includes('mem') || serviceTitle.includes('swap'))) {
            performanceMetrics.memory = {
              state: service.stateName,
              value: extractPerformanceValue(service.performanceData, service.pluginOutput),
              lastCheck: service.lastCheck
            };
          }
          if (!performanceMetrics.disk && (serviceTitle.includes('disk') || serviceTitle.includes('filesystem') || serviceTitle.includes('c:') || serviceTitle.includes('d:'))) {
            performanceMetrics.disk = {
              state: service.stateName,
              value: extractPerformanceValue(service.performanceData, service.pluginOutput),
              lastCheck: service.lastCheck
            };
          }
          if (!performanceMetrics.uptime && (serviceTitle.includes('uptime') || serviceTitle.includes('up time'))) {
            performanceMetrics.uptime = {
              state: service.stateName,
              value: extractPerformanceValue(service.performanceData, service.pluginOutput),
              lastCheck: service.lastCheck
            };
          }
          if (!performanceMetrics.network && (serviceTitle.includes('network') || serviceTitle.includes('interface') || serviceTitle.includes('traffic'))) {
            performanceMetrics.network = {
              state: service.stateName,
              value: extractPerformanceValue(service.performanceData, service.pluginOutput),
              lastCheck: service.lastCheck
            };
          }
        });
        let hostStateHistory = null;
        if (start_time && end_time) {
          hostStateHistory = await getHostStateHistory(settings.apiUrl, authData.auth_header, mapping.checkmk_host_name, start_time, end_time, site);
        }
        const statistics = {
          totalServices: serviceInfo.total,
          alertsCount: serviceInfo.warn + serviceInfo.crit,
          averageIncidentDuration: hostStateHistory?.mttr || null,
          availabilityTime: null,
          updatesAvailable: 0,
          vulnerabilitiesDetected: 0,
          minMaxAvg: {
            cpu: {
              min: null,
              max: null,
              avg: null
            },
            memory: {
              min: null,
              max: null,
              avg: null
            },
            disk: {
              min: null,
              max: null,
              avg: null
            }
          },
          hostStateHistory: hostStateHistory ? {
            availabilityRate: hostStateHistory.availabilityRate,
            timeUP: hostStateHistory.timeUP,
            timeDOWN: hostStateHistory.timeDOWN,
            timeUNREACHABLE: hostStateHistory.timeUNREACHABLE
          } : null,
          mttr: hostStateHistory?.mttr || null,
          mtbf: hostStateHistory?.mtbf || null,
          incidentsCount: hostStateHistory?.incidentsCount || 0
        };
        if (serviceInfo.total > 0) {
          const availabilityRatio = serviceInfo.ok / serviceInfo.total;
          statistics.availabilityTime = Math.round(availabilityRatio * 100);
        }
        formattedServices.forEach(service => {
          const serviceTitle = (service.title || service.id || '').toLowerCase();
          const pluginOutput = (service.pluginOutput || '').toLowerCase();
          if (serviceTitle.includes('update') || serviceTitle.includes('patch') || pluginOutput.includes('update available') || pluginOutput.includes('patch available') || pluginOutput.includes('update')) {
            if (service.state !== 0) {
              statistics.updatesAvailable++;
            }
          }
          if (serviceTitle.includes('vulnerability') || serviceTitle.includes('vuln') || pluginOutput.includes('vulnerability') || pluginOutput.includes('vuln') || pluginOutput.includes('cve-') || pluginOutput.includes('vulnerability')) {
            if (service.state !== 0) {
              statistics.vulnerabilitiesDetected++;
            }
          }
        });
        const metricValues = {
          cpu: [],
          memory: [],
          disk: []
        };
        formattedServices.forEach(service => {
          const serviceTitle = (service.title || service.id || '').toLowerCase();
          const perfValue = extractPerformanceValue(service.performanceData, service.pluginOutput);
          if (perfValue && perfValue.value !== undefined) {
            const value = parseFloat(perfValue.value);
            if (!isNaN(value)) {
              if (serviceTitle.includes('cpu') || serviceTitle.includes('utilization') || serviceTitle.includes('processor') || serviceTitle.includes('load')) {
                if (perfValue.unit === '%' || !perfValue.unit && value <= 100) {
                  metricValues.cpu.push(value);
                }
              }
              if (serviceTitle.includes('memory') || serviceTitle.includes('ram') || serviceTitle.includes('mem') || serviceTitle.includes('swap')) {
                if (perfValue.unit === 'GB' || perfValue.unit === 'MB' || perfValue.unit === '%') {
                  metricValues.memory.push(value);
                }
              }
              if (serviceTitle.includes('disk') || serviceTitle.includes('filesystem') || serviceTitle.includes('c:') || serviceTitle.includes('d:')) {
                if (perfValue.unit === 'GB' || perfValue.unit === 'MB' || perfValue.unit === '%') {
                  metricValues.disk.push(value);
                } else if (!perfValue.unit && value <= 100) {
                  metricValues.disk.push(value);
                }
              }
            }
          }
        });
        ['cpu', 'memory', 'disk'].forEach(metric => {
          const values = metricValues[metric];
          if (values.length > 0) {
            statistics.minMaxAvg[metric] = {
              min: Math.round(Math.min(...values) * 100) / 100,
              max: Math.round(Math.max(...values) * 100) / 100,
              avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100
            };
          }
        });
        availabilityData.push({
          checkmk_host_name: mapping.checkmk_host_name,
          checkmk_site: mapping.checkmk_site ?? null,
          checkmk_service_name: mapping.checkmk_service_name ?? null,
          hostState: hostState,
          score: score,
          serviceInfo: serviceInfo,
          performanceMetrics: performanceMetrics,
          services: services,
          serviceAvailability: {},
          statistics: statistics
        });
      } catch (error) {
        availabilityData.push({
          checkmk_host_name: mapping.checkmk_host_name,
          checkmk_site: mapping.checkmk_site ?? null,
          checkmk_service_name: mapping.checkmk_service_name ?? null,
          error: error.message
        });
      }
    }
    res.json({
      period: start_time && end_time ? {
        start_time,
        end_time
      } : null,
      data: availabilityData
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error retrieving statistics'
    });
  }
});
export default router;
