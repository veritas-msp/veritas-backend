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
  ordinateurs: "v_b_clients_m_ordinateurs"
};
export function transformClientModulesToFrontend(rawData, options = {}) {
  const modules = {};
  const modules_monitoring = {};
  const equipements = {
    Serveurs: [],
    NAS: [],
    Firewalls: [],
    Sauvegarde: {
      instances: []
    },
    Antivirus: {
      solutions: []
    },
    Antispam: {
      solutions: []
    },
    NDD: [],
    CertificatsSSL: [],
    LicencesAbonnements: [],
    Office365: {
      licences: []
    },
    Internet: [],
    Switch: [],
    BorneWifi: [],
    Alimentation: [],
    Routeur: [],
    TOIP: [],
    Ordinateurs: []
  };
  const familyToEquipementKey = {
    internet: 'Internet',
    servers: 'Serveurs',
    stockage: 'NAS',
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
    ordinateurs: 'Ordinateurs'
  };
  const familyToMonitoringKey = {
    internet: 'Internet',
    servers: 'Serveurs',
    stockage: 'Stockage',
    firewall: 'Firewall',
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
    ordinateurs: 'Ordinateurs'
  };
  for (const [family, items] of Object.entries(rawData)) {
    if (family === 'module') continue;
    const equipementKey = familyToEquipementKey[family];
    const monitoringKey = familyToMonitoringKey[family];
    if (!equipementKey || !monitoringKey) continue;
    const monitoringItem = items.find(item => (item.item_key === monitoringKey || item.item_key === equipementKey || item.name === monitoringKey || item.name === equipementKey) && (item.data?.enabled === true || item.is_active === true));
    if (monitoringItem) {
      modules_monitoring[monitoringKey] = true;
    } else {
      const hasRealEquipments = items.some(item => {
        if (!item.data || Object.keys(item.data).length === 0) return false;
        if (Object.keys(item.data).length === 1 && item.data.enabled === true) return false;
        if (equipementKey === 'Antivirus' && (item.item_key === monitoringKey || item.item_key === equipementKey || item.name === monitoringKey || item.name === equipementKey)) {
          const hasSolutions = item.data.solutions && Array.isArray(item.data.solutions) && item.data.solutions.length > 0;
          const hasSolution = item.data.solution && typeof item.data.solution === 'string' && item.data.solution.trim() !== '';
          if (hasSolutions || hasSolution) return true;
        }
        if (item.item_key === monitoringKey || item.item_key === equipementKey || item.name === monitoringKey || item.name === equipementKey) return false;
        return true;
      });
      modules_monitoring[monitoringKey] = hasRealEquipments;
    }
    if (equipementKey === 'Sauvegarde') {
      const realItems = items.filter(item => {
        if (!item.data || typeof item.data !== 'object') return false;
        const dataKeys = Object.keys(item.data);
        if (dataKeys.length === 1 && item.data.enabled === true) return false;
        if (item.item_key && item.item_key.startsWith('job-')) {
          return true;
        }
        if (item.item_key === monitoringKey || item.item_key === equipementKey || item.name === monitoringKey || item.name === equipementKey) {
          if (item.data.logiciel || item.data.instances && Array.isArray(item.data.instances)) {
            return true;
          }
          return false;
        }
        return item.data.logiciel || item.data.instances && Array.isArray(item.data.instances);
      });
      if (realItems.length > 0) {
        const firstItem = realItems[0];
        if (firstItem.data.instances && Array.isArray(firstItem.data.instances) && realItems.length === 1) {
          equipements.Sauvegarde = firstItem.data;
        } else {
          const sortedItems = [...realItems].sort((a, b) => {
            const nameA = a.name || a.item_key || '';
            const nameB = b.name || b.item_key || '';
            return nameA.localeCompare(nameB);
          });
          const instanceItems = sortedItems.filter(item => {
            if (item.item_key && item.item_key.startsWith('job-')) return false;
            if (item.data && item.data.type === 'instance') return true;
            if (item.data && item.data.type === 'job') return false;
            return item.data && item.data.logiciel;
          });
          const jobItems = sortedItems.filter(item => {
            return item.item_key && item.item_key.startsWith('job-') || item.data && item.data.type === 'job';
          });
          const instances = instanceItems.map(instanceItem => {
            const instanceData = {
              ...instanceItem.data
            };
            delete instanceData.type;
            const instanceFrontendId = instanceData.instanceId || instanceItem.id;
            const instanceJobs = jobItems.filter(jobItem => {
              const jobItemKey = jobItem.item_key || '';
              if (jobItemKey.startsWith('job-')) {
                const jobInstanceId = jobItemKey.substring(4);
                return jobInstanceId === instanceFrontendId;
              }
              return false;
            }).map(jobItem => {
              const jobData = {
                ...jobItem.data
              };
              if (jobData.type === 'job') {
                delete jobData.type;
              }
              const lastBackupDate = jobItem.last_backup_date ?? jobData.last_backup_date ?? null;
              const lastBackupDuration = jobItem.last_backup_duration ?? jobData.last_backup_duration ?? null;
              const lastBackupStart = jobItem.last_backup_start ?? jobData.last_backup_start ?? null;
              return {
                id: jobItem.id,
                ...jobData,
                last_backup_date: lastBackupDate != null ? typeof lastBackupDate === 'string' ? lastBackupDate : lastBackupDate instanceof Date ? lastBackupDate.toISOString() : String(lastBackupDate) : null,
                last_backup_duration: lastBackupDuration != null ? String(lastBackupDuration) : null,
                last_backup_start: lastBackupStart != null ? typeof lastBackupStart === 'string' ? lastBackupStart : lastBackupStart instanceof Date ? lastBackupStart.toISOString() : String(lastBackupStart) : null
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
      const realItems = items.filter(item => {
        if (!item.data || typeof item.data !== 'object') return false;
        const dataKeys = Object.keys(item.data);
        if (dataKeys.length === 1 && item.data.enabled === true) return false;
        if (item.item_key && item.item_key.startsWith('solution-')) {
          return true;
        }
        if (item.item_key === monitoringKey || item.item_key === equipementKey || item.name === monitoringKey || item.name === equipementKey) {
          if (item.data.logiciel || item.data.solutions && Array.isArray(item.data.solutions)) {
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
        const firstItem = realItems[0];
        if (firstItem.data.solutions && Array.isArray(firstItem.data.solutions) && realItems.length === 1) {
          equipements.Antispam = firstItem.data;
        } else {
          const sortedItems = [...realItems].sort((a, b) => {
            const nameA = a.name || a.item_key || '';
            const nameB = b.name || b.item_key || '';
            return nameA.localeCompare(nameB);
          });
          equipements.Antispam = {
            solutions: sortedItems.map(item => ({
              id: item.id,
              ...item.data
            }))
          };
        }
      }
    } else if (equipementKey === 'Antivirus') {
      const realItems = items.filter(item => {
        if (!item.data || typeof item.data !== 'object') {
          return false;
        }
        const dataKeys = Object.keys(item.data);
        if (dataKeys.length === 1 && item.data.enabled === true) {
          return false;
        }
        if (item.item_key && item.item_key.startsWith('solution-')) {
          return true;
        }
        const hasSolutions = item.data.solutions && Array.isArray(item.data.solutions) && item.data.solutions.length > 0;
        const hasSolution = item.data.solution && typeof item.data.solution === 'string' && item.data.solution.trim() !== '';
        const hasLogiciel = item.data.logiciel && typeof item.data.logiciel === 'string' && item.data.logiciel.trim() !== '';
        if (hasSolutions || hasSolution || hasLogiciel) {
          return true;
        }
        if (item.name && (item.name.includes('BitDefender') || item.name.includes('Kaspersky') || item.name.includes('Symantec') || item.name.includes('Trend') || item.name.includes('McAfee') || item.name.includes('Norton') || item.name.includes('Avast') || item.name.includes('AVG'))) {
          return true;
        }
        if ((item.item_key === monitoringKey || item.item_key === equipementKey || item.name === monitoringKey || item.name === equipementKey) && !hasSolutions && !hasSolution && !hasLogiciel) {
          return false;
        }
        if (dataKeys.length > 0 && !(dataKeys.length === 1 && dataKeys[0] === 'enabled')) {
          return true;
        }
        return false;
      });
      if (realItems.length > 0) {
        const firstItem = realItems[0];
        if (firstItem.data.solutions && Array.isArray(firstItem.data.solutions) && realItems.length === 1) {
          equipements.Antivirus = firstItem.data;
        } else {
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
              is_active: item.is_active
            }))
          };
        }
      }
    } else if (equipementKey === 'Office365') {
      const realItems = items.filter(item => item.data && item.data.licences && !(Object.keys(item.data).length === 1 && item.data.enabled === true) && item.item_key !== monitoringKey && item.item_key !== equipementKey && item.name !== monitoringKey && item.name !== equipementKey);
      if (realItems.length > 0) {
        const mainItem = realItems[0];
        equipements[equipementKey] = mainItem.data || {
          licences: []
        };
      }
    } else {
      const filteredItems = items.filter(item => {
        const isFlag = (item.item_key === monitoringKey || item.item_key === equipementKey || item.name === monitoringKey || item.name === equipementKey) && item.data && typeof item.data === 'object' && Object.keys(item.data).length === 1 && item.data.enabled === true;
        return !isFlag;
      });
      equipements[equipementKey] = filteredItems.map(item => {
        const itemData = item.data && typeof item.data === 'object' ? item.data : {};
        const {
          id: _dataId,
          ...dataWithoutId
        } = itemData;
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
  if (options.azureHasCredentials) {
    modules_monitoring.Office365 = true;
  }
  return {
    modules,
    modules_monitoring,
    equipements
  };
}
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
    TOIP: Array.isArray(equipements.TOIP) ? equipements.TOIP.length : 0
  };
}
