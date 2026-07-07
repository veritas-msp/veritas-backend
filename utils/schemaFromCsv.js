import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REFERENCE_SCHEMA_CSV = path.join(
  __dirname,
  "..",
  "schema",
  "schema_export.csv"
);

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
  v_b_whatsapp_processed_messages: ["wa_message_id"],
};

/** Unique constraints absent du CSV (index créés après CREATE TABLE). */
const TABLE_UNIQUE_KEYS = {
  v_b_client_tags: ["label"],
  v_b_contract_module_options: ["module_key"],
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
  const { data_type, character_maximum_length, numeric_precision, numeric_scale } = column;

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
      return character_maximum_length
        ? `VARCHAR(${character_maximum_length})`
        : "VARCHAR";
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

  const idColumn = columns.find((c) => c.column_name === "id");
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
    const [
      ,
      table_name,
      pos,
      column_name,
      data_type,
      character_maximum_length,
      numeric_precision,
      numeric_scale,
      is_nullable,
      column_default,
    ] = parseCsvLine(lines[i]);

    if (!tables.has(table_name)) {
      tables.set(table_name, []);
    }

    tables.get(table_name).push({
      table_name,
      ordinal_position: Number(pos),
      column_name,
      data_type,
      character_maximum_length: character_maximum_length
        ? Number(character_maximum_length)
        : null,
      numeric_precision: numeric_precision ? Number(numeric_precision) : null,
      numeric_scale: numeric_scale ? Number(numeric_scale) : null,
      is_nullable,
      column_default: column_default || null,
    });
  }

  return [...tables.entries()]
    .map(([tableName, columns]) => ({
      tableName,
      columns: columns.sort((a, b) => a.ordinal_position - b.ordinal_position),
    }))
    .sort((a, b) => a.tableName.localeCompare(b.tableName));
}

