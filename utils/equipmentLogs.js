const LOG_CATEGORIES = new Set(["all", "modifications", "rmm", "remote", "user"]);

export function normalizeEquipmentLogCategory(value) {
  const category = String(value || "all").trim().toLowerCase();
  return LOG_CATEGORIES.has(category) ? category : "all";
}

/**
 * Construit la clause WHERE et les paramètres pour filtrer les logs d'un équipement.
 */
export function buildEquipmentLogQuery({
  clientId,
  family,
  equipmentName,
  equipmentDbId = null,
  search = "",
  category = "all",
}) {
  const decodedEquipmentName = decodeURIComponent(String(equipmentName || ""));
  const normalizedCategory = normalizeEquipmentLogCategory(category);
  const trimmedSearch = String(search || "").trim();

  const params = equipmentDbId
    ? [clientId, family, String(equipmentDbId).trim()]
    : [clientId, family, decodedEquipmentName];

  let where = equipmentDbId
    ? "client_id = $1 AND equipment_family = $2 AND equipment_id = $3"
    : "client_id = $1 AND equipment_family = $2 AND equipment_name = $3";

  if (trimmedSearch) {
    params.push(`%${trimmedSearch}%`);
    const searchIdx = params.length;
    where += ` AND (
      action ILIKE $${searchIdx}
      OR COALESCE(user_name, '') ILIKE $${searchIdx}
      OR COALESCE(details::text, '') ILIKE $${searchIdx}
    )`;
  }

  if (normalizedCategory === "modifications") {
    where += " AND action ILIKE 'Modification du champ%'";
  } else if (normalizedCategory === "all") {
    where += ` AND COALESCE(details->>'kind', '') <> 'rmm_heartbeat'`;
  } else if (normalizedCategory === "rmm") {
    where += ` AND (
      action ILIKE '%agent RMM%'
      OR action ILIKE 'Heartbeat%'
      OR action ILIKE 'Sync complet%'
      OR details->>'kind' LIKE 'rmm_%'
      OR COALESCE(user_name, '') = 'Agent RMM'
    )`;
  } else if (normalizedCategory === "remote") {
    where += ` AND (
      action ILIKE '%connexion distante%'
      OR details->>'kind' IN ('remote_access', 'quick_connect')
    )`;
  } else if (normalizedCategory === "user") {
    where += ` AND NOT (
      action ILIKE 'Modification du champ%'
      OR action ILIKE '%agent RMM%'
      OR action ILIKE 'Heartbeat%'
      OR action ILIKE 'Sync complet%'
      OR details->>'kind' LIKE 'rmm_%'
      OR COALESCE(user_name, '') = 'Agent RMM'
    )`;
  }

  return {
    where,
    params,
    category: normalizedCategory,
    search: trimmedSearch,
  };
}
