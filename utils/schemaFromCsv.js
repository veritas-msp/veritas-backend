import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REFERENCE_SCHEMA_CSV = path.join(__dirname, "..", "schema", "schema_export.csv");
const COMPOSITE_PRIMARY_KEYS = {
  v_b_client_support_credits: ["client_id"],
  v_b_client_tag_links: ["client_id", "tag_id"],
  v_b_contact_tag_links: ["contact_id", "tag_id"],
  v_b_equipment_tag_links: ["equipment_id", "tag_id"],
  v_b_rmm_client_settings: ["client_id"],
  v_b_rmm_metric_daily: ["agent_id", "day_date", "metric_id", "dim_id"],
  v_b_sales_form_profiles: ["form_id", "profile_name"],
  v_b_sales_form_teams: ["form_id", "team_id"],
  v_b_sales_form_users: ["form_id", "user_id"],
  v_b_settings: ["key"],
  v_b_ticket_assignees: ["ticket_id", "user_id"],
  v_b_ticket_tag_links: ["ticket_id", "tag_id"],
  v_b_ticket_view_profiles: ["view_id", "profile_name"],
  v_b_ticket_view_teams: ["view_id", "team_id"],
  v_b_ticket_view_users: ["view_id", "user_id"],
  v_b_ticket_watchers: ["ticket_id", "user_id"],
  v_b_users_profiles: ["name"],
  v_b_whatsapp_processed_messages: ["wa_message_id"]
};
const TABLE_UNIQUE_KEYS = {
  v_b_client_tags: ["label"],
  v_b_contract_module_options: ["module_key"],
  v_b_equipment_monitoring_alerts: ["client_id", "equipment_id", "equipment_family"]
};
const RESERVED_COLUMNS = new Set(["end"]);
function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}
function mapDataType(column) {
  const {
    data_type,
    character_maximum_length,
    numeric_precision,
    numeric_scale
  } = column;
  switch (data_type) {
    case "integer":
      return "INTEGER";
    case "bigint":
      return "BIGINT";
    case "smallint":
      return "SMALLINT";
    case "uuid":
      return "UUID";
    case "text":
      return "TEXT";
    case "boolean":
      return "BOOLEAN";
    case "jsonb":
      return "JSONB";
    case "date":
      return "DATE";
    case "character varying":
      return character_maximum_length ? `VARCHAR(${character_maximum_length})` : "VARCHAR";
    case "numeric":
      if (numeric_precision && numeric_scale != null) {
        return `NUMERIC(${numeric_precision}, ${numeric_scale})`;
      }
      return "NUMERIC";
    case "timestamp without time zone":
      return "TIMESTAMP WITHOUT TIME ZONE";
    case "timestamp with time zone":
      return "TIMESTAMPTZ";
    default:
      return data_type.toUpperCase();
  }
}
function shouldSkipDefault(defaultValue) {
  if (!defaultValue || defaultValue === "NULL") return true;
  if (defaultValue.startsWith("NULL::")) return true;
  return false;
}
function extractSequences(columns) {
  const sequences = new Set();
  const re = /nextval\('([^']+)'::regclass\)/i;
  for (const column of columns) {
    const match = re.exec(column.column_default || "");
    if (match) sequences.add(match[1]);
  }
  return [...sequences];
}
function quoteColumn(name) {
  return RESERVED_COLUMNS.has(name) ? `"${name}"` : name;
}
function uniqueIndexName(tableName, columns) {
  return `${tableName}_${columns.join("_")}_uniq`;
}
function primaryKeyColumns(tableName, columns) {
  if (COMPOSITE_PRIMARY_KEYS[tableName]) {
    return COMPOSITE_PRIMARY_KEYS[tableName];
  }
  const idColumn = columns.find(c => c.column_name === "id");
  if (idColumn && idColumn.is_nullable === "NO") {
    return ["id"];
  }
  return [];
}
export function loadReferenceSchemaTables(csvPath = REFERENCE_SCHEMA_CSV) {
  const content = fs.readFileSync(csvPath, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  const tables = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    const [, table_name, pos, column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default] = parseCsvLine(lines[i]);
    if (!tables.has(table_name)) {
      tables.set(table_name, []);
    }
    tables.get(table_name).push({
      table_name,
      ordinal_position: Number(pos),
      column_name,
      data_type,
      character_maximum_length: character_maximum_length ? Number(character_maximum_length) : null,
      numeric_precision: numeric_precision ? Number(numeric_precision) : null,
      numeric_scale: numeric_scale ? Number(numeric_scale) : null,
      is_nullable,
      column_default: column_default || null
    });
  }
  return [...tables.entries()].map(([tableName, columns]) => ({
    tableName,
    columns: columns.sort((a, b) => a.ordinal_position - b.ordinal_position)
  })).sort((a, b) => a.tableName.localeCompare(b.tableName));
}
export function buildCreateTableSql(tableName, columns) {
  const sequences = extractSequences(columns);
  const pkColumns = primaryKeyColumns(tableName, columns);
  const parts = [];
  for (const seq of sequences) {
    parts.push(`CREATE SEQUENCE IF NOT EXISTS ${seq};`);
  }
  const columnDefs = columns.map(column => {
    let def = `${quoteColumn(column.column_name)} ${mapDataType(column)}`;
    if (column.is_nullable === "NO") {
      def += " NOT NULL";
    }
    if (!shouldSkipDefault(column.column_default)) {
      def += ` DEFAULT ${column.column_default}`;
    }
    return def;
  });
  if (pkColumns.length) {
    const pk = pkColumns.map(quoteColumn).join(", ");
    columnDefs.push(`PRIMARY KEY (${pk})`);
  }
  parts.push(`CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${columnDefs.join(",\n  ")}\n);`);
  const uniqueColumns = TABLE_UNIQUE_KEYS[tableName];
  if (uniqueColumns?.length) {
    const uniqueCols = uniqueColumns.map(quoteColumn).join(", ");
    parts.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${uniqueIndexName(tableName, uniqueColumns)} ON ${tableName} (${uniqueCols});`);
  }
  return parts.join("\n\n");
}
export const REFERENCE_SCHEMA_SEEDS_SQL = `
ALTER TABLE v_b_users_profiles
  ADD COLUMN IF NOT EXISTS documents_enabled BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO v_b_users_profiles (
  name, label,
  monitoring_enabled, infrastructure_enabled, cybersecurite_enabled,
  planning_enabled, service_enabled, contrat_enabled, contact_enabled,
  configurateur_enabled, tickets_enabled, dashboard_enabled, documents_enabled, display_order
) VALUES
  ('Super Admin', 'Accès total non modifiable — propriétaire de l''instance.', true, true, true, true, true, true, true, true, true, true, true, 1),
  ('Administrator', 'Full access to all modules and administrative actions.', true, true, true, true, true, true, true, true, true, true, true, 10),
  ('Supervisor', 'Oversees activities, manages teams, and accesses advanced monitoring features.', true, true, true, true, true, true, true, false, true, true, true, 20),
  ('Agent', 'Handles requests daily, manages operations, and works on customer cases.', true, true, true, true, true, true, true, false, true, false, true, 30),
  ('Collaborator', 'Restricted operational access to contribute to tasks without administrative privileges.', true, true, true, true, true, true, true, false, false, false, true, 40),
  ('Read-only', 'View-only access, without data changes or sensitive actions.', true, true, true, false, true, true, true, false, false, false, false, 50)
ON CONFLICT (name) DO NOTHING;

INSERT INTO v_b_settings_system (id, maintenance_mode, maintenance_message, ticker_color, ticker_speed, ticker_direction)
VALUES (1, false, 'The application is currently under maintenance. Please try again later.', '#d97706', 22, 'left')
ON CONFLICT (id) DO NOTHING;

INSERT INTO v_b_dashboard_reports_config (id, reports) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_comment_templates_config (id, data) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_macros_config (id, data) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_email_inboxes_config (id, data) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_exclusion_rules_config (id, data) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_auto_reply_rules_config (id, data) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_auto_reply_template_config (id, data) VALUES (1, '""'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_scheduled_alert_rules_config (id, data) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_chat_ui_settings_config (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_ticket_mail_collectors_config (id, data) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_notification_events_config (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_notification_webhooks_config (id, data) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO v_b_notification_templates_config (id, data) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING;

INSERT INTO v_b_settings (key, value, label, section)
VALUES
  ('app_default_locale', 'fr', 'Default language', 'general'),
  ('app_timezone', 'Europe/Paris', 'Time zone', 'general'),
  ('app_date_format', 'dd/mm/yyyy', 'Date format', 'general'),
  ('app_organization_name', 'Veritas', 'Organization name', 'general'),
  ('app_default_theme', 'light', 'Default theme', 'general'),
  ('app_default_page_size', '50', 'Items per page (default)', 'general'),
  ('app_support_email', '', 'Support contact email', 'general'),
  ('app_support_phone', '', 'Support phone', 'general'),
  ('app_organization_address', '', 'Organization address', 'general'),
  ('app_organization_website', '', 'Organization website', 'general'),
  ('app_organization_employee_range', '', 'Organization headcount', 'general'),
  ('app_knowledge_base_url', '', 'URL Knowledge Base', 'general')
ON CONFLICT (key) DO NOTHING;

INSERT INTO v_b_settings (key, value, label, section)
VALUES
  ('app_login_agent_enabled', 'false', 'Agent login — enabled', 'login'),
  ('app_login_agent_headline_line1', '', 'Agent login — headline line 1', 'login'),
  ('app_login_agent_headline_line2', '', 'Agent login — headline line 2', 'login'),
  ('app_login_agent_sub', '', 'Agent login — subtitle', 'login'),
  ('app_login_agent_features', '[]', 'Agent login — highlights', 'login'),
  ('app_login_agent_brand_name', '', 'Agent login — displayed name', 'login'),
  ('app_login_agent_logo_path', '', 'Agent login — logo', 'login'),
  ('app_login_agent_bg_image_path', '', 'Agent login — background image', 'login'),
  ('app_login_agent_bg_color_start', '', 'Agent login — background start color', 'login'),
  ('app_login_agent_bg_color_end', '', 'Agent login — background end color', 'login'),
  ('app_login_agent_accent_color', '', 'Agent login — accent color', 'login'),
  ('app_login_agent_right_bg_color', '', 'Agent login — right panel background', 'login'),
  ('app_login_agent_footer_text', '', 'Agent login — footer', 'login'),
  ('app_login_client_enabled', 'false', 'Client login — enabled', 'login'),
  ('app_login_client_headline_line1', '', 'Client login — headline line 1', 'login'),
  ('app_login_client_headline_line2', '', 'Client login — headline line 2', 'login'),
  ('app_login_client_sub', '', 'Client login — subtitle', 'login'),
  ('app_login_client_features', '[]', 'Client login — highlights', 'login'),
  ('app_login_client_brand_name', '', 'Client login — displayed name', 'login'),
  ('app_login_client_logo_path', '', 'Client login — logo', 'login'),
  ('app_login_client_bg_image_path', '', 'Client login — background image', 'login'),
  ('app_login_client_bg_color_start', '', 'Client login — background start color', 'login'),
  ('app_login_client_bg_color_end', '', 'Client login — background end color', 'login'),
  ('app_login_client_accent_color', '', 'Client login — accent color', 'login'),
  ('app_login_client_right_bg_color', '', 'Client login — right panel background', 'login'),
  ('app_login_client_footer_text', '', 'Client login — footer', 'login')
ON CONFLICT (key) DO NOTHING;

INSERT INTO v_b_contract_module_options (module_key, label, icon, enabled, sort_order)
VALUES
  ('Support', 'Support', 'mdi:headset', true, 10),
  ('Curatif', 'Curatif', 'tabler:truck-filled', true, 20),
  ('Preventif', 'Preventive', 'fluent-mdl2:documentation', true, 30),
  ('Monitoring', 'Monitoring', 'eos-icons:monitoring', true, 40),
  ('Hebergement', 'Hosting', 'carbon:data-center', true, 50)
ON CONFLICT (module_key) DO NOTHING;
`;
export const REFERENCE_SCHEMA_BOOTSTRAP_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS v_b_schema_migrations (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(512) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v_b_reference_schema_progress (
  table_name VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
export const REFERENCE_SCHEMA_MARKER = "reference_schema_export_v1";
export const REFERENCE_SEEDS_MARKER = "reference_schema_seeds_v1";
