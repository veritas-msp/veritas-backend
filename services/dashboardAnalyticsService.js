import { pool } from "../database/db.js";
import { fetchMonitorableEquipmentStats } from "../utils/monitorableEquipmentStats.js";
import { hasSatisfactionTable } from "./ticketSatisfactionService.js";

const CLOSED_STATUSES = "('resolved', 'closed')";
const FIRST_TAKEOVER_SUBQUERY = `(SELECT h.created_at
  FROM v_b_ticket_status_history h
  WHERE h.ticket_id = t.id
    AND LOWER(COALESCE(h.old_status, '')) IN ('new', 'open', '')
    AND LOWER(COALESCE(h.new_status, '')) NOT IN ('new', 'open', '')
  ORDER BY h.created_at ASC
  LIMIT 1)`;

const TICKET_TYPE_LABELS = {
  incident: "Incident",
  demande: "Demande",
  probleme: "Problème",
  changement: "Changement",
};

const TICKET_STATUS_LABELS = {
  new: "Nouveau",
  open: "Ouvert",
  pending: "En attente",
  in_progress: "En cours",
  resolved: "Résolu",
  closed: "Fermé",
};

const TICKET_PRIORITY_LABELS = {
  urgent: "Urgent",
  high: "Haute",
  normal: "Normale",
  low: "Basse",
  critical: "Critique",
};

const EVENT_TYPE_LABELS = {
  intervention: "Intervention",
  presentation: "Présentation",
  maintenance_preventive: "Maintenance préventive",
  maintenance: "Maintenance",
  mise_a_jour: "Mise à jour",
  conge: "Congé",
  integration_monitoring: "Intégration monitoring",
  campagne: "Campagne",
  other: "Autre",
};

function parsePeriodStart(period) {
  const now = new Date();
  switch (String(period || "365d").toLowerCase()) {
    case "30d":
      return new Date(now.getTime() - 30 * 86400000);
    case "90d":
      return new Date(now.getTime() - 90 * 86400000);
    case "365d":
      return new Date(now.getTime() - 365 * 86400000);
    case "ytd":
      return new Date(now.getFullYear(), 0, 1);
    case "all":
      return null;
    default:
      return new Date(now.getTime() - 365 * 86400000);
  }
}

function parseIsoDate(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const err = new Error(`Date invalide (${label})`);
    err.code = "INVALID_DATE_RANGE";
    throw err;
  }
  return date.toISOString();
}

export function resolveDashboardDateRange({ period, startAt, endAt } = {}) {
  const hasCustom = Boolean(startAt || endAt);
  if (hasCustom) {
    const sinceIso = parseIsoDate(startAt, "début");
    const untilIso = parseIsoDate(endAt, "fin");
    if (sinceIso && untilIso && new Date(sinceIso) > new Date(untilIso)) {
      const err = new Error("La date de début doit être antérieure à la date de fin.");
      err.code = "INVALID_DATE_RANGE";
      throw err;
    }
    return {
      period: "custom",
      sinceIso,
      untilIso,
    };
  }

  const normalizedPeriod = String(period || "365d").toLowerCase();
  const since = parsePeriodStart(normalizedPeriod);
  return {
    period: normalizedPeriod,
    sinceIso: since ? since.toISOString() : null,
    untilIso: normalizedPeriod === "all" ? null : new Date().toISOString(),
  };
}

function buildRangeClause(params, column, sinceIso, untilIso) {
  let clause = "";
  if (sinceIso) {
    params.push(sinceIso);
    clause += ` AND ${column} >= $${params.length}`;
  }
  if (untilIso) {
    params.push(untilIso);
    clause += ` AND ${column} <= $${params.length}`;
  }
  return clause;
}

