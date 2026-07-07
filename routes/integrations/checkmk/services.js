// ───────────────────────────────────────────────
// 📋 Routes des Services Check MK
// ───────────────────────────────────────────────

import express from 'express';
import fetch from 'node-fetch';
import verifyJWT from '../../../middleware/auth.js';
import { getCheckMKSettings, authenticateCheckMK, getHostServices } from './utils.js';

const router = express.Router();

// ───────────────────────────────────────────────
// 📋 GET /api/checkmk/services/:hostName — Récupérer les services d'un host
// ───────────────────────────────────────────────
router.get('/services/:hostName', verifyJWT, async (req, res) => {
  try {
    const { hostName } = req.params;
    const { site, start_time, end_time } = req.query;
    
    // Récupérer les settings Check MK
    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({ 
        error: 'Configuration Check MK incomplète. Veuillez configurer les paramètres dans Settings.' 
      });
    }
    
    // Authentifier auprès de Check MK
    const authData = await authenticateCheckMK(
      settings.apiUrl,
      settings.username,
      settings.password
    );
    
    // Récupérer uniquement les services du host
    const services = await getHostServices(
      settings.apiUrl,
      authData.auth_header,
      hostName,
      site || settings.site
    );
    
    res.json({
      host_name: hostName,
      services: services
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: 'Erreur lors de la récupération des services',
      details: error.message 
    });
  }
});