export function buildCreateTableSql(tableName, columns) {
  const sequences = extractSequences(columns);
  const pkColumns = primaryKeyColumns(tableName, columns);
  const parts = [];

  for (const seq of sequences) {
    parts.push(`CREATE SEQUENCE IF NOT EXISTS ${seq};`);
  }

  const columnDefs = columns.map((column) => {
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

  parts.push(
    `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${columnDefs.join(",\n  ")}\n);`
  );

  const uniqueColumns = TABLE_UNIQUE_KEYS[tableName];
  if (uniqueColumns?.length) {
    const uniqueCols = uniqueColumns.map(quoteColumn).join(", ");
    parts.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${uniqueIndexName(tableName, uniqueColumns)} ON ${tableName} (${uniqueCols});`
    );
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
  ('Administrateur', 'Accès complet à tous les modules et à toutes les actions d''administration.', true, true, true, true, true, true, true, true, true, true, true, 10),
  ('Superviseur', 'Supervise les activités, pilote les équipes et accède aux fonctions de suivi avancées.', true, true, true, true, true, true, true, false, true, true, true, 20),
  ('Agent', 'Traite les demandes au quotidien, gère les opérations et intervient sur les dossiers clients.', true, true, true, true, true, true, true, false, true, false, true, 30),
  ('Collaborateur', 'Accès opérationnel restreint pour contribuer aux tâches sans droits administratifs.', true, true, true, true, true, true, true, false, false, false, true, 40),
  ('Lecture', 'Consultation uniquement, sans modification des données ni actions sensibles.', true, true, true, false, true, true, true, false, false, false, false, 50)
ON CONFLICT (name) DO NOTHING;

INSERT INTO v_b_settings_system (id, maintenance_mode, maintenance_message, ticker_color, ticker_speed, ticker_direction)
VALUES (1, false, 'L''application est actuellement en maintenance. Veuillez réessayer plus tard.', '#d97706', 22, 'left')
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
  ('app_default_locale', 'fr', 'Langue par défaut', 'general'),
  ('app_timezone', 'Europe/Paris', 'Fuseau horaire', 'general'),
  ('app_date_format', 'dd/mm/yyyy', 'Format de date', 'general'),
  ('app_organization_name', 'Veritas', 'Nom de l''organisation', 'general'),
  ('app_default_theme', 'light', 'Thème par défaut', 'general'),
  ('app_default_page_size', '50', 'Éléments par page (défaut)', 'general'),
  ('app_support_email', '', 'E-mail de contact support', 'general'),
  ('app_support_phone', '', 'Téléphone support', 'general'),
  ('app_organization_address', '', 'Adresse de l''organisation', 'general'),
  ('app_organization_website', '', 'Site web de l''organisation', 'general'),
  ('app_organization_employee_range', '', 'Effectif de l''organisation', 'general'),
  ('app_knowledge_base_url', '', 'URL Knowledge Base', 'general')
ON CONFLICT (key) DO NOTHING;

INSERT INTO v_b_settings (key, value, label, section)
VALUES
  ('app_login_agent_enabled', 'false', 'Login agent — activé', 'login'),
  ('app_login_agent_headline_line1', '', 'Login agent — titre ligne 1', 'login'),
  ('app_login_agent_headline_line2', '', 'Login agent — titre ligne 2', 'login'),
  ('app_login_agent_sub', '', 'Login agent — sous-titre', 'login'),
  ('app_login_agent_features', '[]', 'Login agent — points forts', 'login'),
  ('app_login_agent_brand_name', '', 'Login agent — nom affiché', 'login'),
  ('app_login_agent_logo_path', '', 'Login agent — logo', 'login'),
  ('app_login_agent_bg_image_path', '', 'Login agent — image de fond', 'login'),
  ('app_login_agent_bg_color_start', '', 'Login agent — couleur fond début', 'login'),
  ('app_login_agent_bg_color_end', '', 'Login agent — couleur fond fin', 'login'),
  ('app_login_agent_accent_color', '', 'Login agent — couleur accent', 'login'),
  ('app_login_agent_right_bg_color', '', 'Login agent — fond panneau droit', 'login'),
  ('app_login_agent_footer_text', '', 'Login agent — pied de page', 'login'),
  ('app_login_client_enabled', 'false', 'Login client — activé', 'login'),
  ('app_login_client_headline_line1', '', 'Login client — titre ligne 1', 'login'),
  ('app_login_client_headline_line2', '', 'Login client — titre ligne 2', 'login'),
  ('app_login_client_sub', '', 'Login client — sous-titre', 'login'),
  ('app_login_client_features', '[]', 'Login client — points forts', 'login'),
  ('app_login_client_brand_name', '', 'Login client — nom affiché', 'login'),
  ('app_login_client_logo_path', '', 'Login client — logo', 'login'),
  ('app_login_client_bg_image_path', '', 'Login client — image de fond', 'login'),
  ('app_login_client_bg_color_start', '', 'Login client — couleur fond début', 'login'),
  ('app_login_client_bg_color_end', '', 'Login client — couleur fond fin', 'login'),
  ('app_login_client_accent_color', '', 'Login client — couleur accent', 'login'),
  ('app_login_client_right_bg_color', '', 'Login client — fond panneau droit', 'login'),
  ('app_login_client_footer_text', '', 'Login client — pied de page', 'login')
ON CONFLICT (key) DO NOTHING;

INSERT INTO v_b_contract_module_options (module_key, label, icon, enabled, sort_order)
VALUES
  ('Support', 'Support', 'mdi:headset', true, 10),
  ('Curatif', 'Curatif', 'tabler:truck-filled', true, 20),
  ('Preventif', 'Préventif', 'fluent-mdl2:documentation', true, 30),
  ('Monitoring', 'Monitoring', 'eos-icons:monitoring', true, 40),
  ('Hebergement', 'Hébergement', 'carbon:data-center', true, 50)
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