export function parseDashboardEntityFilters(input = {}) {
  const agentId = String(input.agentId || "").trim() || null;
  const clientRaw = input.clientId;
  const contactRaw = input.contactId;
  const clientId =
    clientRaw != null && clientRaw !== "" && Number.isFinite(Number(clientRaw))
      ? Number(clientRaw)
      : null;
  const contactId =
    contactRaw != null && contactRaw !== "" && Number.isFinite(Number(contactRaw))
      ? Number(contactRaw)
      : null;

  return { agentId, clientId, contactId };
}

function hasEntityFilters(filters = {}) {
  return Boolean(filters.agentId || filters.clientId || filters.contactId);
}

function buildTicketScopeClause(params, filters = {}, alias = "t") {
  let clause = "";
  if (filters.agentId) {
    params.push(filters.agentId);
    clause += ` AND ${alias}.assigned_user_id = $${params.length}::uuid`;
  }
  if (filters.clientId) {
    params.push(filters.clientId);
    clause += ` AND ${alias}.client_id = $${params.length}`;
  }
  if (filters.contactId) {
    params.push(filters.contactId);
    clause += ` AND ${alias}.requester_contact_id = $${params.length}`;
  }
  return clause;
}

function buildEventScopeClause(params, filters = {}, alias = "e") {
  let clause = "";
  if (filters.agentId) {
    params.push(filters.agentId);
    clause += ` AND COALESCE(${alias}.assigned_user_id, ${alias}.user_id) = $${params.length}::uuid`;
  }
  if (filters.clientId) {
    params.push(filters.clientId);
    clause += ` AND ${alias}.client_id = $${params.length}`;
  }
  if (filters.contactId) {
    params.push(filters.contactId);
    clause += ` AND ${alias}.client_id = (SELECT c.client_id FROM v_b_contacts c WHERE c.id = $${params.length})`;
  }
  return clause;
}

function round1(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 10) / 10;
}

function roundPct(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value));
}

function formatUserLabel(email, username) {
  const name = String(username || "").trim();
  if (name) return name;
  const local = String(email || "").split("@")[0];
  return local || "Agent";
}

function formatContactLabel(row) {
  const fullName = [row.prenom, row.nom].filter(Boolean).join(" ").trim();
  const company = String(row.client_name || "").trim();
  if (fullName && company) return `${fullName} · ${company}`;
  return fullName || row.email || "Contact";
}

function mapCountRows(rows, labelMap = {}) {
  return (rows || []).map((row) => {
    const key = String(row.key || row.status || row.priority || row.type || row.category || "").trim();
    const label = labelMap[key] || labelMap[key.toLowerCase()] || (key || "Autre");
    return { key: key || "other", label, count: Number(row.count) || 0 };
  });
}

function buildTrend(rows) {
  return (rows || []).map((row) => ({
    period: row.period,
    count: Number(row.count) || 0,
  }));
}

function buildWeekdayTrend(rows) {
  const byDay = new Map(
    (rows || []).map((row) => [Number(row.period), Number(row.count) || 0])
  );
  return [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    period: day,
    count: byDay.get(day) || 0,
  }));
}

function buildYearlyTrend(rows) {
  return (rows || [])
    .map((row) => ({
      period: Number(row.period),
      count: Number(row.count) || 0,
    }))
    .filter((row) => Number.isFinite(row.period))
    .sort((a, b) => a.period - b.period);
}

async function tableExists(tableName) {
  const result = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [tableName]);
  return Boolean(result.rows[0]?.ok);
}

