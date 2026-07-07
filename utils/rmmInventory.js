/** Clés JSON inventaire associées à chaque collecteur RMM. */

import { repairRmmInventoryTextFields } from "./rmmTextEncoding.js";

export const RMM_COLLECTOR_DATA_KEYS = {

  os: ["os", "systeme"],

  domain: ["domain", "domaine"],

  network: ["network", "ip", "mac"],

  hardware: ["hardware", "processeur", "memoire", "stockage"],

  chassis: ["chassis", "fabricant", "marque", "manufacturer", "modele", "model", "numeroSerie", "serial"],

  session: ["loggedUser", "session"],

  updates: ["updates"],

  license: ["license"],

  software: ["software"],

  performance: ["performance"],

  sensors: ["sensors"],

  security: ["security"],

  printers: ["printers"],

  shares: ["shares"],

  services: ["services"],

  peripherals: ["peripherals"],

};



/** Collecteurs exécutés uniquement lors d'un inventaire complet (sync). */

export const RMM_SYNC_ONLY_COLLECTORS = new Set([

  "printers",

  "shares",

  "software",

  "services",

  "peripherals",

]);



export const RMM_COLLECTOR_META = [

  {

    key: "os",

    label: "Système d'exploitation",

    description: "Nom, version, build, édition Windows, date d'installation et dernier démarrage.",

    group: "system",

  },

  {

    key: "domain",

    label: "Domaine / workgroup",

    description: "Appartenance au domaine Active Directory ou workgroup.",

    group: "system",

  },

  {

    key: "session",

    label: "Session utilisateur",

    description: "Compte Windows actuellement connecté sur le poste.",

    group: "system",

  },

  {

    key: "network",

    label: "Réseau",

    description: "Cartes réseau actives, IP, MAC, passerelle et DNS.",

    group: "system",

  },

  {

    key: "updates",

    label: "Correctifs Windows",

    description: "Hotfixes récents, mises à jour et pilotes en attente, redémarrage requis.",

    group: "system",

  },

  {

    key: "license",

    label: "Licence Windows",

    description: "Édition Windows activée sur le poste.",

    group: "system",

  },

  {

    key: "chassis",

    label: "Marque, modèle & n° de série",

    description: "Constructeur, modèle du poste et numéro de série BIOS.",

    group: "hardware",

  },

  {

    key: "hardware",

    label: "Matériel",

    description: "Processeur, RAM, disques logiques/physiques et cartes graphiques.",

    group: "hardware",

  },

  {

    key: "performance",

    label: "Performance",

    description: "Charge CPU, utilisation RAM, uptime et nombre de processus.",

    group: "monitoring",

  },

  {

    key: "sensors",

    label: "Capteurs",

    description: "Températures (zones thermiques WMI) et état batterie sur portable.",

    group: "monitoring",

  },

  {

    key: "security",

    label: "Sécurité locale",

    description: "Windows Defender, pare-feu et BitLocker si disponibles.",

    group: "monitoring",

  },

  {

    key: "printers",

    label: "Imprimantes",

    description: "Imprimantes installées, pilote, port et imprimante par défaut.",

    group: "sync",

    syncOnly: true,

  },

  {

    key: "shares",

    label: "Partages & lecteurs mappés",

    description: "Lecteurs réseau mappés et partages locaux Windows.",

    group: "sync",

    syncOnly: true,

  },

  {

    key: "services",

    label: "Services critiques",

    description: "État des services Windows essentiels (spooler, Defender, RPC…).",

    group: "sync",

    syncOnly: true,

  },

  {

    key: "peripherals",

    label: "Écrans & périphériques USB",

    description: "Moniteurs connectés et périphériques USB/HID détectés.",

    group: "sync",

    syncOnly: true,

  },

  {

    key: "software",

    label: "Logiciels installés",

    description:

      "Liste des programmes depuis le registre Windows (jusqu'à 150 entrées). Collecté uniquement lors d'une synchronisation complète.",

    group: "sync",

    syncOnly: true,

    heavy: true,

  },

];



function pickInventoryText(...values) {

  for (const value of values) {

    const text = String(value ?? "").trim();

    if (text) return text;

  }

  return null;

}



