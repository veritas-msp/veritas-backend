import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { pool } from "../database/db.js";
import { sendPortalInviteEmail } from "./portalInvite.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function buildPortalUsername(contact) {
  const parts = [contact.prenom, contact.nom].filter(Boolean).map((s) => String(s).trim());
  if (parts.length) return parts.join(" ").slice(0, 50);
  const email = String(contact.email || "").split("@")[0];
  return email.slice(0, 50) || "Contact";
}

export async function getPortalUserByContactId(contactId) {
  const { rows } = await pool.query(
    `SELECT id, email, username, role, client_id, contact_id, is_active,
            last_login_at, created_at, COALESCE(password_pending, false) AS password_pending
     FROM v_b_users
     WHERE contact_id = $1 AND role = 'client'
     LIMIT 1`,
    [contactId]
  );
  return rows[0] || null;
}

export async function findPortalUserByEmail(email, excludeContactId = null) {
  const params = [email];
  let sql = `SELECT id, contact_id, role FROM v_b_users WHERE LOWER(email) = LOWER($1)`;
  if (excludeContactId) {
    params.push(excludeContactId);
    sql += ` AND (contact_id IS NULL OR contact_id <> $2)`;
  }
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

export async function createPortalUserForContact(contact, password, { passwordPending = false } = {}) {
  if (!contact?.id) throw new Error("Contact invalide");
  if (!contact.client_id) throw new Error("Le contact doit être rattaché à une entreprise.");
  const email = String(contact.email || "").trim();
  if (!EMAIL_RE.test(email)) throw new Error("Un email valide est requis pour activer le portail.");

  const existing = await getPortalUserByContactId(contact.id);
  if (existing) throw new Error("Un compte portail existe déjà pour ce contact.");

  const emailTaken = await findPortalUserByEmail(email, contact.id);
  if (emailTaken) throw new Error("Cet email est déjà utilisé par un autre compte.");

  const hash = await bcrypt.hash(password, 10);
  const username = buildPortalUsername(contact);
  const contactActive = !String(contact.statut || "").toLowerCase().includes("inact");

  const { rows } = await pool.query(
    `INSERT INTO v_b_users (id, email, username, password_hash, role, client_id, contact_id, is_active, profile, password_pending)
     VALUES ($1, $2, $3, $4, 'client', $5, $6, $7, NULL, $8)
     RETURNING id, email, username, role, client_id, contact_id, is_active, last_login_at, created_at, password_pending`,
    [randomUUID(), email, username, hash, contact.client_id, contact.id, contactActive, Boolean(passwordPending)]
  );
  return rows[0];
}

export async function createPortalUserInviteForContact(contact) {
  const pendingPassword = `${randomUUID()}${randomUUID()}`;
  const portal = await createPortalUserForContact(contact, pendingPassword, { passwordPending: true });
  const { rows } = await pool.query(
    "SELECT password_hash FROM v_b_users WHERE id = $1",
    [portal.id]
  );
  const contactName = [contact.prenom, contact.nom].filter(Boolean).join(" ").trim() || null;
  await sendPortalInviteEmail({
    userId: portal.id,
    email: portal.email,
    contactName,
    passwordHash: rows[0]?.password_hash,
  });
  return portal;
}

export async function resendPortalInviteForContact(contactId) {
  const contact = await pool.query(
    `SELECT c.id, c.prenom, c.nom, c.email, u.id AS portal_user_id, u.email AS portal_email
     FROM v_b_contacts c
     JOIN v_b_users u ON u.contact_id = c.id AND u.role = 'client'
     WHERE c.id = $1`,
    [contactId]
  ).then((r) => r.rows[0]);
  if (!contact?.portal_user_id) throw new Error("Aucun compte portail pour ce contact.");

  const { rows } = await pool.query(
    `SELECT id, email, password_hash, COALESCE(password_pending, false) AS password_pending
     FROM v_b_users WHERE id = $1`,
    [contact.portal_user_id]
  );
  const portal = rows[0];
  if (!portal) throw new Error("Aucun compte portail pour ce contact.");
  if (!portal.password_pending) {
    throw new Error("Ce compte est déjà activé. Utilisez « Mot de passe oublié » côté client si besoin.");
  }

  const contactName = [contact.prenom, contact.nom].filter(Boolean).join(" ").trim() || null;
  await sendPortalInviteEmail({
    userId: portal.id,
    email: portal.email,
    contactName,
    passwordHash: portal.password_hash,
  });
  return { id: portal.id, email: portal.email };
}

export async function syncPortalUserFromContact(contact) {
  const portal = await getPortalUserByContactId(contact.id);
  if (!portal) return null;

  const email = String(contact.email || "").trim();
  if (email && EMAIL_RE.test(email)) {
    const emailTaken = await findPortalUserByEmail(email, contact.id);
    if (emailTaken) throw new Error("Cet email est déjà utilisé par un autre compte.");
  }

  const username = buildPortalUsername(contact);
  const contactInactive = String(contact.statut || "").toLowerCase().includes("inact");
  const isActive = contactInactive ? false : portal.is_active;

  const { rows } = await pool.query(
    `UPDATE v_b_users
     SET email = COALESCE(NULLIF($1, ''), email),
         username = $2,
         client_id = $3,
         is_active = $4
     WHERE id = $5
     RETURNING id, email, username, role, client_id, contact_id, is_active, last_login_at, created_at`,
    [email, username, contact.client_id, isActive, portal.id]
  );
  return rows[0] || null;
}

export async function setPortalActive(contactId, active) {
  const { rows } = await pool.query(
    `UPDATE v_b_users
     SET is_active = $1
     WHERE contact_id = $2 AND role = 'client'
     RETURNING id, email, username, role, client_id, contact_id, is_active, last_login_at, created_at`,
    [Boolean(active), contactId]
  );
  if (!rows[0]) throw new Error("Aucun compte portail pour ce contact.");
  return rows[0];
}

export async function deletePortalUserForContact(contactId) {
  const { rowCount } = await pool.query(
    `DELETE FROM v_b_users WHERE contact_id = $1 AND role = 'client'`,
    [contactId]
  );
  return rowCount > 0;
}

export async function resetPortalPassword(contactId, newPassword) {
  const hash = await bcrypt.hash(newPassword, 10);
  const { rows } = await pool.query(
    `UPDATE v_b_users SET password_hash = $1, password_pending = false
     WHERE contact_id = $2 AND role = 'client'
     RETURNING id`,
    [hash, contactId]
  );
  if (!rows[0]) throw new Error("Aucun compte portail pour ce contact.");
  return true;
}

export const PORTAL_USER_SELECT = `
  u.id AS portal_user_id,
  u.is_active AS portal_active,
  u.last_login_at AS portal_last_login,
  u.email AS portal_email,
  COALESCE(u.password_pending, false) AS portal_pending
`;

export const PORTAL_USER_JOIN = `
  LEFT JOIN v_b_users u ON u.contact_id = cts.id AND u.role = 'client'
`;