// ───────────────────────────────────────────────
// 📋 GET /api/checkmk/service-data/:hostName/:serviceName — Récupérer les données d'un service spécifique
// ───────────────────────────────────────────────
router.get('/service-data/:hostName/:serviceName', verifyJWT, async (req, res) => {
  try {
    let { hostName, serviceName } = req.params;
    const { site } = req.query;
    
    // Décoder les paramètres (ils peuvent être encodés dans l'URL)
    hostName = decodeURIComponent(hostName);
    serviceName = decodeURIComponent(serviceName);
    
    // Le serviceName peut être au format "hostName:serviceName", il faut extraire le nom du service
    // Si le serviceName commence par "hostName:", on retire ce préfixe
    if (serviceName.startsWith(`${hostName}:`)) {
      serviceName = serviceName.substring(hostName.length + 1);
    }
    
    // Récupérer les settings Check MK
    const settings = await getCheckMKSettings();
    if (!settings || !settings.apiUrl || !settings.username || !settings.password) {
      return res.status(500).json({ 
        error: 'Configuration Check MK incomplète. Veuillez configurer les paramètres dans Settings.' 
      });
    }
    
    // Authentifier auprès de Check MK
    const authData = await authenticateCheckMK(
      settings.apiUrl,
      settings.username,
      settings.password
    );
    
    const apiSite = site || settings.site;
    
    // Fonction pour parser les dates depuis plugin_output
    const parseDatesFromOutput = (output) => {
      if (!output) return { creation_time: null, end_time: null };
      
      // Fonction helper pour convertir une date au format DD.MM.YYYY HH:mm:ss en ISO
      const parseEuropeanDate = (dateStr) => {
        // Format: "14.11.2025 00:00:00" -> "2025-11-14T00:00:00"
        const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
        if (match) {
          const [, day, month, year, hour, minute, second] = match;
          return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
        }
        return null;
      };
      
      // Patterns possibles pour les dates dans le plugin_output
      // Formats supportés:
      // - Format européen: "Creation time: 14.11.2025 00:00:00"
      // - Format ISO: "Created: 2025-01-15 10:30:00"
      // - Format ISO avec T: "2025-01-15T10:30:00Z"
      const creationPatterns = [
        /(?:created|creation|start|started)[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i,
        /creation[\s_]*time[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i,
        /start[\s_]*time[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i,
        /(?:created|creation|start|started)[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i,
        /creation[\s_]*time[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i,
        /start[\s_]*time[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i
      ];
      
      const endPatterns = [
        /(?:end|ended|finish|finished)[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i,
        /end[\s_]*time[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i,
        /finish[\s_]*time[\s:]+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i,
        /(?:end|ended|finish|finished)[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i,
        /end[\s_]*time[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i,
        /finish[\s_]*time[\s:]+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/i
      ];
      
      let creation_time = null;
      let end_time = null;
      
      for (const pattern of creationPatterns) {
        const match = output.match(pattern);
        if (match) {
          try {
            const dateStr = match[1];
            // Vérifier si c'est le format européen
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
          } catch (e) {
            // Ignorer les erreurs de parsing
          }
        }
      }
      
      for (const pattern of endPatterns) {
        const match = output.match(pattern);
        if (match) {
          try {
            const dateStr = match[1];
            // Vérifier si c'est le format européen
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
          } catch (e) {
            // Ignorer les erreurs de parsing
          }
        }
      }
      
      return { creation_time, end_time };
    };
    
    // Fonction pour récupérer les événements du service
    const getServiceEvents = async () => {
      try {
        // Récupérer les événements du host depuis l'event console
        const normalizedApiUrl = settings.apiUrl.replace(/\/+$/, '');
        const eventsUrl = `${normalizedApiUrl}/domain-types/event_console/collections/all`;
        
        // Construire la requête pour récupérer les événements pour ce host et ce service
        const queryExpression = JSON.stringify({
          op: "and",
          expr: [
            { op: "=", left: "host_name", right: hostName }
          ]
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
          
          // Filtrer les événements qui correspondent au service
          const serviceEvents = allEvents.filter(event => {
            const eventService = event.service || event.service_name || event.service_description || '';
            const normalizedEventService = String(eventService).trim();
            const normalizedServiceName = String(serviceName).trim();
            
            // Correspondance exacte
            if (normalizedEventService === normalizedServiceName) return true;
            
            // Correspondance avec format "host:service"
            if (normalizedEventService === `${hostName}:${normalizedServiceName}`) return true;
            
            // Correspondance insensible à la casse
            if (normalizedEventService.toLowerCase() === normalizedServiceName.toLowerCase()) return true;
            
            // Correspondance partielle (le service contient le nom)
            if (normalizedEventService.includes(normalizedServiceName) || 
                normalizedServiceName.includes(normalizedEventService)) return true;
            
            return false;
          });
          
          return serviceEvents;
        }
      } catch (error) {
        return [];
      }
      return [];
    };
    
    // Fonction pour calculer la disponibilité
    const calculateAvailability = async (serviceEvents) => {
      if (!serviceEvents || serviceEvents.length === 0) {
        return { availability_percent: null, events_count: 0 };
      }
      
      // Calculer la disponibilité basée sur les états des événements
      // 0 = OK, 1 = WARN, 2 = CRIT, 3 = UNKNOWN
      const okEvents = serviceEvents.filter(e => (e.state || e.state_type || 0) === 0).length;
      const totalEvents = serviceEvents.length;
      const availability_percent = totalEvents > 0 ? Math.round((okEvents / totalEvents) * 100) : null;
      
      return {
        availability_percent,
        events_count: totalEvents,
        ok_events: okEvents,
        warn_events: serviceEvents.filter(e => (e.state || e.state_type || 0) === 1).length,
        crit_events: serviceEvents.filter(e => (e.state || e.state_type || 0) === 2).length,
        unknown_events: serviceEvents.filter(e => (e.state || e.state_type || 0) === 3).length
      };
    };
    
    // Utiliser l'endpoint view.py avec json_export pour récupérer les données du service
    // C'est la méthode qui fonctionne le mieux pour les jobs Veeam
    let serviceData = null;
    let pluginOutput = null;
    let longPluginOutput = null;
    
    try {
      // Construire l'URL view.py pour l'export JSON
      // L'URL de base de l'API est généralement .../check_mk/api/1.0
      // On doit retirer /api/1.0 pour obtenir la base CheckMK, puis ajouter /view.py
      let baseUrl = settings.apiUrl;
      if (baseUrl.includes('/api/1.0')) {
        baseUrl = baseUrl.replace('/api/1.0', '');
      }
      // S'assurer qu'il n'y a pas de slash final
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
        
        // Le format est un tableau : [headers, values]
        if (Array.isArray(viewData) && viewData.length >= 2) {
          const headers = viewData[0];
          const values = viewData[1];
          
          // Trouver les indices des colonnes qui nous intéressent
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
          
          // Construire serviceData avec les informations disponibles
          serviceData = {
            description: serviceDescriptionIdx >= 0 ? values[serviceDescriptionIdx] : serviceName,
            state: serviceStateIdx >= 0 ? (values[serviceStateIdx] === 'OK' ? 0 : values[serviceStateIdx] === 'WARN' ? 1 : values[serviceStateIdx] === 'CRIT' ? 2 : 3) : null,
            performance_data: svcPerfDataIdx >= 0 ? values[svcPerfDataIdx] : null
          };
        }
      } else {
        const errorText = await viewResponse.text().catch(() => '');
        throw new Error(`Erreur lors de la récupération des données du service: ${viewResponse.status}`);
      }
    } catch (viewError) {
      return res.status(500).json({ 
        error: `Erreur lors de la récupération des données du service ${serviceName}`,
        details: viewError.message 
      });
    }
    
    // Vérifier que les données ont été récupérées
    if (!serviceData || (!pluginOutput && !longPluginOutput)) {
      return res.status(404).json({ 
        error: `Service ${serviceName} non trouvé pour le host ${hostName}`,
        details: 'Aucune donnée récupérée via view.py'
      });
    }
    
    // Récupérer les événements et calculer la disponibilité
    const serviceEvents = await getServiceEvents();
    const availability = await calculateAvailability(serviceEvents);
    
    // Parser les dates depuis plugin_output ou long_plugin_output
    const outputToParse = longPluginOutput || pluginOutput;
    const dates = parseDatesFromOutput(outputToParse);
    
    // Formater les données du service
    const formattedData = {
      id: `${hostName}:${serviceName}`,
      title: serviceData.description || serviceName,
      description: serviceData.description || serviceName,
      state: serviceData.state,
      state_type: null, // Non disponible dans view.py
      plugin_output: pluginOutput,
      long_plugin_output: longPluginOutput,
      performance_data: serviceData.performance_data || null,
      last_check: null, // Non disponible dans view.py pour le moment
      last_state_change: null, // Non disponible dans view.py pour le moment
      host_name: hostName,
      service_name: serviceName,
      // Événements et disponibilité
      events_count: availability.events_count,
      availability_percent: availability.availability_percent,
      events: {
        total: availability.events_count,
        ok: availability.ok_events,
        warn: availability.warn_events,
        crit: availability.crit_events,
        unknown: availability.unknown_events
      },
      // Dates extraites depuis plugin_output
      creation_time: dates.creation_time,
      end_time: dates.end_time,
      // Conserver les données brutes
      raw: serviceData,
      // Pour compatibilité avec le frontend
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
      error: 'Erreur lors de la récupération des données du service',
      details: error.message 
    });
  }
});

export default router;
