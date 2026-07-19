// Helper to transform raw v_b_clients_m_* table data
// into the frontend format (modules, modules_monitoring, equipements)

const MODULE_TABLES = {
  internet: "v_b_clients_m_internet",
  servers: "v_b_clients_m_servers",
  stockage: "v_b_clients_m_stockage",
  firewall: "v_b_clients_m_firewall",
  switch: "v_b_clients_m_switch",
  wifi: "v_b_clients_m_wifi",
  alimentation: "v_b_clients_m_alimentation",
  routeur: "v_b_clients_m_routeur",
  toip: "v_b_clients_m_toip",
  save: "v_b_clients_m_save",
  antivirus: "v_b_clients_m_antivirus",
  antispam: "v_b_clients_m_antispam",
  ndd: "v_b_clients_m_ndd",
  ssl: "v_b_clients_m_ssl",
  licences: "v_b_clients_m_licences",
  o365: "v_b_clients_m_o365",
  ordinateurs: "v_b_clients_m_ordinateurs",
};

/**
 * Transforms raw table data into frontend format
 * @param {Object} rawData - Raw data from v_b_clients_m_* tables
 * @param {Object} options - Additional options
 * @param {boolean} options.azureHasCredentials - True when Entra credentials (v_b_clients_azure) exist
 * @returns {Object} - { modules, modules_monitoring, equipements }
 */