async function fetchSupportStats({ sinceIso, untilIso, filters = {} }) {
  const params = [];
  const periodClause = buildRangeClause(params, "t.created_at", sinceIso, untilIso);
  const scopeClause = buildTicketScopeClause(params, filters, "t");
  const ticketWhere = `WHERE 1=1${periodClause}${scopeClause}`;
  const openNowParams = [];
  const openNowScope = buildTicketScopeClause(openNowParams, filters, "t");

  const [
    overviewResult,
    statusResult,
    priorityResult,
    typeResult,
    categoryResult,
    responseResult,
    resolutionResult,
    agentsResult,
    clientsResult,
    contactsResult,
    weekdayResult,
    yearlyResult,
    openNowResult,
    channelResult,
  ] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS created,
         COUNT(*) FILTER (WHERE t.status IN ${CLOSED_STATUSES})::int AS closed,
         COUNT(*) FILTER (WHERE t.status NOT IN ${CLOSED_STATUSES})::int AS open_snapshot
       FROM v_b_tickets t
       ${ticketWhere}`,
      params
    ),
    pool.query(
      `SELECT LOWER(COALESCE(t.status, 'open')) AS key, COUNT(*)::int AS count
       FROM v_b_tickets t
       ${ticketWhere}
       GROUP BY 1
       ORDER BY count DESC`,
      params
    ),
    pool.query(
      `SELECT LOWER(COALESCE(t.priority, 'normal')) AS key, COUNT(*)::int AS count
       FROM v_b_tickets t
       ${ticketWhere}
       GROUP BY 1
       ORDER BY count DESC`,
      params
    ),
    pool.query(
      `SELECT LOWER(COALESCE(t.type, 'incident')) AS key, COUNT(*)::int AS count
       FROM v_b_tickets t
       ${ticketWhere}
       GROUP BY 1
       ORDER BY count DESC`,
      params
    ),
    pool.query(
      `SELECT COALESCE(NULLIF(TRIM(t.category), ''), 'Sans catégorie') AS key, COUNT(*)::int AS count
       FROM v_b_tickets t
       ${ticketWhere}
       GROUP BY 1
       ORDER BY count DESC`,
      params
    ),
    pool.query(
      `SELECT
         AVG(EXTRACT(EPOCH FROM (${FIRST_TAKEOVER_SUBQUERY} - t.created_at)) / 3600.0)
           FILTER (WHERE ${FIRST_TAKEOVER_SUBQUERY} IS NOT NULL) AS avg_first_response_hours,
         COUNT(*) FILTER (WHERE ${FIRST_TAKEOVER_SUBQUERY} IS NOT NULL)::int AS with_first_response
       FROM v_b_tickets t
       ${ticketWhere}`,
      params
    ),
    pool.query(
      `SELECT
         AVG(EXTRACT(EPOCH FROM (COALESCE(t.closed_at, t.resolved_at) - t.created_at)) / 3600.0)
           FILTER (WHERE COALESCE(t.closed_at, t.resolved_at) IS NOT NULL) AS avg_resolution_hours,
         COUNT(*) FILTER (WHERE COALESCE(t.closed_at, t.resolved_at) IS NOT NULL)::int AS resolved_count
       FROM v_b_tickets t
       WHERE t.status IN ${CLOSED_STATUSES}${periodClause}${scopeClause}`,
      params
    ),
    pool.query(
      `SELECT
         u.id AS user_id,
         COALESCE(NULLIF(TRIM(u.username), ''), u.email, 'Agent') AS label,
         u.email,
         COUNT(t.id)::int AS assigned_count,
         COUNT(t.id) FILTER (WHERE t.status IN ${CLOSED_STATUSES})::int AS closed_count,
         COUNT(t.id) FILTER (WHERE t.status NOT IN ${CLOSED_STATUSES})::int AS open_count,
         AVG(EXTRACT(EPOCH FROM (COALESCE(t.closed_at, t.resolved_at) - t.created_at)) / 3600.0)
           FILTER (WHERE COALESCE(t.closed_at, t.resolved_at) IS NOT NULL) AS avg_resolution_hours
       FROM v_b_users u
       LEFT JOIN v_b_tickets t ON t.assigned_user_id = u.id${periodClause}${scopeClause}
       WHERE COALESCE(u.role, '') <> 'client'
         AND u.is_active = true
       GROUP BY u.id, u.username, u.email
       HAVING COUNT(t.id) > 0
       ORDER BY closed_count DESC, assigned_count DESC
       LIMIT 15`,
      params
    ),
    pool.query(
      `SELECT
         c.id AS client_id,
         COALESCE(c.name, c.contrat->>'nom', 'Client') AS label,
         COUNT(t.id)::int AS count
       FROM v_b_tickets t
       LEFT JOIN v_b_clients c ON c.id = t.client_id
       WHERE t.client_id IS NOT NULL${periodClause}${scopeClause}
       GROUP BY c.id, c.name, c.contrat
       ORDER BY count DESC`,
      params
    ),
    pool.query(
      `SELECT
         ct.id AS contact_id,
         ct.prenom,
         ct.nom,
         ct.email,
         COALESCE(cl.name, cl.contrat->>'nom') AS client_name,
         COUNT(t.id)::int AS count
       FROM v_b_tickets t
       LEFT JOIN v_b_contacts ct ON ct.id = t.requester_contact_id
       LEFT JOIN v_b_clients cl ON cl.id = ct.client_id
       WHERE t.requester_contact_id IS NOT NULL${periodClause}${scopeClause}
       GROUP BY ct.id, ct.prenom, ct.nom, ct.email, cl.name, cl.contrat
       ORDER BY count DESC`,
      params
    ),
    pool.query(
      `SELECT EXTRACT(ISODOW FROM t.created_at)::int AS period, COUNT(*)::int AS count
       FROM v_b_tickets t
       ${ticketWhere}
       GROUP BY 1
       ORDER BY 1 ASC`,
      params
    ),
    pool.query(
      `SELECT EXTRACT(YEAR FROM t.created_at)::int AS period, COUNT(*)::int AS count
       FROM v_b_tickets t
       ${ticketWhere}
       GROUP BY 1
       ORDER BY 1 ASC`,
      params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
       FROM v_b_tickets t
       WHERE t.status NOT IN ${CLOSED_STATUSES}${openNowScope}`,
      openNowParams
    ),
    pool.query(
      `SELECT LOWER(COALESCE(t.channel, 'web')) AS key, COUNT(*)::int AS count
       FROM v_b_tickets t
       ${ticketWhere}
       GROUP BY 1
       ORDER BY count DESC`,
      params
    ),
  ]);

  const overview = overviewResult.rows[0] || {};
  let satisfaction = null;

  if (await hasSatisfactionTable()) {
    const satParams = [...params];
    const satPeriod = periodClause.replace(/t\.created_at/g, "s.created_at");
    const [satOverview, satByAgent] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS responses,
           AVG(COALESCE(s.rating, 0))::float AS avg_rating,
           COUNT(*) FILTER (WHERE COALESCE(s.rating, 0) >= 4)::int AS promoters,
           COUNT(*) FILTER (WHERE COALESCE(s.rating, 0) <= 2)::int AS detractors
         FROM v_b_ticket_satisfaction s
         JOIN v_b_tickets t ON t.id = s.ticket_id
         WHERE COALESCE(s.rating, 0) > 0${satPeriod}${scopeClause}`,
        satParams
      ),
      pool.query(
        `SELECT
           u.id AS user_id,
           COALESCE(NULLIF(TRIM(u.username), ''), u.email, 'Agent') AS label,
           COUNT(s.id)::int AS responses,
           AVG(COALESCE(s.rating, 0))::float AS avg_rating
         FROM v_b_ticket_satisfaction s
         JOIN v_b_tickets t ON t.id = s.ticket_id
         LEFT JOIN v_b_users u ON u.id = t.assigned_user_id
         WHERE COALESCE(s.rating, 0) > 0${periodClause}${scopeClause}
         GROUP BY u.id, u.username, u.email
         HAVING COUNT(s.id) > 0
         ORDER BY responses DESC, avg_rating DESC
         LIMIT 10`,
        params
      ),
    ]);

    const satRow = satOverview.rows[0] || {};
    const responses = Number(satRow.responses) || 0;
    satisfaction = {
      responses,
      avgRating: round1(satRow.avg_rating),
      csatPercent: responses > 0 ? roundPct((Number(satRow.promoters) / responses) * 100) : null,
      detractorPercent: responses > 0 ? roundPct((Number(satRow.detractors) / responses) * 100) : null,
      byAgent: (satByAgent.rows || []).map((row) => ({
        userId: row.user_id,
        label: formatUserLabel(row.email, row.label),
        responses: Number(row.responses) || 0,
        avgRating: round1(row.avg_rating),
      })),
    };
  }

  const responseRow = responseResult.rows[0] || {};
  const resolutionRow = resolutionResult.rows[0] || {};

  return {
    overview: {
      created: Number(overview.created) || 0,
      closed: Number(overview.closed) || 0,
      openNow: Number(openNowResult.rows[0]?.count) || 0,
      closureRate:
        Number(overview.created) > 0
          ? roundPct((Number(overview.closed) / Number(overview.created)) * 100)
          : null,
    },
    timing: {
      avgFirstResponseHours: round1(responseRow.avg_first_response_hours),
      ticketsWithFirstResponse: Number(responseRow.with_first_response) || 0,
      avgResolutionHours: round1(resolutionRow.avg_resolution_hours),
      resolvedCount: Number(resolutionRow.resolved_count) || 0,
    },
    byStatus: mapCountRows(statusResult.rows, TICKET_STATUS_LABELS),
    byPriority: mapCountRows(priorityResult.rows, TICKET_PRIORITY_LABELS),
    byType: mapCountRows(typeResult.rows, TICKET_TYPE_LABELS),
    byCategory: mapCountRows(categoryResult.rows),
    byChannel: mapCountRows(channelResult.rows, {
      web: "Portail web",
      email: "E-mail",
      phone: "Téléphone",
      api: "API",
    }),
    weekdayTrend: buildWeekdayTrend(weekdayResult.rows),
    yearlyTrend: buildYearlyTrend(yearlyResult.rows),
    topAgents: (agentsResult.rows || []).map((row) => ({
      userId: row.user_id,
      label: formatUserLabel(row.email, row.label),
      assignedCount: Number(row.assigned_count) || 0,
      closedCount: Number(row.closed_count) || 0,
      openCount: Number(row.open_count) || 0,
      avgResolutionHours: round1(row.avg_resolution_hours),
    })),
    topClients: (clientsResult.rows || []).map((row) => ({
      clientId: row.client_id,
      label: row.label,
      count: Number(row.count) || 0,
    })),
    topContacts: (contactsResult.rows || []).map((row) => ({
      contactId: row.contact_id,
      label: formatContactLabel(row),
      count: Number(row.count) || 0,
    })),
    satisfaction,
  };
}

async function fetchPlanningStats({ sinceIso, untilIso, filters = {} }) {
  if (!(await tableExists("public.v_b_events"))) {
    return {
      available: false,
      overview: { total: 0, maintenanceYtd: 0, upcoming: 0 },
      byType: [],
      byAgent: [],
      monthlyTrend: [],
    };
  }

  const params = [];
  const periodClause = buildRangeClause(params, "e.start", sinceIso, untilIso);
  const scopeClause = buildEventScopeClause(params, filters, "e");
  const eventWhere = `WHERE 1=1${periodClause}${scopeClause}`;

  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();

  const [overviewResult, typeResult, agentResult, trendResult, upcomingResult, maintenanceYtdResult] =
    await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM v_b_events e ${eventWhere}`, params),
      pool.query(
        `SELECT LOWER(COALESCE(e.type, 'other')) AS key, COUNT(*)::int AS count
         FROM v_b_events e
         ${eventWhere}
         GROUP BY 1
         ORDER BY count DESC`,
        params
      ),
      pool.query(
        `SELECT
           u.id AS user_id,
           COALESCE(NULLIF(TRIM(u.username), ''), u.email, 'Agent') AS label,
           u.email,
           COUNT(e.id)::int AS count
         FROM v_b_events e
         LEFT JOIN v_b_users u ON u.id = COALESCE(e.assigned_user_id, e.user_id)
         ${eventWhere}
         GROUP BY u.id, u.username, u.email
         ORDER BY count DESC
         LIMIT 12`,
        params
      ),
      pool.query(
        `SELECT date_trunc('month', e.start)::date AS period, COUNT(*)::int AS count
         FROM v_b_events e
         ${eventWhere}
         GROUP BY 1
         ORDER BY 1 ASC`,
        params
      ),
      (() => {
        const upcomingParams = [sinceIso, untilIso];
        const upcomingScopeParams = [];
        const upcomingScope = buildEventScopeClause(upcomingScopeParams, filters, "e").replace(
          /\$(\d+)/g,
          (_, index) => `$${Number(index) + 2}`
        );
        return pool.query(
          `SELECT COUNT(*)::int AS count
           FROM v_b_events e
           WHERE e.start >= GREATEST(NOW(), COALESCE($1::timestamptz, '-infinity'::timestamptz))
             AND ($2::timestamptz IS NULL OR e.start <= $2::timestamptz)${upcomingScope}`,
          [...upcomingParams, ...upcomingScopeParams]
        );
      })(),
      (() => {
        const maintenanceParams = [yearStart];
        const maintenanceScopeParams = [];
        const maintenanceScope = buildEventScopeClause(maintenanceScopeParams, filters, "e").replace(
          /\$(\d+)/g,
          (_, index) => `$${Number(index) + 1}`
        );
        return pool.query(
          `SELECT COUNT(*)::int AS count
           FROM v_b_events e
           WHERE e.type IN ('maintenance', 'maintenance_preventive')
             AND e.start >= $1${maintenanceScope}`,
          [...maintenanceParams, ...maintenanceScopeParams]
        );
      })(),
    ]);

  const maintenanceTypes = ["maintenance", "maintenance_preventive"];
  const byType = mapCountRows(typeResult.rows, EVENT_TYPE_LABELS);
  const maintenanceInPeriod = byType
    .filter((row) => maintenanceTypes.includes(row.key))
    .reduce((sum, row) => sum + row.count, 0);

  return {
    available: true,
    overview: {
      total: Number(overviewResult.rows[0]?.total) || 0,
      maintenanceInPeriod,
      maintenanceYtd: Number(maintenanceYtdResult.rows[0]?.count) || 0,
      upcoming: Number(upcomingResult.rows[0]?.count) || 0,
    },
    byType,
    byAgent: (agentResult.rows || []).map((row) => ({
      userId: row.user_id,
      label: formatUserLabel(row.email, row.label),
      count: Number(row.count) || 0,
    })),
    monthlyTrend: buildTrend(trendResult.rows),
  };
}

