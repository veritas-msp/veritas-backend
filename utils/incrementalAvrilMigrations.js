import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { adaptMigrationSql } from "./migrationSql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCHES_DIR = path.join(__dirname, "..", "schema", "patches");

async function tableExists(client, name) {
  const { rows } = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${name}`]);
  return Boolean(rows[0]?.reg);
}

async function columnExists(client, table, column) {
  const { rows } = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function columnHasDataType(client, table, column, dataType) {
  const { rows } = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 AND data_type = $3
     LIMIT 1`,
    [table, column, dataType]
  );
  return rows.length > 0;
}

async function indexExists(client, table, indexName) {
  const { rows } = await client.query(
    `SELECT 1
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = $1 AND indexname = $2
     LIMIT 1`,
    [table, indexName]
  );
  return rows.length > 0;
}

/** Plan des patches SQL manquants après installation du schéma de référence. */
export async function buildIncrementalAvrilMigrationPlan(client = pool) {
  const plan = [];

  if (!(await tableExists(client, "v_b_client_tags"))) {
    plan.push("20260616_client_tags_notes.sql", "20260616_client_tags_notes_grants.sql");
  }
  if (!(await tableExists(client, "v_b_contact_tag_links"))) {
    plan.push("20260618_contact_tag_links_fix.sql");
  }
  if (!(await tableExists(client, "v_b_rmm_enrollment_tokens"))) {
    plan.push(
      "20260617_rmm_ordinateurs.sql",
      "20260617_rmm_ordinateurs_grants.sql",
      "20260617_rmm_ordinateurs_unique_fix.sql"
    );
  } else if (!(await columnExists(client, "v_b_rmm_enrollment_tokens", "token_encrypted"))) {
    plan.push("20260618_rmm_token_encrypted.sql");
  }
  if (!(await tableExists(client, "v_b_clients_m_alimentation"))) {
    plan.push("20260618_alimentation_routeur_toip.sql");
  }
  if (!(await columnExists(client, "v_b_clients", "client_number"))) {
    plan.push("20260619_clients_client_number.sql");
  }
  if (!(await tableExists(client, "v_b_client_support_credits"))) {
    plan.push("20260620_client_support_credits.sql", "20260620_client_support_credits_grants.sql");
  }
  if (!(await tableExists(client, "v_b_client_support_credit_packs"))) {
    plan.push("20260620_client_support_credit_packs.sql");
  }
  if (!(await tableExists(client, "v_b_clients_m_licences"))) {
    plan.push("20260621_client_licences_abonnements.sql");
  }
  if (!(await tableExists(client, "v_b_sales_form_definitions"))) {
    plan.push("20260618_sales_form_definitions.sql");
  }

  const hasSalesForms = await tableExists(client, "v_b_sales_form_definitions");
  const willCreateSalesForms = plan.includes("20260618_sales_form_definitions.sql");
  if (hasSalesForms || willCreateSalesForms) {
    if (!hasSalesForms || !(await columnExists(client, "v_b_sales_form_definitions", "visibility"))) {
      plan.push("20260626_sales_form_visibility.sql");
    }
    if (!hasSalesForms || !(await columnExists(client, "v_b_sales_form_definitions", "ticket_targets"))) {
      plan.push("20260627_sales_form_ticket_targets.sql");
    }
    if (!hasSalesForms || !(await columnExists(client, "v_b_sales_form_fields", "visibility_rules"))) {
      plan.push("20260628_sales_form_field_visibility.sql");
    }
  }

  if (!(await tableExists(client, "v_b_equipment_family_definitions"))) {
    plan.push("20260629_equipment_family_definitions.sql");
  }
  if (!(await tableExists(client, "v_b_equipment_monitoring_alerts"))) {
    plan.push("20260630_equipment_monitoring_alerts.sql");
  }
  if (!(await tableExists(client, "v_b_rmm_client_settings"))) {
    plan.push("20260701_rmm_client_settings.sql");
  }
  if (await tableExists(client, "v_b_contacts")) {
    if (!(await columnExists(client, "v_b_contacts", "sexe"))) {
      plan.push("20260701_contact_sexe.sql");
    }
    if (!(await columnExists(client, "v_b_contacts", "communications"))) {
      plan.push("20260702_contact_communications.sql");
    }
  }
  if (
    (await tableExists(client, "v_b_equipment_monitoring_alerts")) &&
    !(await columnExists(client, "v_b_equipment_monitoring_alerts", "alerts_enabled"))
  ) {
    plan.push("20260702_equipment_monitoring_alerts_enabled.sql");
  }
  if (await tableExists(client, "v_b_tickets") && !(await columnExists(client, "v_b_tickets", "equipment_info"))) {
    plan.push("20260622_ticket_equipment_info.sql");
  }
  if (await tableExists(client, "v_b_tickets") && !(await columnExists(client, "v_b_tickets", "is_major_incident"))) {
    plan.push("20260621_ticket_major_incident_contact_slots.sql");
  }
  if (!(await tableExists(client, "v_b_whatsapp_conversations"))) {
    plan.push("20260703_whatsapp_integration.sql");
  }
  if (!(await tableExists(client, "v_b_ticket_email_messages"))) {
    plan.push("20260723_ticket_email_thread.sql");
  }
  if (!(await tableExists(client, "v_b_ticket_mail_collect_settings_config"))) {
    plan.push("20260724_mail_collect_settings.sql");
  }
  if (!(await tableExists(client, "v_b_equipment_files"))) {
    plan.push("20260624_equipment_files.sql");
  }
  if (
    (await tableExists(client, "v_b_equipment_files")) &&
    (await columnHasDataType(client, "v_b_equipment_files", "uploaded_by", "bigint"))
  ) {
    plan.push("20260725_files_uploaded_by_uuid.sql");
  } else if (
    (await tableExists(client, "v_b_client_files")) &&
    (await columnHasDataType(client, "v_b_client_files", "uploaded_by", "bigint"))
  ) {
    plan.push("20260725_files_uploaded_by_uuid.sql");
  }
  if (!(await tableExists(client, "v_b_supervision_alert_rules_config"))) {
    plan.push("20260623_supervision_alert_rules_config.sql");
  }
  if (!(await tableExists(client, "v_b_equipment_tag_links"))) {
    plan.push("20260726_equipment_tag_links.sql", "20260726_equipment_tag_links_grants.sql");
  }
  if (!(await tableExists(client, "v_b_rmm_metric_daily"))) {
    plan.push("20260727_rmm_metric_daily.sql", "20260727_rmm_metric_daily_grants.sql");
  }

  if (
    (await tableExists(client, "v_b_client_files")) &&
    !(await columnExists(client, "v_b_client_files", "visible_to_client"))
  ) {
    plan.push("20260627_client_files_vault_visibility.sql");
  }

  if (!(await tableExists(client, "v_b_client_vault_secrets"))) {
    plan.push("20260728_client_vault_secrets.sql", "20260728_client_vault_secrets_grants.sql");
  }

  if (
    (await tableExists(client, "v_b_users_profiles")) &&
    !(await columnExists(client, "v_b_users_profiles", "parent_profile"))
  ) {
    plan.push("20260618_profiles_inheritance_ticket_view_profiles.sql");
  }

  if (
    (await tableExists(client, "v_b_client_vault_secrets")) &&
    !(await columnExists(client, "v_b_client_vault_secrets", "contact_id"))
  ) {
    plan.push("20260729_client_vault_secrets_contact_id.sql");
  }

  if (
    (await tableExists(client, "v_b_users_profiles")) &&
    !(await columnExists(client, "v_b_users_profiles", "documents_enabled"))
  ) {
    plan.push("20260730_profiles_documents_enabled.sql");
  }

  if (!(await tableExists(client, "v_b_ticket_satisfaction"))) {
    plan.push("20260627_ticket_satisfaction.sql");
  }
  if (!(await tableExists(client, "v_b_ticket_resolution_validations"))) {
    plan.push("20260627_ticket_resolution_validation.sql");
  }
  if (
    (await tableExists(client, "v_b_ticket_satisfaction")) &&
    !(await columnExists(client, "v_b_ticket_satisfaction", "ratings"))
  ) {
    plan.push("20260627_ticket_satisfaction_criteria.sql");
  }
  if (
    (await tableExists(client, "v_b_ticket_tags")) &&
    !(await indexExists(client, "v_b_ticket_tags", "idx_v_b_ticket_tags_label_unique"))
  ) {
    plan.push("20260707_ticket_tags_label_unique.sql");
  }
  if (
    (await tableExists(client, "v_b_client_tags")) &&
    !(await indexExists(client, "v_b_client_tags", "v_b_client_tags_label_uniq")) &&
    !(await indexExists(client, "v_b_client_tags", "idx_v_b_client_tags_label_unique"))
  ) {
    plan.push("20260709_client_tags_label_unique.sql");
  }
  if (
    (await tableExists(client, "v_b_users_settings")) &&
    !(await indexExists(client, "v_b_users_settings", "idx_v_b_users_settings_user_key"))
  ) {
    plan.push("20260705_users_settings_unique.sql");
  }
  if (
    (await tableExists(client, "v_b_events")) &&
    !(await columnExists(client, "v_b_events", "ticket_id"))
  ) {
    plan.push("20260708_events_ticket_reminder.sql");
  }

  return [...new Set(plan)];
}