function applyChassisFields(merged, inventory) {

  const chassis = inventory.chassis || {};

  const manufacturer = pickInventoryText(

    inventory.fabricant,

    inventory.marque,

    inventory.manufacturer,

    chassis.manufacturer

  );

  const model = pickInventoryText(inventory.modele, inventory.model, chassis.model);

  const serial = pickInventoryText(inventory.numeroSerie, inventory.serial, chassis.serialNumber);



  if (manufacturer) {

    merged.fabricant = manufacturer;

    merged.marque = manufacturer;

    merged.manufacturer = manufacturer;

  }

  if (model) {

    merged.modele = model;

    merged.model = model;

  }

  if (serial) {

    merged.numeroSerie = serial;

    merged.serial = serial;

  }

  if (manufacturer || model || serial) {

    merged.chassis = {

      ...(merged.chassis && typeof merged.chassis === "object" ? merged.chassis : {}),

      ...(manufacturer ? { manufacturer } : {}),

      ...(model ? { model } : {}),

      ...(serial ? { serialNumber: serial } : {}),

    };

  }

}



function resolveRmmNetbiosName(inventory, meta, existingData = {}) {
  return (
    inventory.hostname ||
    meta.hostname ||
    existingData.netbios ||
    existingData.hostname ||
    null
  );
}

function resolveRmmVeritasName(existingData = {}, netbios = null) {
  return existingData.nom || existingData.name || netbios || null;
}

function mergeLightInventory(existingData, inventory, meta) {

  const netbios = resolveRmmNetbiosName(inventory, meta, existingData);



  const merged = {

    ...(existingData && typeof existingData === "object" ? existingData : {}),

    nom: resolveRmmVeritasName(existingData, netbios),

    netbios: netbios || existingData.netbios || null,

    hostname: netbios || existingData.hostname || null,

    machineId: meta.machineId || inventory.machineId || existingData.machineId,

    agentId: meta.agentId || existingData.agentId,

    agentVersion: meta.agentVersion || inventory.agentVersion || existingData.agentVersion || null,

    source: "rmm",

    lastInventoryAt: new Date().toISOString(),

    agentOnline: true,

    inventoryMode: "light",

    collectedAt: inventory.collectedAt || existingData.collectedAt,

  };



  if (inventory.os?.name || inventory.systeme) {

    merged.systeme = inventory.os?.name || inventory.systeme || merged.systeme;

  }

  if (inventory.os) merged.os = { ...(merged.os || {}), ...inventory.os };

  if (inventory.domain) {

    merged.domain = { ...(merged.domain || {}), ...inventory.domain };

    merged.domaine =

      inventory.domaine ||

      (inventory.domain?.joined

        ? inventory.domain.name

        : inventory.domain?.workgroup || inventory.domain?.name) ||

      merged.domaine;

  }

  if (inventory.session) merged.session = { ...(merged.session || {}), ...inventory.session };

  if (inventory.loggedUser) merged.loggedUser = inventory.loggedUser;



  if (inventory.network || inventory.ip || inventory.mac) {

    const prevNetwork = merged.network && typeof merged.network === "object" ? merged.network : {};

    const nextNetwork = inventory.network && typeof inventory.network === "object" ? inventory.network : {};

    merged.network = {

      ...prevNetwork,

      ...nextNetwork,

      adapters: nextNetwork.adapters ?? prevNetwork.adapters,

    };

    merged.ip = inventory.network?.ip || inventory.ip || merged.ip;

    merged.mac = inventory.network?.mac || inventory.mac || merged.mac;

  }



  if (inventory.hardware) {

    const prevHw = merged.hardware && typeof merged.hardware === "object" ? merged.hardware : {};

    merged.hardware = {

      ...prevHw,

      ...inventory.hardware,

      physicalDisks: inventory.hardware.physicalDisks ?? prevHw.physicalDisks,

      gpus: inventory.hardware.gpus ?? prevHw.gpus,

    };

    if (inventory.processeur) merged.processeur = inventory.processeur;

    if (inventory.memoire) merged.memoire = inventory.memoire;

  }



  if (inventory.updates) {

    const prevUpdates = merged.updates && typeof merged.updates === "object" ? merged.updates : {};

    merged.updates = {

      ...prevUpdates,

      ...inventory.updates,

      pendingItems: inventory.updates.pendingItems ?? prevUpdates.pendingItems,

      driverItems: inventory.updates.driverItems ?? prevUpdates.driverItems,

      pendingCount:

        inventory.updates.pendingCount != null

          ? inventory.updates.pendingCount

          : prevUpdates.pendingCount,

      driverCount:

        inventory.updates.driverCount != null

          ? inventory.updates.driverCount

          : prevUpdates.driverCount,

      pending: inventory.updates.pending ?? prevUpdates.pending,

    };

  }



  if (inventory.performance) merged.performance = inventory.performance;

  if (inventory.sensors) merged.sensors = inventory.sensors;

  if (inventory.security) merged.security = inventory.security;



  return merged;

}



