import { pool } from "../database/db.js";
import { encrypt, decrypt } from "../utils/encryption.js";
import { resolveFileUploadedBy } from "../utils/fileUploadedBy.js";
import { ensureClientVaultSecretsSchema, hasClientVaultSecretsTable } from "./ensureClientVaultSecretsSchema.js";

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_SECRET_LENGTH = 4000;
const MAX_LOGIN_LENGTH = 320;
const MIN_EXPIRES_DAYS = 1;
const MAX_EXPIRES_DAYS = 90;
const MIN_MAX_VIEWS = 1;
const MAX_MAX_VIEWS = 100;

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function resolveVaultSecretAvailability(row, now = new Date()) {
  if (!row) return "missing";
  if (row.status === "revoked") return "revoked";
  if (row.deletion_requested_at) return "deletion_requested";
  const expiresAt = new Date(row.expires_at);
  if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= now) return "expired";
  if (Number(row.view_count) >= Number(row.max_views)) return "exhausted";
  return "active";
}

function mapAgentVaultSecret(row) {
  const availability = resolveVaultSecretAvailability(row);
  const viewsRemaining = Math.max(Number(row.max_views) - Number(row.view_count), 0);
  return {
    id: row.id,
    client_id: row.client_id,
    contact_id: row.contact_id,
    title: row.title,
    description: row.description || "",
    expires_at: row.expires_at,
    max_views: row.max_views,
    view_count: row.view_count,
    views_remaining: viewsRemaining,
    availability,
    status: row.status,
    deletion_requested_at: row.deletion_requested_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapPortalVaultSecret(row) {
  const availability = resolveVaultSecretAvailability(row);
  const viewsRemaining = Math.max(Number(row.max_views) - Number(row.view_count), 0);
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    expires_at: row.expires_at,
    max_views: row.max_views,
    view_count: row.view_count,
    views_remaining: viewsRemaining,
    availability,
    created_at: row.created_at,
  };
}

function encryptSecretPayload({ login, secret }) {
  const payload = JSON.stringify({
    login: login || "",
    secret: secret || "",
  });
  const encrypted = encrypt(payload);
  if (!encrypted) throw new Error("Impossible de chiffrer le secret.");
  return encrypted;
}

function decryptSecretPayload(row) {
  const decrypted = decrypt(row.secret_encrypted, row.secret_iv, row.secret_auth_tag);
  if (!decrypted) throw new Error("Impossible de déchiffrer le secret.");
  try {
    const parsed = JSON.parse(decrypted);
    return {
      login: String(parsed.login || "").trim() || null,
      secret: String(parsed.secret || "").trim(),
    };
  } catch {
    return { login: null, secret: decrypted };
  }
}

async function assertContactForClient(contactId, clientId) {
  const normalizedContactId = Number(contactId);
  const normalizedClientId = Number(clientId);
  if (!normalizedContactId) throw new Error("Contact requis.");
  if (!normalizedClientId) throw new Error("Entreprise requise.");

  const { rows } = await pool.query(
    `SELECT id, client_id
     FROM v_b_contacts
     WHERE id = $1
     LIMIT 1`,
    [normalizedContactId]
  );

  const contact = rows[0];
  if (!contact) throw new Error("Contact introuvable.");
  if (Number(contact.client_id) !== normalizedClientId) {
    throw new Error("Ce contact n'appartient pas à l'entreprise indiquée.");
  }

  return contact;
}

export async function listAgentVaultSecrets(contactId) {
  if (!(await hasClientVaultSecretsTable())) return [];

  const { rows } = await pool.query(
    `SELECT id, client_id, contact_id, title, description, expires_at, max_views, view_count,
            status, deletion_requested_at, created_at, updated_at
     FROM v_b_client_vault_secrets
     WHERE contact_id = $1
     ORDER BY created_at DESC`,
    [Number(contactId)]
  );

  return rows.map(mapAgentVaultSecret);
}

export async function createAgentVaultSecret({
  clientId,
  contactId,
  title,
  description = "",
  login = "",
  secret,
  expiresInDays = 7,
  maxViews = 5,
  createdBy,
}) {
  if (!(await hasClientVaultSecretsTable())) {
    throw new Error("Fonctionnalité indisponible — migration en cours.");
  }

  await assertContactForClient(contactId, clientId);

  const normalizedTitle = String(title || "").trim();
  const normalizedSecret = String(secret || "").trim();
  const normalizedDescription = String(description || "").trim();
  const normalizedLogin = String(login || "").trim();

  if (!normalizedTitle) throw new Error("Titre requis.");
  if (normalizedTitle.length > MAX_TITLE_LENGTH) {
    throw new Error(`Titre trop long (${MAX_TITLE_LENGTH} caractères max).`);
  }
  if (!normalizedSecret) throw new Error("Mot de passe / secret requis.");
  if (normalizedSecret.length > MAX_SECRET_LENGTH) {
    throw new Error(`Secret trop long (${MAX_SECRET_LENGTH} caractères max).`);
  }
  if (normalizedDescription.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Description trop longue (${MAX_DESCRIPTION_LENGTH} caractères max).`);
  }
  if (normalizedLogin.length > MAX_LOGIN_LENGTH) {
    throw new Error(`Identifiant trop long (${MAX_LOGIN_LENGTH} caractères max).`);
  }

  const days = clampInt(expiresInDays, MIN_EXPIRES_DAYS, MAX_EXPIRES_DAYS, 7);
  const views = clampInt(maxViews, MIN_MAX_VIEWS, MAX_MAX_VIEWS, 5);
  const encrypted = encryptSecretPayload({ login: normalizedLogin, secret: normalizedSecret });

  const { rows } = await pool.query(
    `INSERT INTO v_b_client_vault_secrets (
       client_id, contact_id, title, description,
       secret_encrypted, secret_iv, secret_auth_tag,
       expires_at, max_views, created_by
     )
     VALUES (
       $1, $2, $3, $4,
       $5, $6, $7,
       NOW() + ($8::int * INTERVAL '1 day'), $9, $10
     )
     RETURNING id, client_id, contact_id, title, description, expires_at, max_views, view_count,
               status, deletion_requested_at, created_at, updated_at`,
    [
      Number(clientId),
      Number(contactId),
      normalizedTitle,
      normalizedDescription || null,
      encrypted.encrypted,
      encrypted.iv,
      encrypted.authTag,
      days,
      views,
      resolveFileUploadedBy(createdBy),
    ]
  );

  return mapAgentVaultSecret(rows[0]);
}

export async function revokeAgentVaultSecret(secretId, revokedBy) {
  if (!(await hasClientVaultSecretsTable())) {
    throw new Error("Fonctionnalité indisponible.");
  }

  const { rows } = await pool.query(
    `UPDATE v_b_client_vault_secrets
     SET status = 'revoked',
         revoked_at = NOW(),
         revoked_by = $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, client_id, contact_id, title, description, expires_at, max_views, view_count,
               status, deletion_requested_at, created_at, updated_at`,
    [secretId, resolveFileUploadedBy(revokedBy)]
  );

  if (!rows.length) throw new Error("Accès introuvable.");
  return mapAgentVaultSecret(rows[0]);
}

export async function listPortalVaultSecrets(contactId) {
  if (!(await hasClientVaultSecretsTable())) return [];
  if (!contactId) return [];

  const { rows } = await pool.query(
    `SELECT id, title, description, expires_at, max_views, view_count,
            status, deletion_requested_at, created_at
     FROM v_b_client_vault_secrets
     WHERE contact_id = $1
       AND status = 'active'
       AND deletion_requested_at IS NULL
       AND expires_at > NOW()
       AND view_count < max_views
     ORDER BY created_at DESC`,
    [Number(contactId)]
  );

  return rows.map(mapPortalVaultSecret);
}

export async function countPortalVaultSecrets(contactId) {
  if (!(await hasClientVaultSecretsTable())) return 0;
  if (!contactId) return 0;

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM v_b_client_vault_secrets
     WHERE contact_id = $1
       AND status = 'active'
       AND deletion_requested_at IS NULL
       AND expires_at > NOW()
       AND view_count < max_views`,
    [Number(contactId)]
  );
  return rows[0]?.total || 0;
}

export async function revealPortalVaultSecret(contactId, secretId) {
  if (!(await hasClientVaultSecretsTable())) {
    throw new Error("Fonctionnalité indisponible.");
  }
  if (!contactId) {
    const err = new Error("Accès introuvable.");
    err.code = "NOT_FOUND";
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT *
       FROM v_b_client_vault_secrets
       WHERE id = $1 AND contact_id = $2
       FOR UPDATE`,
      [secretId, Number(contactId)]
    );

    const row = locked.rows[0];
    if (!row) {
      const err = new Error("Accès introuvable.");
      err.code = "NOT_FOUND";
      throw err;
    }

    const availability = resolveVaultSecretAvailability(row);
    if (availability !== "active") {
      const err = new Error("Cet accès n'est plus disponible.");
      err.code = availability.toUpperCase();
      throw err;
    }

    const payload = decryptSecretPayload(row);

    await client.query(
      `UPDATE v_b_client_vault_secrets
       SET view_count = view_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [secretId]
    );

    await client.query("COMMIT");

    const viewsRemaining = Math.max(Number(row.max_views) - Number(row.view_count) - 1, 0);

    return {
      id: row.id,
      title: row.title,
      description: row.description || "",
      login: payload.login,
      secret: payload.secret,
      expires_at: row.expires_at,
      views_remaining: viewsRemaining,
      view_count: Number(row.view_count) + 1,
      max_views: row.max_views,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function requestPortalVaultSecretRevocation(contactId, secretId, portalUserId) {
  if (!(await hasClientVaultSecretsTable())) {
    throw new Error("Fonctionnalité indisponible.");
  }
  if (!contactId) throw new Error("Accès introuvable ou déjà supprimé.");

  const { rows } = await pool.query(
    `UPDATE v_b_client_vault_secrets
     SET status = 'revoked',
         deletion_requested_at = NOW(),
         deletion_requested_by = $3,
         revoked_at = NOW(),
         revoked_by = $3,
         updated_at = NOW()
     WHERE id = $1 AND contact_id = $2 AND status = 'active'
     RETURNING id, title`,
    [secretId, Number(contactId), portalUserId || null]
  );

  if (!rows.length) throw new Error("Accès introuvable ou déjà supprimé.");
  return { id: rows[0].id, title: rows[0].title };
}
