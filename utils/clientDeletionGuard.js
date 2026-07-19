import { pool } from "../database/db.js";
import { ensureSslSchema } from "../services/ensureSslSchema.js";

export const CLIENT_DELETION_BLOCKER_DEFS = [
  {
    key: "equipment_infra",
    label: "Équipements infrastructure",
    tables: [
      "v_b_clients_m_internet",
      "v_b_clients_m_firewall",
      "v_b_clients_m_servers",
      "v_b_clients_m_stockage",
      "v_b_clients_m_switch",
      "v_b_clients_m_wifi",
      "v_b_clients_m_alimentation",
      "v_b_clients_m_routeur",
      "v_b_clients_m_toip",
      "v_b_clients_m_ordinateurs",
      "v_b_clients_m_custom_equipment",
    ],
  },
  {
    key: "equipment_cyber",
    label: "Cybersécurité & sauvegarde",
    tables: [
      "v_b_clients_m_antivirus",
      "v_b_clients_m_antispam",
      "v_b_clients_m_save",
    ],
  },
  {
    key: "campaigns",
    label: "Campagnes cybersécurité",
    query: `
      SELECT client_id::text AS client_id, COUNT(*)::int AS cnt
      FROM v_b_clients_c_campaign
      WHERE client_id IS NOT NULL
      GROUP BY client_id
    `,
  },
  {
    key: "equipment_services",
    label: "Services cloud & IT",
    tables: ["v_b_clients_m_o365", "v_b_clients_m_ndd", "v_b_clients_m_ssl", "v_b_clients_m_licences"],
  },
  {
    key: "azure_tenant",
    label: "Tenant Microsoft / Azure",
    query: `
      SELECT client_id::text AS client_id, COUNT(*)::int AS cnt
      FROM v_b_clients_azure
      WHERE client_id IS NOT NULL
      GROUP BY client_id
    `,
  },
  {
    key: "contacts",
    label: "Contacts",
    query: `
      SELECT client_id::text AS client_id, COUNT(*)::int AS cnt
      FROM v_b_contacts
      WHERE client_id IS NOT NULL
      GROUP BY client_id
    `,
  },
  {
    key: "tickets",
    label: "Tickets support",
    query: `
      SELECT client_id::text AS client_id, COUNT(*)::int AS cnt
      FROM v_b_tickets
      WHERE client_id IS NOT NULL
      GROUP BY client_id
    `,
  },
  {
    key: "events_upcoming",
    label: "Événements à venir",
    query: `
      SELECT client_id::text AS client_id, COUNT(*)::int AS cnt
      FROM v_b_events
      WHERE client_id IS NOT NULL
        AND "end" >= NOW()
      GROUP BY client_id
    `,
  },
  {
    key: "rmm_agents",
    label: "Agents RMM",
    query: `
      SELECT client_id::text AS client_id, COUNT(*)::int AS cnt
      FROM v_b_rmm_agents
      WHERE client_id IS NOT NULL
        AND COALESCE(status, 'active') <> 'revoked'
      GROUP BY client_id
    `,
  },
  {
    key: "client_files",
    label: "Fichiers entreprise",
    query: `
      SELECT client_id::text AS client_id, COUNT(*)::int AS cnt
      FROM v_b_client_files
      WHERE client_id IS NOT NULL
        AND COALESCE(is_deleted, false) = false
      GROUP BY client_id
    `,
  },
];

const EQUIPMENT_ROW_WHERE = `
  client_id IS NOT NULL
  AND COALESCE(is_active, true) = true
  AND (
    (data IS NOT NULL AND data::text NOT IN ('null', '{}', '[]', '""'))
    OR NULLIF(TRIM(COALESCE(name, '')), '') IS NOT NULL
    OR NULLIF(TRIM(COALESCE(item_key, '')), '') IS NOT NULL
  )
`;

const EMPTY_SUMMARY = () => ({
  deletable: true,
  blockers: [],
  totalBlockers: 0,
});

async function countByClientFromTables(tables) {
  const counts = {};
  for (const tableName of tables) {
    try {
      const result = await pool.query(`
        SELECT client_id::text AS client_id, COUNT(*)::int AS cnt
        FROM ${tableName}
        WHERE ${EQUIPMENT_ROW_WHERE}
        GROUP BY client_id
      `);
      for (const row of result.rows) {
        const clientId = String(row.client_id);
        counts[clientId] = (counts[clientId] || 0) + (Number(row.cnt) || 0);
      }
    } catch (err) {
      if (err.code === "42P01" || err.code === "42703") {
        console.warn(`[client-deletion] table skipped ${tableName}:`, err.message);
        continue;
      }
      throw err;
    }
  }
  return counts;
}

async function countByClientFromQuery(query, label) {
  try {
    const result = await pool.query(query);
    const counts = {};
    for (const row of result.rows) {
      counts[String(row.client_id)] = Number(row.cnt) || 0;
    }
    return counts;
  } catch (err) {
    if (err.code === "42P01" || err.code === "42703") {
      console.warn(`[client-deletion] query skipped (${label}):`, err.message);
      return {};
    }
    throw err;
  }
}

function mergeBlockerMaps(blockerMapsByKey) {
  const byClientId = {};

  for (const [key, { label, counts }] of Object.entries(blockerMapsByKey)) {
    for (const [clientId, count] of Object.entries(counts)) {
      if (!count || count <= 0) continue;
      if (!byClientId[clientId]) {
        byClientId[clientId] = [];
      }
      byClientId[clientId].push({ key, label, count });
    }
  }

  const summaryByClientId = {};
  for (const [clientId, blockers] of Object.entries(byClientId)) {
    summaryByClientId[clientId] = {
      deletable: false,
      blockers,
      totalBlockers: blockers.reduce((sum, item) => sum + item.count, 0),
    };
  }

  return summaryByClientId;
}

export async function fetchDeletionSummaryByClientId() {
  await ensureSslSchema();

  const blockerMapsByKey = {};

  await Promise.all(
    CLIENT_DELETION_BLOCKER_DEFS.map(async (def) => {
      let counts = {};
      if (def.tables) {
        counts = await countByClientFromTables(def.tables);
      } else if (def.query) {
        counts = await countByClientFromQuery(def.query, def.label);
      }
      blockerMapsByKey[def.key] = { label: def.label, counts };
    })
  );

  return mergeBlockerMaps(blockerMapsByKey);
}

export async function getClientDeletionStatus(clientId) {
  const all = await fetchDeletionSummaryByClientId();
  return all[String(clientId)] || EMPTY_SUMMARY();
}

export function attachDeletionSummary(clients, summaryByClientId = {}) {
  return clients.map((client) => {
    const summary = summaryByClientId[String(client.id)] || EMPTY_SUMMARY();
    return {
      ...client,
      deletion: summary,
      deletable: summary.deletable,
      deletion_blockers: summary.blockers,
    };
  });
}