export const INCREMENTAL_TABLE_CHECKS = [
  "v_b_client_tags",
  "v_b_client_tag_links",
  "v_b_contact_tag_links",
  "v_b_rmm_enrollment_tokens",
  "v_b_rmm_agents",
  "v_b_clients_m_ordinateurs",
  "v_b_clients_m_alimentation",
  "v_b_clients_m_routeur",
  "v_b_clients_m_toip",
  "v_b_client_support_credits",
  "v_b_client_support_credit_ledger",
  "v_b_client_support_credit_packs",
  "v_b_clients_m_licences",
  "v_b_sales_form_definitions",
  "v_b_sales_form_fields",
  "v_b_equipment_family_definitions",
  "v_b_equipment_monitoring_alerts",
  "v_b_supervision_alert_rules_config",
  "v_b_equipment_files",
  "v_b_equipment_tag_links",
  "v_b_rmm_client_settings",
  "v_b_rmm_metric_daily",
  "v_b_teams",
  "v_b_ticket_views",
  "v_b_user_notifications",
];

export async function verifyIncrementalTables(client = pool) {
  const missing = [];
  for (const table of INCREMENTAL_TABLE_CHECKS) {
    if (!(await tableExists(client, table))) missing.push(table);
  }
  return missing;
}

async function runMigrationFile(client, file, dbUser) {
  const filePath = path.join(PATCHES_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.warn(`[incremental] File not found: ${file}`);
    return false;
  }
  const sql = adaptMigrationSql(fs.readFileSync(filePath, "utf8"), dbUser);
  console.log(`[incremental] Applying ${file}…`);
  await client.query(sql);
  console.log(`[incremental] OK ${file}`);
  return true;
}

/** Applique les patches schema/patches post-installation (RMM, tags, formulaires, etc.). */
export async function runIncrementalAvrilMigrations() {
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    const userResult = await client.query("SELECT current_user");
    const dbUser = userResult.rows[0]?.current_user || "postgres";

    const plan = await buildIncrementalAvrilMigrationPlan(client);
    if (plan.length === 0) {
      return { executed: [], missing: await verifyIncrementalTables(client) };
    }

    const executed = [];
    for (const file of plan) {
      if (await runMigrationFile(client, file, dbUser)) {
        executed.push(file);
      }
    }

    const missing = await verifyIncrementalTables(client);
    if (missing.length > 0) {
      console.warn("[incremental] Tables still missing:", missing.join(", "));
    } else {
      console.log("[incremental] Incremental schema complete.");
    }

    return { executed, missing };
  } catch (err) {
    console.error("[incremental] Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
  }
}