async function fetchCrmStats({ sinceIso, untilIso, filters = {} }) {
  const contactParams = [];
  const contactPeriod = buildRangeClause(contactParams, "c.created_at", sinceIso, untilIso);
  const ticketParams = [];
  const ticketPeriod = buildRangeClause(ticketParams, "t.created_at", sinceIso, untilIso);
  const ticketScope = buildTicketScopeClause(ticketParams, filters, "t");
  const hasPeriod = Boolean(sinceIso || untilIso);
  const contactScope =
    filters.clientId != null
      ? (() => {
          contactParams.push(filters.clientId);
          return ` AND c.client_id = $${contactParams.length}`;
        })()
      : filters.contactId != null
        ? (() => {
            contactParams.push(filters.contactId);
            return ` AND c.id = $${contactParams.length}`;
          })()
        : "";

  const [clientsResult, contactsResult, clientsInPeriodResult, contractsResult] = await Promise.all([
    filters.clientId != null
      ? pool.query(`SELECT COUNT(*)::int AS count FROM v_b_clients WHERE id = $1`, [filters.clientId])
      : pool.query(`SELECT COUNT(*)::int AS count FROM v_b_clients`),
    tableExists("public.v_b_contacts").then((ok) =>
      ok
        ? pool.query(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE 1=1${contactPeriod})::int AS new_in_period
             FROM v_b_contacts c
             WHERE 1=1${contactScope}`,
            contactParams
          )
        : { rows: [{ total: 0, new_in_period: 0 }] }
    ),
    hasPeriod
      ? pool.query(
          `SELECT COUNT(DISTINCT t.client_id)::int AS count
           FROM v_b_tickets t
           WHERE t.client_id IS NOT NULL${ticketPeriod}${ticketScope}`,
          ticketParams
        )
      : Promise.resolve({ rows: [{ count: filters.clientId != null ? 1 : null }] }),
    filters.clientId != null
      ? pool.query(`SELECT id, name, contrat FROM v_b_clients WHERE id = $1`, [filters.clientId])
      : pool.query(`SELECT id, name, contrat FROM v_b_clients`),
  ]);

  let contractsExpiring = 0;
  let contractsExpired = 0;
  const now = Date.now();
  const windowMs = 30 * 86400000;
  const sinceMs = sinceIso ? new Date(sinceIso).getTime() : null;
  const untilMs = untilIso ? new Date(untilIso).getTime() : now;

  for (const row of contractsResult.rows) {
    let contrat = row.contrat;
    if (typeof contrat === "string") {
      try {
        contrat = JSON.parse(contrat);
      } catch {
        contrat = {};
      }
    }
    if (!contrat || contrat.suspendu) continue;
    const exp = contrat.expiration ? new Date(contrat.expiration).getTime() : NaN;
    if (!Number.isFinite(exp)) continue;

    if (hasPeriod) {
      if (exp >= sinceMs && exp <= untilMs) contractsExpiring += 1;
      continue;
    }

    if (exp < now) contractsExpired += 1;
    else if (exp - now <= windowMs) contractsExpiring += 1;
  }

  const contactRow = contactsResult.rows[0] || {};
  const clientsInPeriod = clientsInPeriodResult.rows[0]?.count;

  return {
    clientsTotal: hasPeriod
      ? Number(clientsInPeriod) || 0
      : Number(clientsResult.rows[0]?.count) || 0,
    clientsPortfolio: Number(clientsResult.rows[0]?.count) || 0,
    contactsTotal: Number(contactRow.total) || 0,
    contactsNew: Number(contactRow.new_in_period) || 0,
    contractsExpiring,
    contractsExpired,
  };
}

async function fetchReportsStats({ sinceIso, untilIso, filters = {} }) {
  if (!(await tableExists("public.document_history"))) {
    return { available: false, total: 0, inPeriod: 0, byType: [], monthlyTrend: [] };
  }

  const params = [];
  const periodClause = buildRangeClause(params, "r.created_at", sinceIso, untilIso);
  let scopeClause = "";
  if (filters.agentId) {
    params.push(filters.agentId);
    scopeClause += ` AND r.user_id = $${params.length}::uuid`;
  }
  const reportWhere = `WHERE COALESCE(r.is_trashed, false) = false${periodClause}${scopeClause}`;

  const [overviewResult, typeResult, trendResult] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE true${periodClause}${scopeClause})::int AS in_period
       FROM document_history r
       WHERE COALESCE(r.is_trashed, false) = false`,
      params
    ),
    pool.query(
      `SELECT LOWER(COALESCE(r.type, 'monitoring')) AS key, COUNT(*)::int AS count
       FROM document_history r
       ${reportWhere}
       GROUP BY 1
       ORDER BY count DESC`,
      params
    ),
    pool.query(
      `SELECT date_trunc('month', r.created_at)::date AS period, COUNT(*)::int AS count
       FROM document_history r
       ${reportWhere}
       GROUP BY 1
       ORDER BY 1 ASC`,
      params
    ),
  ]);

  const overview = overviewResult.rows[0] || {};
  return {
    available: true,
    total: Number(overview.total) || 0,
    inPeriod: Number(overview.in_period) || 0,
    byType: mapCountRows(typeResult.rows, {
      monitoring: "Monitoring",
      synthese: "Synthèse",
      intervention: "Intervention",
      crav: "CRAV",
    }),
    monthlyTrend: buildTrend(trendResult.rows),
  };
}