const USER_SITE_KEYS = ["site", "location", "emplacement"];



function resolveExistingSiteValue(existingData = {}) {

  for (const key of USER_SITE_KEYS) {

    const value = existingData[key];

    if (value == null) continue;

    const trimmed = String(value).trim();

    if (trimmed && trimmed !== "Sans site") return trimmed;

  }

  return null;

}



function preserveUserSiteFields(merged, existingData = {}) {

  const site = resolveExistingSiteValue(existingData);

  if (!site) return;

  for (const key of USER_SITE_KEYS) {

    merged[key] = site;

  }

}

const AGENT_SYNC_REQUEST_KEYS = [
  "syncRequestedAt",
  "sync_requested_at",
  "Sync_requested_at",
  "SyncRequestedAt",
];

function stripAgentSyncRequestFields(data = {}) {
  if (!data || typeof data !== "object") return;
  for (const key of AGENT_SYNC_REQUEST_KEYS) {
    delete data[key];
  }
}



/**

 * Fusionne l'inventaire entrant avec les données existantes et retire les sections

 * dont le collecteur est désactivé côté administration.

 */

export function mergeRmmInventoryData(existingData = {}, inventory = {}, meta = {}, collectors = {}) {

  const isLight = inventory.inventoryMode === "light";

  const netbios = resolveRmmNetbiosName(inventory, meta, existingData);



  let merged;



  if (isLight) {

    merged = mergeLightInventory(existingData, inventory, meta);

  } else {

    merged = {

      ...(existingData && typeof existingData === "object" ? existingData : {}),

      nom: resolveRmmVeritasName(existingData, netbios),

      netbios: netbios || existingData.netbios || null,

      hostname: netbios || existingData.hostname || null,

      machineId: meta.machineId || inventory.machineId || existingData.machineId,

      agentId: meta.agentId || existingData.agentId,

      agentVersion: meta.agentVersion || inventory.agentVersion || existingData.agentVersion || null,

      source: "rmm",

      lastInventoryAt: new Date().toISOString(),

      lastFullInventoryAt: new Date().toISOString(),

      agentOnline: true,

      ...(inventory && typeof inventory === "object" ? inventory : {}),

    };

    merged.nom = resolveRmmVeritasName(existingData, netbios);
    merged.netbios = netbios || merged.netbios || existingData.netbios || null;
    merged.hostname = netbios || merged.hostname || existingData.hostname || null;



    if (inventory.os?.name || inventory.systeme) {

      merged.systeme = inventory.os?.name || inventory.systeme || merged.systeme;

    }

    if (inventory.domain || inventory.domaine) {

      merged.domaine =

        inventory.domaine ||

        (inventory.domain?.joined

          ? inventory.domain.name

          : inventory.domain?.workgroup || inventory.domain?.name) ||

        merged.domaine;

    }

    if (inventory.network?.ip || inventory.ip) {

      merged.ip = inventory.network?.ip || inventory.ip || merged.ip;

    }

    if (inventory.network?.mac || inventory.mac) {

      merged.mac = inventory.network?.mac || inventory.mac || merged.mac;

    }



    applyChassisFields(merged, inventory);

  }



  if (!isLight) {

    applyChassisFields(merged, inventory);

  }



  for (const [collectorKey, enabled] of Object.entries(collectors)) {

    if (enabled) continue;

    const keys = RMM_COLLECTOR_DATA_KEYS[collectorKey];

    if (!keys) continue;

    for (const key of keys) {

      delete merged[key];

    }

  }

  if (!isLight) {
    merged.lastFullInventoryAt = new Date().toISOString();
  } else if (existingData.lastFullInventoryAt) {
    merged.lastFullInventoryAt = existingData.lastFullInventoryAt;
  }

  preserveUserSiteFields(merged, existingData);

  stripAgentSyncRequestFields(merged);

  return repairRmmInventoryTextFields(merged);

}