export function transformClientModulesToFrontend(rawData, options = {}) {
  const modules = {};
  const modules_monitoring = {};
  const equipements = {
    Serveurs: [],
    NAS: [],
    Firewalls: [],
    Sauvegarde: { instances: [] },
    Antivirus: { solutions: [] },
    Antispam: { solutions: [] },
    NDD: [],
    CertificatsSSL: [],
    LicencesAbonnements: [],
    Office365: { licences: [] },
    Internet: [],
    Switch: [],
    BorneWifi: [],
    Alimentation: [],
    Routeur: [],
    TOIP: [],
    Ordinateurs: [],
  };

  // Mapping for equipment (plural for Firewalls)
  const familyToEquipementKey = {
    internet: 'Internet',
    servers: 'Serveurs',
    stockage: 'NAS', // NAS, SAN, Disques externes
    firewall: 'Firewalls',
    switch: 'Switch',
    wifi: 'BorneWifi',
    alimentation: 'Alimentation',
    routeur: 'Routeur',
    toip: 'TOIP',
    save: 'Sauvegarde',
    antivirus: 'Antivirus',
    antispam: 'Antispam',
    ndd: 'NDD',
    ssl: 'CertificatsSSL',
    licences: 'LicencesAbonnements',
    o365: 'Office365',
    ordinateurs: 'Ordinateurs',
  };

  // Mapping for monitoring modules (singular for Firewall)
  const familyToMonitoringKey = {
    internet: 'Internet',
    servers: 'Serveurs',
    stockage: 'Stockage',
    firewall: 'Firewall', // Singular for modules_monitoring
    switch: 'Switch',
    wifi: 'BorneWifi',
    alimentation: 'Alimentation',
    routeur: 'Routeur',
    toip: 'TOIP',
    save: 'Sauvegarde',
    antivirus: 'Antivirus',
    antispam: 'Antispam',
    ndd: 'NDD',
    ssl: 'CertificatsSSL',
    licences: 'LicencesAbonnements',
    o365: 'Office365',
    ordinateurs: 'Ordinateurs',
  };

  for (const [family, items] of Object.entries(rawData)) {
    if (family === 'module') continue; // Already handled

    const equipementKey = familyToEquipementKey[family];
    const monitoringKey = familyToMonitoringKey[family];
    if (!equipementKey || !monitoringKey) continue;
    

    // Determine whether the monitoring module is enabled
    // Look for an activation flag item (item_key or name = module name)
    const monitoringItem = items.find(item => 
      (item.item_key === monitoringKey || item.item_key === equipementKey || 
       item.name === monitoringKey || item.name === equipementKey) && 
      (item.data?.enabled === true || item.is_active === true)
    );
    
    // If no flag is found, check for real equipment rows (module is then considered active)
    if (monitoringItem) {
      modules_monitoring[monitoringKey] = true;
    } else {
      // Check for real equipment rows (not just flags)
      // For Antivirus, also check whether the Antivirus item contains solutions
      const hasRealEquipments = items.some(item => {
        if (!item.data || Object.keys(item.data).length === 0) return false;
        // Exclude enabled-only flags
        if (Object.keys(item.data).length === 1 && item.data.enabled === true) return false;
        
        // For Antivirus: item with item_key="Antivirus" but containing solutions is real equipment
        if (equipementKey === 'Antivirus' && 
            (item.item_key === monitoringKey || item.item_key === equipementKey ||
             item.name === monitoringKey || item.name === equipementKey)) {
          const hasSolutions = item.data.solutions && Array.isArray(item.data.solutions) && item.data.solutions.length > 0;
          const hasSolution = item.data.solution && typeof item.data.solution === 'string' && item.data.solution.trim() !== '';
          if (hasSolutions || hasSolution) return true;
        }
        
        // Exclude items whose item_key or name matches the module name (except Antivirus with solutions, handled above)
        if (item.item_key === monitoringKey || item.item_key === equipementKey ||
            item.name === monitoringKey || item.name === equipementKey) return false;
        return true;
      });
      modules_monitoring[monitoringKey] = hasRealEquipments;
    }

    // Extract equipment data
    if (equipementKey === 'Sauvegarde') {
      // Backup: aggregate individual instances into an object with instances: []
      // Filter items that are real instances (have logiciel) or contain instances: []
      // Or jobs (item_key starts with 'job-')
      const realItems = items.filter(item => {
        if (!item.data || typeof item.data !== 'object') return false;
        
        // Exclude enabled-only flags only
        const dataKeys = Object.keys(item.data);
        if (dataKeys.length === 1 && item.data.enabled === true) return false;
        
        // Keep jobs: item_key starts with 'job-'
        if (item.item_key && item.item_key.startsWith('job-')) {
          return true;
        }
        
        // Exclude items where item_key or name exactly matches the module name (activation flag)
        if (item.item_key === monitoringKey || item.item_key === equipementKey ||
            item.name === monitoringKey || item.name === equipementKey) {
          // But keep real instances (have logiciel or instances: [])
          if (item.data.logiciel || (item.data.instances && Array.isArray(item.data.instances))) {
            return true;
          }
          return false;
        }
        
        // Keep items with logiciel (new structure) or instances: [] (legacy structure)
        return item.data.logiciel || (item.data.instances && Array.isArray(item.data.instances));
      });
      
      if (realItems.length > 0) {
        // Multiple items means individual instances (new structure)
        // A single item with instances: [] is legacy structure
        const firstItem = realItems[0];
        if (firstItem.data.instances && Array.isArray(firstItem.data.instances) && realItems.length === 1) {
          // Legacy structure: single object with { instances: [...] }
          equipements.Sauvegarde = firstItem.data;
        } else {
          // New structure: one row per instance and separate job-{instanceId} rows
          // Sort by name for consistent ordering
          const sortedItems = [...realItems].sort((a, b) => {
            const nameA = a.name || a.item_key || '';
            const nameB = b.name || b.item_key || '';
            return nameA.localeCompare(nameB);
          });

          // Split instances and jobs
          // Jobs have item_key starting with 'job-' OR data.type === 'job'
          // Instances have data.type === 'instance' OR logiciel (and are not jobs)
          const instanceItems = sortedItems.filter(item => {
            // Jobs (item_key starts with 'job-') are not instances
            if (item.item_key && item.item_key.startsWith('job-')) return false;
            // data.type === 'instance' marks an instance
            if (item.data && item.data.type === 'instance') return true;
            // data.type === 'job' is not an instance
            if (item.data && item.data.type === 'job') return false;
            // Otherwise, rows with logiciel are instances
            return item.data && item.data.logiciel;
          });
          const jobItems = sortedItems.filter(item => {
            // A job has item_key starting with 'job-' OR data.type === 'job'
            return (item.item_key && item.item_key.startsWith('job-')) || 
                   (item.data && item.data.type === 'job');
          });

          const instances = instanceItems.map(instanceItem => {
            const instanceData = { ...instanceItem.data };
            // Remove type marker
            delete instanceData.type;

            // Frontend identifier may be stored in instanceData.instanceId,
            // otherwise use database row id
            const instanceFrontendId = instanceData.instanceId || instanceItem.id;

            // Find linked jobs via item_key 'job-{instanceFrontendId}'
            const instanceJobs = jobItems
              .filter(jobItem => {
                const jobItemKey = jobItem.item_key || '';
                // Job item_key is 'job-{instanceId}'
                if (jobItemKey.startsWith('job-')) {
                  const jobInstanceId = jobItemKey.substring(4); // Strip 'job-' prefix
                  return jobInstanceId === instanceFrontendId;
                }
                // Fallback: job with data.type === 'job' but no item_key 
                // cannot be linked (should not happen)
                return false;
              })
              .map(jobItem => {
                const jobData = { ...jobItem.data };
                // Remove type only when it is the 'job' marker (legacy compatibility)
                // Otherwise preserve backup type (Full, Incremental, etc.)
                if (jobData.type === 'job') {
                  delete jobData.type;
                }
                const lastBackupDate = jobItem.last_backup_date ?? jobData.last_backup_date ?? null;
                const lastBackupDuration = jobItem.last_backup_duration ?? jobData.last_backup_duration ?? null;
                const lastBackupStart = jobItem.last_backup_start ?? jobData.last_backup_start ?? null;
                return {
                  id: jobItem.id,
                  ...jobData,
                  last_backup_date: lastBackupDate != null ? (typeof lastBackupDate === 'string' ? lastBackupDate : (lastBackupDate instanceof Date ? lastBackupDate.toISOString() : String(lastBackupDate))) : null,
                  last_backup_duration: lastBackupDuration != null ? String(lastBackupDuration) : null,
                  last_backup_start: lastBackupStart != null ? (typeof lastBackupStart === 'string' ? lastBackupStart : (lastBackupStart instanceof Date ? lastBackupStart.toISOString() : String(lastBackupStart))) : null
                };
              });

            return {
              id: instanceFrontendId,
              ...instanceData,
              jobs: instanceJobs
            };
          });

          equipements.Sauvegarde = {
            instances
          };
        }
      }
    } else if (equipementKey === 'Antispam') {
      // Antispam: aggregate individual solutions into an object with solutions: []
      const realItems = items.filter(item => {
        if (!item.data || typeof item.data !== 'object') return false;
        const dataKeys = Object.keys(item.data);
        if (dataKeys.length === 1 && item.data.enabled === true) return false;
        if (item.item_key && item.item_key.startsWith('solution-')) {
          return true;
        }
        if (item.item_key === monitoringKey || item.item_key === equipementKey ||
            item.name === monitoringKey || item.name === equipementKey) {
          if (item.data.logiciel || (item.data.solutions && Array.isArray(item.data.solutions))) {
            return true;
          }
          return false;
        }
        const hasSolutions = item.data.solutions && Array.isArray(item.data.solutions) && item.data.solutions.length > 0;
        const hasLogiciel = item.data.logiciel && typeof item.data.logiciel === 'string' && item.data.logiciel.trim() !== '';
        const hasSolution = item.data.solution && typeof item.data.solution === 'string' && item.data.solution.trim() !== '';
        const hasCustomerId = item.data.customerId != null && String(item.data.customerId).trim() !== '';
        const hasMailinblackTenant = item.data.mailinblackTenantId != null;
        return hasSolutions || hasLogiciel || hasSolution || hasCustomerId || hasMailinblackTenant;
      });
      
      if (realItems.length > 0) {
        // Multiple items means individual solutions (new structure)
        // A single item with solutions: [] is legacy structure
        const firstItem = realItems[0];
        if (firstItem.data.solutions && Array.isArray(firstItem.data.solutions) && realItems.length === 1) {
          // Legacy structure: single object with { solutions: [...] }
          equipements.Antispam = firstItem.data;
        } else {
          // New structure: one row per solution, aggregated here
          const sortedItems = [...realItems].sort((a, b) => {
            const nameA = a.name || a.item_key || '';
            const nameB = b.name || b.item_key || '';
            return nameA.localeCompare(nameB);
          });
          equipements.Antispam = {
            solutions: sortedItems.map(item => ({
              id: item.id, // Keep ID for updates
              ...item.data
            }))
          };
        }
      }
    } else if (equipementKey === 'Antivirus') {
      // Antivirus: aggregate individual solutions into an object with solutions: []
      // Keep all items with real data (not just an enabled flag)
      const realItems = items.filter(item => {
        if (!item.data || typeof item.data !== 'object') {
          return false;
        }
        const dataKeys = Object.keys(item.data);
        
        // Exclude simple activation flags (only {enabled: true})
        if (dataKeys.length === 1 && item.data.enabled === true) {
          return false;
        }
        
        // item_key starting with "solution-" is a real antivirus solution
        if (item.item_key && item.item_key.startsWith('solution-')) {
          return true;
        }
        
        // Items with solutions or a solution field contain real antivirus data
        const hasSolutions = item.data.solutions && Array.isArray(item.data.solutions) && item.data.solutions.length > 0;
        const hasSolution = item.data.solution && typeof item.data.solution === 'string' && item.data.solution.trim() !== '';
        const hasLogiciel = item.data.logiciel && typeof item.data.logiciel === 'string' && item.data.logiciel.trim() !== '';
        
        // Keep real solutions (solution, solutions, or logiciel fields)
        if (hasSolutions || hasSolution || hasLogiciel) {
          return true;
        }
        
        // Names containing known solution vendors are likely real solutions
        if (item.name && (item.name.includes('BitDefender') || item.name.includes('Kaspersky') || 
            item.name.includes('Symantec') || item.name.includes('Trend') || 
            item.name.includes('McAfee') || item.name.includes('Norton') || 
            item.name.includes('Avast') || item.name.includes('AVG'))) {
          return true;
        }
        
        // Exclude items whose item_key or name exactly matches the module name
        // AND have no real solution/solutions/logiciel data
        if ((item.item_key === monitoringKey || item.item_key === equipementKey ||
             item.name === monitoringKey || item.name === equipementKey) &&
            !hasSolutions && !hasSolution && !hasLogiciel) {
          return false;
        }
        
        // Keep items with other data besides enabled
        // This keeps items with custom data fields
        if (dataKeys.length > 0 && !(dataKeys.length === 1 && dataKeys[0] === 'enabled')) {
          return true;
        }
        
        return false;
      });
      
      if (realItems.length > 0) {
        // Multiple items means individual solutions (new structure)
        // A single item with solutions: [] is legacy structure
        const firstItem = realItems[0];
        if (firstItem.data.solutions && Array.isArray(firstItem.data.solutions) && realItems.length === 1) {
          // Legacy structure: single object with { solutions: [...] }
          equipements.Antivirus = firstItem.data;
        } else {
          // New structure: one row per solution, aggregated here
          const sortedItems = [...realItems].sort((a, b) => {
            const nameA = a.name || a.item_key || '';
            const nameB = b.name || b.item_key || '';
            return nameA.localeCompare(nameB);
          });
          equipements.Antivirus = {
            solutions: sortedItems.map(item => ({
              id: item.id,
              ...item.data,
              checkmk_host_name: item.checkmk_host_name ?? null,
              checkmk_site: item.checkmk_site ?? null,
              checkmk_service_name: item.checkmk_service_name ?? null,
              is_active: item.is_active,
            }))
          };
        }
      }
    } else if (equipementKey === 'Office365') {
      // Office365 has licenses
      const realItems = items.filter(item => 
        item.data && 
        item.data.licences && 
        !(Object.keys(item.data).length === 1 && item.data.enabled === true) &&
        item.item_key !== monitoringKey && item.item_key !== equipementKey &&
        item.name !== monitoringKey && item.name !== equipementKey
      );
      if (realItems.length > 0) {
        const mainItem = realItems[0];
        equipements[equipementKey] = mainItem.data || { licences: [] };
      }
    } else {
      // For array equipment (Internet, Servers, NAS, Firewalls, etc.)
      // Filter only module activation flags (item_key/name = module name AND data = {enabled: true})
      const filteredItems = items.filter(item => {
        // Exclude module activation flags only
        const isFlag = (item.item_key === monitoringKey || item.item_key === equipementKey ||
                       item.name === monitoringKey || item.name === equipementKey) &&
                       item.data && 
                       typeof item.data === 'object' &&
                       Object.keys(item.data).length === 1 && 
                       item.data.enabled === true;
        
        return !isFlag;
      });
      
      // Map rows to equipment objects (is_active comes from v_b_clients_m_* columns)
      equipements[equipementKey] = filteredItems.map(item => {
        // Use data when present, otherwise build a minimal object
        const itemData = item.data && typeof item.data === 'object' ? item.data : {};
        const { id: _dataId, ...dataWithoutId } = itemData;
        
        // Ensure a display name exists
        const nom = itemData.nom || item.name || item.item_key || 'Sans nom';
        
        return {
          ...dataWithoutId,
          id: item.id,
          nom: nom,
          agent_id: item.agent_id ?? itemData.agentId ?? null,
          agentId: item.agent_id ?? itemData.agentId ?? null,
          is_active: item.is_active,
          checkmk_host_name: item.checkmk_host_name ?? null,
          checkmk_site: item.checkmk_site ?? null,
          checkmk_service_name: item.checkmk_service_name ?? null
        };
      });
    }
  }

  // Automatically enable Entra when Azure credentials exist
  if (options.azureHasCredentials) {
    modules_monitoring.Office365 = true;
  }

  return {
    modules,
    modules_monitoring,
    equipements
  };
}

/** Equipment counts aligned with getClientEquipmentTotal (EnterpriseDetailPage). */
export function countHardwareEquipment(equipements = {}) {
  return {
    Internet: Array.isArray(equipements.Internet) ? equipements.Internet.length : 0,
    Firewalls: Array.isArray(equipements.Firewalls) ? equipements.Firewalls.length : 0,
    Serveurs: Array.isArray(equipements.Serveurs) ? equipements.Serveurs.length : 0,
    Stockage: Array.isArray(equipements.NAS) ? equipements.NAS.length : 0,
    Switch: Array.isArray(equipements.Switch) ? equipements.Switch.length : 0,
    BorneWifi: Array.isArray(equipements.BorneWifi) ? equipements.BorneWifi.length : 0,
    Alimentation: Array.isArray(equipements.Alimentation) ? equipements.Alimentation.length : 0,
    Routeur: Array.isArray(equipements.Routeur) ? equipements.Routeur.length : 0,
    TOIP: Array.isArray(equipements.TOIP) ? equipements.TOIP.length : 0,
  };
}

