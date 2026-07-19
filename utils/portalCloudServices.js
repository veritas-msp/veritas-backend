/**
 * Extracts cloud metadata exposable to the client portal (without secrets).
 */

const MODULE_FLAG_LABELS = {
  o365: ["Office365", "Microsoft 365"],
  save: ["Sauvegarde"],
  antivirus: ["Antivirus"],
  antispam: ["Antispam"],
  ndd: ["NDD"],
};

function pickString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text && text !== "N/A") return text;
  }
  return null;
}

function pickNumber(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function pickDate(...values) {
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function earliestDate(...values) {
  const timestamps = values
    .map((value) => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.getTime();
    })
    .filter((value) => value != null);
  if (!timestamps.length) return null;
  return new Date(Math.min(...timestamps)).toISOString();
}

function isActivationFlag(row, data, type) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  if (keys.length === 1 && data.enabled === true) return true;
  const labels = MODULE_FLAG_LABELS[type] || [];
  const key = row.item_key || row.name || "";
  if (labels.includes(key) && keys.length <= 1) return true;
  return false;
}

function mapLicenseRows(licences = []) {
  if (!Array.isArray(licences)) return [];
  return licences
    .map((lic) => ({
      name:
        pickString(
          lic.friendlyName,
          lic.productName,
          lic.skuPartNumber,
          lic.skuId,
          lic.name,
          lic.partNumber
        ) || "Licence",
      total: pickNumber(lic.total, lic.totalLicenses, lic.prepaidUnits?.enabled),
      used: pickNumber(lic.consumed, lic.used, lic.usedLicenses, lic.consumedUnits),
      expiration: pickDate(lic.expirationDate, lic.expiration),
    }))
    .filter((lic) => lic.name);
}

function mapO365Details(row, data) {
  const licences = mapLicenseRows(data.licences);
  const totalLicenses = licences.reduce((sum, lic) => sum + (lic.total ?? 0), 0);
  const usedLicenses = licences.reduce((sum, lic) => sum + (lic.used ?? 0), 0);
  return {
    kind: "o365",
    product: pickString(data.tenantName, row.name, "Microsoft 365"),
    tenantId: data.tenantId || null,
    userCount: Array.isArray(data.users) ? data.users.length : null,
    licensesTotal: totalLicenses || null,
    licensesUsed: usedLicenses || null,
    licenses: licences,
    expiration: earliestDate(
      ...licences.map((lic) => lic.expiration).filter(Boolean),
      data.expiration
    ),
  };
}

function mapAntivirusDetails(row, data) {
  return {
    kind: "antivirus",
    product: pickString(data.solution, data.logiciel, data.companyName, row.name),
    provider: pickString(data.providerId) || null,
    licensesTotal: pickNumber(data.licencesTotales, data.totalLicenses, data.license?.totalLicenses),
    licensesUsed: pickNumber(data.licencesUtilisees, data.usedLicenses, data.license?.usedLicenses),
    expiration: pickDate(data.expiration, data.expirationDate, data.license?.expirationDate),
    endpointCount: Array.isArray(data.endpoints) ? data.endpoints.length : null,
  };
}

function mapAntispamDetails(row, data) {
  return {
    kind: "antispam",
    product: pickString(data.logiciel, data.solution, data.customerName, row.name),
    licensesTotal: pickNumber(
      data.domainesSurveilles,
      data.licences,
      data.nombre_licences,
      data.licensesTotal
    ),
    licensesUsed: pickNumber(data.utilisateursProteges, data.utilisateurs, data.nombre_utilisateurs),
    expiration: pickDate(data.expiration, data.expirityDate),
  };
}

function mapSaveDetails(row, data) {
  const isJob =
    (row.item_key && String(row.item_key).startsWith("job-")) || data.type === "job";
  if (isJob) {
    return {
      kind: "saveJob",
      product: pickString(data.type, data.nom, "Job de sauvegarde"),
      jobType: pickString(data.type, data.jobType),
      lastBackup: pickDate(data.last_backup_date, data.lastBackupDate, data.lastBackup),
      expiration: pickDate(data.expiration, data.expirationGarantie),
    };
  }
  return {
    kind: "save",
    product: pickString(data.logiciel, data.nom, row.name),
    capacity: pickString(data.capacite, data.capacity),
    site: pickString(data.site, data.emplacement),
    expiration: pickDate(data.expiration, data.expirationGarantie, data.garantie),
    jobCount: Array.isArray(data.jobs) ? data.jobs.length : null,
    lastBackup: pickDate(
      ...(Array.isArray(data.jobs)
        ? data.jobs.map((job) => job.last_backup_date || job.lastBackupDate)
        : [])
    ),
  };
}

function mapNddDetails(row, data) {
  return {
    kind: "ndd",
    product: pickString(data.registrar, "Nom de domaine"),
    domain: pickString(data.nom, data.domaine, data.domain, data.name, row.name),
    registrar: pickString(data.registrar),
    autoRenew:
      data.autoRenew === true || data.auto_renewal === true
        ? true
        : data.autoRenew === false || data.auto_renewal === false
        ? false
        : null,
    expiration: pickDate(data.expiration, data.expirationDate, data.expirityDate),
    renewalMode: pickString(data.renewalMode),
  };
}

export function mapCloudServiceForPortal(type, row, rawData = {}) {
  const data = rawData && typeof rawData === "object" ? rawData : {};
  const base = {
    id: row.id,
    name: pickString(row.name, data.nom, data.name, data.domaine, data.domain, row.item_key) || "Sans nom",
    type,
    active: row.is_active !== false,
    monitored: Boolean(row.checkmk_host_name),
    product: null,
    expiration: null,
    licensesTotal: null,
    licensesUsed: null,
    licenses: [],
    details: {},
  };

  if (isActivationFlag(row, data, type)) {
    return null;
  }

  let details;
  switch (type) {
    case "o365":
      details = mapO365Details(row, data);
      break;
    case "antivirus":
      details = mapAntivirusDetails(row, data);
      break;
    case "antispam":
      details = mapAntispamDetails(row, data);
      break;
    case "save":
      details = mapSaveDetails(row, data);
      break;
    case "ndd":
      details = mapNddDetails(row, data);
      break;
    default:
      details = {
        kind: type,
        product: pickString(data.logiciel, data.solution, row.name),
        expiration: pickDate(data.expiration, data.expirationDate, data.expirationGarantie),
      };
  }

  return {
    ...base,
    product: details.product || base.name,
    expiration: details.expiration || null,
    licensesTotal: details.licensesTotal ?? null,
    licensesUsed: details.licensesUsed ?? null,
    licenses: details.licenses || [],
    details,
  };
}

export function expandCloudServiceRows(type, row, data) {
  const mapped = mapCloudServiceForPortal(type, row, data);
  if (mapped) return [mapped];

  if (type === "antivirus" && Array.isArray(data.solutions) && data.solutions.length) {
    return data.solutions
      .map((solution, index) =>
        mapCloudServiceForPortal(
          type,
          { ...row, id: `${row.id}-s${index}`, name: solution.solution || row.name },
          solution
        )
      )
      .filter(Boolean);
  }

  if (type === "antispam" && Array.isArray(data.solutions) && data.solutions.length) {
    return data.solutions
      .map((solution, index) =>
        mapCloudServiceForPortal(
          type,
          { ...row, id: `${row.id}-s${index}`, name: solution.logiciel || row.name },
          solution
        )
      )
      .filter(Boolean);
  }

  return [];
}
