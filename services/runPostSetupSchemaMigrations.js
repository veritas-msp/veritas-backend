import { ensureProfilesSchema } from "./ensureProfilesSchema.js";
import { ensureTeamsSchema } from "./ensureTeamsSchema.js";
import { ensureSslSchema } from "./ensureSslSchema.js";
import { ensureTicketViewsSchema } from "./ensureTicketViewsSchema.js";
import { ensureTicketTrashSchema } from "./ensureTicketTrashSchema.js";
import { ensureUserNotificationsSchema } from "./ensureUserNotificationsSchema.js";
import { ensureTicketEmailThreadSchema } from "./ensureTicketEmailThreadSchema.js";
import { ensureTicketCommentUpdatedAtSchema } from "./ensureTicketCommentUpdatedAtSchema.js";
import { ensureMailCollectSettingsSchema } from "./ensureMailCollectSettingsSchema.js";
import { ensureIntegrationTenantsSchema } from "./ensureIntegrationTenantsSchema.js";
import { ensureClientVaultSecretsSchema } from "./ensureClientVaultSecretsSchema.js";
import { ensureTicketMajorIncidentSchema } from "./ensureTicketMajorIncidentSchema.js";
import { runIncrementalAvrilMigrations } from "../utils/incrementalAvrilMigrations.js";

/** Migrations incrémentielles (Avril/) — après installation complète uniquement. */
export async function runPostSetupSchemaMigrations() {
  await ensureProfilesSchema();
  await ensureTeamsSchema();
  await ensureSslSchema();
  await ensureTicketViewsSchema();
  await ensureTicketTrashSchema();
  await ensureUserNotificationsSchema();
  await ensureTicketEmailThreadSchema();
  await ensureTicketCommentUpdatedAtSchema();
  await ensureMailCollectSettingsSchema();
  await ensureIntegrationTenantsSchema();
  await ensureClientVaultSecretsSchema();
  await ensureTicketMajorIncidentSchema();
  try {
    await runIncrementalAvrilMigrations();
  } catch (err) {
    console.error("[post-setup] Incremental migrations failed:", err.message);
  }
}
