import { pool } from "../database/db.js";
import { decryptSetting } from "./settingsHelper.js";

export const TICKET_TABLE_COLUMNS_SECTION = "tickets";
export const TICKET_TABLE_COLUMNS_PUBLIC_KEY = "ticket_table_columns_public";
export const TICKET_TABLE_COLUMNS_PRIVATE_SETTING_KEY = "ticket_table_columns_private";

/** Colonnes configurables (checkbox / actions hors scope). */
export const TICKET_TABLE_COLUMN_IDS = Object.freeze([
  "ticket_number",
  "title",
  "channel",
  "type",
  "requester",
  "client",
  "assigned",
  "followers",
  "status",
  "priority",
  "sla",
  "created_at",
  "updated_at"
]);

export const DEFAULT_TICKET_TABLE_COLUMNS = Object.freeze([...TICKET_TABLE_COLUMN_IDS]);

const ALLOWED = new Set(TICKET_TABLE_COLUMN_IDS);

/**
 * @param {unknown} raw
 * @param {{ allowEmpty?: boolean, fallback?: string[] }} [options]
 * @returns {string[] | null}
 */
export function normalizeTicketTableColumns(raw, {
  allowEmpty = false,
  fallback = DEFAULT_TICKET_TABLE_COLUMNS
} = {}) {
  if (raw == null) return null;
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return fallback ? [...fallback] : null;
    }
  }
  if (list && typeof list === "object" && !Array.isArray(list) && Array.isArray(list.columns)) {
    list = list.columns;
  }
  if (!Array.isArray(list)) return fallback ? [...fallback] : null;

  const seen = new Set();
  const out = [];
  for (const item of list) {
    const id = String(item || "").trim();
    if (!ALLOWED.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length === 0) {
    return allowEmpty ? [] : (fallback ? [...fallback] : null);
  }
  return out;
}

export function filterColumnsForEdition(columns, { isCommunityEdition = false } = {}) {
  const list = Array.isArray(columns) ? columns : DEFAULT_TICKET_TABLE_COLUMNS;
  if (!isCommunityEdition) return [...list];
  return list.filter(id => id !== "sla");
}

export async function loadPublicTicketTableColumns() {
  try {
    const tableCheck = await pool.query("SELECT to_regclass('public.v_b_settings') AS settings_table");
    if (!tableCheck.rows[0]?.settings_table) {
      return [...DEFAULT_TICKET_TABLE_COLUMNS];
    }
    const result = await pool.query(
      `SELECT key, value, value_encrypted, value_iv, value_auth_tag
       FROM v_b_settings
       WHERE section = $1 AND key = $2`,
      [TICKET_TABLE_COLUMNS_SECTION, TICKET_TABLE_COLUMNS_PUBLIC_KEY]
    );
    if (!result.rows.length) {
      return [...DEFAULT_TICKET_TABLE_COLUMNS];
    }
    const raw = decryptSetting(result.rows[0]) ?? "";
    return normalizeTicketTableColumns(raw, { fallback: DEFAULT_TICKET_TABLE_COLUMNS })
      || [...DEFAULT_TICKET_TABLE_COLUMNS];
  } catch (err) {
    if (err?.code === "DATABASE_NOT_CONFIGURED" || err?.code === "42P01") {
      return [...DEFAULT_TICKET_TABLE_COLUMNS];
    }
    throw err;
  }
}

export async function savePublicTicketTableColumns(columns) {
  const normalized = normalizeTicketTableColumns(columns, { fallback: DEFAULT_TICKET_TABLE_COLUMNS })
    || [...DEFAULT_TICKET_TABLE_COLUMNS];
  await pool.query(
    `INSERT INTO v_b_settings (key, value, label, section)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       label = EXCLUDED.label,
       section = EXCLUDED.section`,
    [
      TICKET_TABLE_COLUMNS_PUBLIC_KEY,
      JSON.stringify(normalized),
      "Ticket table public columns",
      TICKET_TABLE_COLUMNS_SECTION
    ]
  );
  return normalized;
}

export async function loadPrivateTicketTableColumns(userId) {
  if (!userId) return null;
  const result = await pool.query(
    `SELECT setting_value
     FROM v_b_users_settings
     WHERE user_id = $1 AND setting_key = $2`,
    [userId, TICKET_TABLE_COLUMNS_PRIVATE_SETTING_KEY]
  );
  if (!result.rows.length) return null;
  const value = result.rows[0].setting_value;
  if (value == null) return null;
  // Explicit empty / null marker → treat as no private view
  if (value === null || value === "null") return null;
  const normalized = normalizeTicketTableColumns(value, { allowEmpty: false, fallback: null });
  return normalized;
}

export function resolveEffectiveTicketTableColumns({ publicColumns, privateColumns, isCommunityEdition = false }) {
  const publicNormalized = filterColumnsForEdition(
    normalizeTicketTableColumns(publicColumns, { fallback: DEFAULT_TICKET_TABLE_COLUMNS })
      || [...DEFAULT_TICKET_TABLE_COLUMNS],
    { isCommunityEdition }
  );
  const hasPrivate = Array.isArray(privateColumns) && privateColumns.length > 0;
  if (!hasPrivate) {
    return {
      public: publicNormalized,
      private: null,
      effective: publicNormalized,
      source: "public"
    };
  }
  const privateNormalized = filterColumnsForEdition(privateColumns, { isCommunityEdition });
  return {
    public: publicNormalized,
    private: privateNormalized,
    effective: privateNormalized,
    source: "private"
  };
}