async function fetchInfrastructureStats() {
  const [equipmentStats, agentsResult, rmmResult] = await Promise.all([
    fetchMonitorableEquipmentStats(),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM v_b_users WHERE is_active = true AND COALESCE(role, '') <> 'client'`
    ),
    tableExists("public.v_b_rmm_agents").then((ok) =>
      ok
        ? pool.query(
            `SELECT COUNT(*)::int AS count FROM v_b_rmm_agents WHERE COALESCE(status, 'active') = 'active'`
          )
        : { rows: [{ count: 0 }] }
    ),
  ]);

  return {
    equipMonitoredTotal: equipmentStats.equipMonitoredTotal || 0,
    equipUnderSurveillanceCount: equipmentStats.equipUnderSurveillanceCount || 0,
    equipSurveillancePercent: roundPct(equipmentStats.equipSurveillancePercent),
    families: (equipmentStats.families || []).map((row) => ({
      key: row.key || row.family,
      label: row.label || row.key,
      count: Number(row.count) || 0,
      monitored: Number(row.monitored) || 0,
    })),
    activeAgents: Number(agentsResult.rows[0]?.count) || 0,
    rmmAgents: Number(rmmResult.rows[0]?.count) || 0,
  };
}

export async function fetchAnalyticsDashboard(options = "365d") {
  const input =
    typeof options === "string" ? { period: options } : options || {};
  const { period, startAt, endAt, agentId, clientId, contactId } = input;
  const range = resolveDashboardDateRange({ period, startAt, endAt });
  const { sinceIso, untilIso } = range;
  const filters = parseDashboardEntityFilters({ agentId, clientId, contactId });

  const [support, planning, crm, reports, infrastructure, satisfactionAvailable] =
    await Promise.all([
      fetchSupportStats({ sinceIso, untilIso, filters }),
      fetchPlanningStats({ sinceIso, untilIso, filters }),
      fetchCrmStats({ sinceIso, untilIso, filters }),
      fetchReportsStats({ sinceIso, untilIso, filters }),
      fetchInfrastructureStats(),
      hasSatisfactionTable(),
    ]);

  return {
    period: range.period,
    since: sinceIso,
    until: untilIso,
    generatedAt: new Date().toISOString(),
    filters: {
      agentId: filters.agentId,
      clientId: filters.clientId,
      contactId: filters.contactId,
      active: hasEntityFilters(filters),
    },
    modules: { satisfaction: satisfactionAvailable, planning: planning.available, reports: reports.available },
    summary: {
      ticketsCreated: support.overview.created,
      ticketsOpen: support.overview.openNow,
      avgFirstResponseHours: support.timing.avgFirstResponseHours,
      avgResolutionHours: support.timing.avgResolutionHours,
      eventsTotal: planning.overview.total,
      maintenanceInPeriod: planning.overview.maintenanceInPeriod,
      maintenanceYtd: planning.overview.maintenanceYtd,
      clientsTotal: crm.clientsTotal,
      reportsInPeriod: reports.inPeriod,
      equipMonitoredTotal: infrastructure.equipMonitoredTotal,
      satisfactionAvg: support.satisfaction?.avgRating ?? null,
    },
    support,
    planning,
    crm,
    reports,
    infrastructure,
  };
}
