// Helper pour transformer les données des nouvelles tables v_b_clients_m_* 
// vers le format attendu par le frontend (modules, modules_monitoring, equipements)

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
 * Transforme les données brutes des nouvelles tables vers le format frontend
 * @param {Object} rawData - Données brutes depuis les tables v_b_clients_m_*
 * @param {Object} options - Options additionnelles
 * @param {boolean} options.azureHasCredentials - True si des credentials Entra (v_b_clients_azure) existent
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

  // Mapping pour les équipements (pluriel pour Firewalls)
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

  // Mapping pour les modules de monitoring (singulier pour Firewall)
  const familyToMonitoringKey = {
    internet: 'Internet',
    servers: 'Serveurs',
    stockage: 'Stockage',
    firewall: 'Firewall', // Singulier pour modules_monitoring
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
    if (family === 'module') continue; // Déjà traité

    const equipementKey = familyToEquipementKey[family];
    const monitoringKey = familyToMonitoringKey[family];
    if (!equipementKey || !monitoringKey) continue;
    

    // Déterminer si le module de monitoring est activé
    // Chercher un item qui est un flag d'activation (item_key ou name = nom du module)
    const monitoringItem = items.find(item => 
      (item.item_key === monitoringKey || item.item_key === equipementKey || 
       item.name === monitoringKey || item.name === equipementKey) && 
      (item.data?.enabled === true || item.is_active === true)
    );
    
    // Si aucun flag trouvé, vérifier s'il y a des équipements réels (alors le module est actif)
    if (monitoringItem) {
      modules_monitoring[monitoringKey] = true;
    } else {
      // Vérifier s'il y a des équipements réels (pas juste des flags)
      // Pour Antivirus, on doit aussi vérifier si l'item avec item_key="Antivirus" a des solutions
      const hasRealEquipments = items.some(item => {
        if (!item.data || Object.keys(item.data).length === 0) return false;
        // Exclure les flags "enabled"
        if (Object.keys(item.data).length === 1 && item.data.enabled === true) return false;
        
        // Pour Antivirus : si l'item a item_key="Antivirus" mais contient des solutions, c'est un vrai équipement
        if (equipementKey === 'Antivirus' && 
            (item.item_key === monitoringKey || item.item_key === equipementKey ||
             item.name === monitoringKey || item.name === equipementKey)) {
          const hasSolutions = item.data.solutions && Array.isArray(item.data.solutions) && item.data.solutions.length > 0;
          const hasSolution = item.data.solution && typeof item.data.solution === 'string' && item.data.solution.trim() !== '';
          if (hasSolutions || hasSolution) return true;
        }
        
        // Exclure les items où item_key ou name correspond au nom du module (sauf si c'est Antivirus avec solutions, déjà traité ci-dessus)
        if (item.item_key === monitoringKey || item.item_key === equipementKey ||
            item.name === monitoringKey || item.name === equipementKey) return false;
        return true;
      });
      modules_monitoring[monitoringKey] = hasRealEquipments;
    }

    // Extraire les équipements
    if (equipementKey === 'Sauvegarde') {
      // Sauvegarde : agréger toutes les instances individuelles en un objet avec instances: []
      // Filtrer les items qui sont de vraies instances (ont un logiciel) ou qui contiennent instances: []
      // OU qui sont des jobs (item_key commence par 'job-')
      const realItems = items.filter(item => {
        if (!item.data || typeof item.data !== 'object') return false;
        
        // Exclure les flags "enabled" uniquement
        const dataKeys = Object.keys(item.data);
        if (dataKeys.length === 1 && item.data.enabled === true) return false;
        
        // Garder les jobs : item_key commence par 'job-'
        if (item.item_key && item.item_key.startsWith('job-')) {
          return true;
        }
        
        // Exclure les items où item_key ou name correspond exactement au nom du module (flag d'activation)
        if (item.item_key === monitoringKey || item.item_key === equipementKey ||
            item.name === monitoringKey || item.name === equipementKey) {
          // Mais garder si c'est une vraie instance (a un logiciel ou instances: [])
          if (item.data.logiciel || (item.data.instances && Array.isArray(item.data.instances))) {
            return true;
          }
          return false;
        }
        
        // Garder les items qui ont un logiciel (nouvelle structure) ou instances: [] (ancienne structure)
        return item.data.logiciel || (item.data.instances && Array.isArray(item.data.instances));
      });
      
      if (realItems.length > 0) {
        // Si on a plusieurs items, ce sont des instances individuelles (nouvelle structure)
        // Si on a un seul item avec instances: [], c'est l'ancienne structure
        const firstItem = realItems[0];
        if (firstItem.data.instances && Array.isArray(firstItem.data.instances) && realItems.length === 1) {
          // Ancienne structure : une seule ligne avec { instances: [...] }
          equipements.Sauvegarde = firstItem.data;
        } else {
          // Nouvelle structure : une ligne par instance ET des lignes job-{instanceId} séparées
          // Trier par name pour garder un ordre cohérent
          const sortedItems = [...realItems].sort((a, b) => {
            const nameA = a.name || a.item_key || '';
            const nameB = b.name || b.item_key || '';
            return nameA.localeCompare(nameB);
          });

          // Séparer les instances et les jobs
          // Les jobs ont item_key qui commence par 'job-' OU data.type === 'job'
          // Les instances ont data.type === 'instance' OU ont un logiciel (et ne sont pas des jobs)
          const instanceItems = sortedItems.filter(item => {
            // Si c'est un job (item_key commence par 'job-'), ce n'est pas une instance
            if (item.item_key && item.item_key.startsWith('job-')) return false;
            // Si data.type === 'instance', c'est une instance
            if (item.data && item.data.type === 'instance') return true;
            // Si data.type === 'job', ce n'est pas une instance
            if (item.data && item.data.type === 'job') return false;
            // Sinon, si l'item a un logiciel, c'est une instance
            return item.data && item.data.logiciel;
          });
          const jobItems = sortedItems.filter(item => {
            // Un job a item_key qui commence par 'job-' OU data.type === 'job'
            return (item.item_key && item.item_key.startsWith('job-')) || 
                   (item.data && item.data.type === 'job');
          });

          const instances = instanceItems.map(instanceItem => {
            const instanceData = { ...instanceItem.data };
            // Retirer le marqueur type
            delete instanceData.type;

            // L'identifiant côté frontend peut être stocké dans instanceData.instanceId,
            // sinon utiliser l'id de la ligne en base
            const instanceFrontendId = instanceData.instanceId || instanceItem.id;

            // Trouver les jobs liés via l'item_key 'job-{instanceFrontendId}'
            const instanceJobs = jobItems
              .filter(jobItem => {
                const jobItemKey = jobItem.item_key || '';
                // L'item_key du job est 'job-{instanceId}'
                if (jobItemKey.startsWith('job-')) {
                  const jobInstanceId = jobItemKey.substring(4); // Enlever 'job-'
                  return jobInstanceId === instanceFrontendId;
                }
                // Fallback : si le job a data.type === 'job' mais pas d'item_key, 
                // on ne peut pas le lier (ne devrait pas arriver)
                return false;
              })
              .map(jobItem => {
                const jobData = { ...jobItem.data };
                // Ne supprimer le type que s'il s'agit du marqueur 'job' (pour compatibilité avec anciennes données)
                // Sinon, préserver le type de sauvegarde (Complète, Incrémentale, etc.)
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
      // Antispam : agréger toutes les solutions individuelles en un objet avec solutions: []
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
        // Si on a plusieurs items, ce sont des solutions individuelles (nouvelle structure)
        // Si on a un seul item avec solutions: [], c'est l'ancienne structure
        const firstItem = realItems[0];
        if (firstItem.data.solutions && Array.isArray(firstItem.data.solutions) && realItems.length === 1) {
          // Ancienne structure : une seule ligne avec { solutions: [...] }
          equipements.Antispam = firstItem.data;
        } else {
          // Nouvelle structure : une ligne par solution, on les agrège
          const sortedItems = [...realItems].sort((a, b) => {
            const nameA = a.name || a.item_key || '';
            const nameB = b.name || b.item_key || '';
            return nameA.localeCompare(nameB);
          });
          equipements.Antispam = {
            solutions: sortedItems.map(item => ({
              id: item.id, // Garder l'ID pour les mises à jour
              ...item.data
            }))
          };
        }
      }
    } else if (equipementKey === 'Antivirus') {
      // Antivirus : agréger toutes les solutions individuelles en un objet avec solutions: []
      // On garde TOUS les items qui ont des données réelles (pas juste un flag enabled)
      const realItems = items.filter(item => {
        if (!item.data || typeof item.data !== 'object') {
          return false;
        }
        const dataKeys = Object.keys(item.data);
        
        // Exclure uniquement les flags d'activation simples (uniquement {enabled: true})
        if (dataKeys.length === 1 && item.data.enabled === true) {
          return false;
        }
        
        // Si l'item_key commence par "solution-", c'est une vraie solution antivirus
        if (item.item_key && item.item_key.startsWith('solution-')) {
          return true;
        }
        
        // Si l'item a des solutions ou une solution, c'est une vraie donnée antivirus
        const hasSolutions = item.data.solutions && Array.isArray(item.data.solutions) && item.data.solutions.length > 0;
        const hasSolution = item.data.solution && typeof item.data.solution === 'string' && item.data.solution.trim() !== '';
        const hasLogiciel = item.data.logiciel && typeof item.data.logiciel === 'string' && item.data.logiciel.trim() !== '';
        
        // Garder si c'est une vraie solution (a un solution, solutions, ou logiciel)
        if (hasSolutions || hasSolution || hasLogiciel) {
          return true;
        }
        
        // Si le name contient le nom d'une solution connue, c'est probablement une vraie solution
        if (item.name && (item.name.includes('BitDefender') || item.name.includes('Kaspersky') || 
            item.name.includes('Symantec') || item.name.includes('Trend') || 
            item.name.includes('McAfee') || item.name.includes('Norton') || 
            item.name.includes('Avast') || item.name.includes('AVG'))) {
          return true;
        }
        
        // Exclure uniquement les items où item_key ou name correspond exactement au nom du module
        // ET qui n'ont pas de vraies données (pas de solution/solutions/logiciel)
        if ((item.item_key === monitoringKey || item.item_key === equipementKey ||
             item.name === monitoringKey || item.name === equipementKey) &&
            !hasSolutions && !hasSolution && !hasLogiciel) {
          return false;
        }
        
        // Si l'item a d'autres données (pas juste enabled), on le garde aussi
        // Cela permet de garder les items avec des données personnalisées
        if (dataKeys.length > 0 && !(dataKeys.length === 1 && dataKeys[0] === 'enabled')) {
          return true;
        }
        
        return false;
      });
      
      if (realItems.length > 0) {
        // Si on a plusieurs items, ce sont des solutions individuelles (nouvelle structure)
        // Si on a un seul item avec solutions: [], c'est l'ancienne structure
        const firstItem = realItems[0];
        if (firstItem.data.solutions && Array.isArray(firstItem.data.solutions) && realItems.length === 1) {
          // Ancienne structure : une seule ligne avec { solutions: [...] }
          equipements.Antivirus = firstItem.data;
        } else {
          // Nouvelle structure : une ligne par solution, on les agrège
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
      // Office365 a des licences
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
      // Pour les tableaux d'équipements (Internet, Serveurs, NAS, Firewalls, etc.)
      // Filtrer UNIQUEMENT les flags "enabled" (item_key/name = nom du module ET data = {enabled: true})
      const filteredItems = items.filter(item => {
        // Exclure uniquement les flags d'activation de module
        const isFlag = (item.item_key === monitoringKey || item.item_key === equipementKey ||
                       item.name === monitoringKey || item.name === equipementKey) &&
                       item.data && 
                       typeof item.data === 'object' &&
                       Object.keys(item.data).length === 1 && 
                       item.data.enabled === true;
        
        return !isFlag;
      });
      
      // Transformer en équipements (is_active vient des colonnes v_b_clients_m_*)
      equipements[equipementKey] = filteredItems.map(item => {
        // Utiliser data si présent, sinon créer un objet minimal
        const itemData = item.data && typeof item.data === 'object' ? item.data : {};
        const { id: _dataId, ...dataWithoutId } = itemData;
        
        // S'assurer qu'on a un nom
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

  // Activer automatiquement Entra si des credentials Azure existent
  if (options.azureHasCredentials) {
    modules_monitoring.Office365 = true;
  }

  return {
    modules,
    modules_monitoring,
    equipements
  };
}

/** Comptes matériel alignés sur getClientEquipmentTotal (EnterpriseDetailPage). */
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

