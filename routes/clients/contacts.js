import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { dispatchNotificationEvent } from "../../services/notificationDispatcher.js";
import { PORTAL_USER_JOIN, PORTAL_USER_SELECT, createPortalUserForContact, createPortalUserInviteForContact, resendPortalInviteForContact, syncPortalUserFromContact, setPortalActive, deletePortalUserForContact, resetPortalPassword, getPortalUserByContactId } from '../../utils/contactPortal.js';
import { registerContactMetaRoutes, fetchTagsByContactIdMap, attachContactTags, fetchTagsForContactId } from './contactMeta.js';
import { normalizeContactSexe } from '../../utils/contactSexe.js';
import { normalizeContactCommunications, syncLegacyContactFields, validateContactCommunications } from '../../utils/contactCommunications.js';
import { isCommunity, COMMUNITY_LIMITS } from '../../utils/edition.js';
import { assertCommunityClientPortalLimit, assertCommunityContactsLimit, getActiveClientPortalCount, sendCommunityLimitError } from '../../utils/communityLimits.js';
import { buildImpersonationClientPayload, IMPERSONATOR_COOKIE, setImpersonatorCookie, setSessionCookie, signSessionToken } from '../../utils/authSession.js';
import { requireRole } from '../../middleware/roles.js';
import { validatePortalPassword, PORTAL_PASSWORD_MIN_LENGTH } from '../../utils/passwordPolicy.js';
const PORTAL_PASSWORD_ERROR = `Password too weak: at least ${PORTAL_PASSWORD_MIN_LENGTH} characters, with at least one letter and one digit.`;
const router = express.Router();
router.use(verifyJWT);
const uuidRegexUser = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const buildContactChanges = (oldData, newData) => {
  const fields = [{
    key: 'nom',
    label: 'nom'
  }, {
    key: 'prenom',
    label: 'first name'
  }, {
    key: 'sexe',
    label: 'courtesy title'
  }, {
    key: 'email',
    label: 'email'
  }, {
    key: 'telephone',
    label: 'phone'
  }, {
    key: 'communications',
    label: 'moyens de communication'
  }, {
    key: 'poste',
    label: 'poste'
  }, {
    key: 'statut',
    label: 'statut'
  }, {
    key: 'client_id',
    label: 'entreprise'
  }];
  const modifiedFields = [];
  const changes = [];
  fields.forEach(({
    key,
    label
  }) => {
    const oldValue = oldData?.[key] ?? null;
    const newValue = newData?.[key] ?? null;
    const oldSerialized = key === 'communications' ? JSON.stringify(oldValue ?? []) : String(oldValue ?? '');
    const newSerialized = key === 'communications' ? JSON.stringify(newValue ?? []) : String(newValue ?? '');
    if (oldSerialized !== newSerialized) {
      modifiedFields.push(key);
      changes.push({
        field: label,
        oldValue: oldValue,
        newValue: newValue
      });
    }
  });
  return {
    modifiedFields,
    changes
  };
};
const invalidateContactsListCache = () => {};
const CONTACT_LIST_SELECT = `
  cts.id,
  cts.client_id,
  cli.name AS client_name,
  cts.nom,
  cts.prenom,
  cts.sexe,
  cts.email,
  cts.telephone,
  cts.poste,
  cts.statut,
  cts.created_at,
  cts.updated_at,
  ${PORTAL_USER_SELECT}
`;
const CONTACT_LIST_FROM = `
  FROM v_b_contacts cts
  LEFT JOIN v_b_clients cli ON cli.id = cts.client_id
  ${PORTAL_USER_JOIN}
`;
function requireAgent(req, res, next) {
  if (String(req.user?.role || "").toLowerCase() === "client") {
    return res.status(403).json({
      error: "Access restricted to MSP agents."
    });
  }
  next();
}
async function loadContactById(contactId) {
  const {
    rows
  } = await pool.query(`SELECT cts.id, cts.client_id, cli.name AS client_name,
            cts.nom, cts.prenom, cts.sexe, cts.email, cts.telephone, cts.poste, cts.statut,
            COALESCE(cts.communications, '[]'::jsonb) AS communications,
            cts.created_at, cts.updated_at,
            ${PORTAL_USER_SELECT}
     FROM v_b_contacts cts
     LEFT JOIN v_b_clients cli ON cli.id = cts.client_id
     ${PORTAL_USER_JOIN}
     WHERE cts.id = $1`, [contactId]);
  return hydrateContactRow(rows[0] || null);
}
function hydrateContactRow(row) {
  if (!row) return null;
  const communications = normalizeContactCommunications(row);
  const synced = syncLegacyContactFields(communications);
  return {
    ...row,
    communications: synced.communications,
    email: synced.email,
    telephone: synced.telephone
  };
}
function resolveContactCommunications(payload, current = null) {
  const commList = payload.communications;
  if (Array.isArray(commList) && commList.length > 0) {
    return syncLegacyContactFields(commList);
  }
  return syncLegacyContactFields({
    communications: Array.isArray(commList) ? commList : current?.communications || [],
    email: Object.prototype.hasOwnProperty.call(payload, 'email') ? payload.email : current?.email,
    telephone: Object.prototype.hasOwnProperty.call(payload, 'telephone') ? payload.telephone : current?.telephone
  });
}
function parseContactId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}
router.get('/list', requirePermission('contacts.view'), async (req, res) => {
  const {
    client_id
  } = req.query;
  const numericClientId = client_id ? Number(client_id) : null;
  const params = [];
  const whereClause = numericClientId ? 'WHERE cts.client_id = $1' : '';
  if (numericClientId) {
    params.push(numericClientId);
  }
  try {
    const result = await pool.query(`SELECT ${CONTACT_LIST_SELECT}
       ${CONTACT_LIST_FROM}
       ${whereClause}
       ORDER BY cts.nom NULLS LAST, cts.prenom NULLS LAST, cts.id`, params);
    const tagsByContactId = await fetchTagsByContactIdMap();
    const enrichedRows = attachContactTags(result.rows, tagsByContactId);
    res.set('Cache-Control', 'no-store');
    return res.json(enrichedRows);
  } catch (err) {
    return res.status(500).json({
      error: 'Error retrieving contacts',
      details: err.message
    });
  }
});
router.get('/', requirePermission('contacts.view'), async (req, res) => {
  const {
    client_id
  } = req.query;
  const params = [];
  const whereClause = client_id ? 'WHERE cts.client_id = $1' : '';
  if (client_id) {
    params.push(client_id);
  }
  try {
    const result = await pool.query(`SELECT ${CONTACT_LIST_SELECT}
       ${CONTACT_LIST_FROM}
       ${whereClause}
       ORDER BY cts.nom NULLS LAST, cts.prenom NULLS LAST, cts.id`, params);
    const tagsByContactId = await fetchTagsByContactIdMap();
    res.json(attachContactTags(result.rows, tagsByContactId));
  } catch (err) {
    res.status(500).json({
      error: 'Error retrieving contacts',
      details: err.message
    });
  }
});
registerContactMetaRoutes(router, {
  invalidateContactsListCache
});
router.get('/portal/usage', verifyJWT, requireAgent, async (_req, res) => {
  try {
    if (!isCommunity()) {
      return res.json({
        limited: false,
        active: 0,
        max: null
      });
    }
    const active = await getActiveClientPortalCount();
    res.json({
      limited: true,
      active,
      max: COMMUNITY_LIMITS.clientPortalUsers
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || "Server error"
    });
  }
});
router.get('/:id/portal', verifyJWT, requireAgent, async (req, res) => {
  const contactId = parseContactId(req.params.id);
  if (!contactId) return res.status(400).json({
    error: "Invalid ID contact"
  });
  try {
    const contact = await loadContactById(contactId);
    if (!contact) return res.status(404).json({
      error: "Contact not found"
    });
    const portal = contact.portal_user_id ? {
      user_id: contact.portal_user_id,
      email: contact.portal_email,
      is_active: contact.portal_active,
      last_login_at: contact.portal_last_login,
      password_pending: Boolean(contact.portal_pending)
    } : null;
    res.json({
      contact_id: contactId,
      portal
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || "Server error"
    });
  }
});
router.post('/:id/portal', verifyJWT, requireAgent, requirePermission('contacts.manage'), async (req, res) => {
  const contactId = parseContactId(req.params.id);
  if (!contactId) return res.status(400).json({
    error: "Invalid ID contact"
  });
  try {
    await assertCommunityClientPortalLimit(1);
    const contact = await loadContactById(contactId);
    if (!contact) return res.status(404).json({
      error: "Contact not found"
    });
    const portal = await createPortalUserInviteForContact(contact);
    invalidateContactsListCache(contact.client_id);
    invalidateContactsListCache(null);
    res.status(201).json({
      contact_id: contactId,
      portal,
      inviteSent: true
    });
  } catch (err) {
    if (err?.code?.startsWith("COMMUNITY_")) {
      return sendCommunityLimitError(res, err);
    }
    res.status(400).json({
      error: err.message || "Unable to create portal account."
    });
  }
});
router.post('/:id/portal/invite', verifyJWT, requireAgent, requirePermission('contacts.manage'), async (req, res) => {
  const contactId = parseContactId(req.params.id);
  if (!contactId) return res.status(400).json({
    error: "Invalid ID contact"
  });
  try {
    const contact = await loadContactById(contactId);
    if (!contact) return res.status(404).json({
      error: "Contact not found"
    });
    const portal = await resendPortalInviteForContact(contactId);
    res.json({
      contact_id: contactId,
      portal,
      inviteSent: true
    });
  } catch (err) {
    res.status(400).json({
      error: err.message || "Unable to send invitation."
    });
  }
});
router.patch('/:id/portal', verifyJWT, requireAgent, requirePermission('contacts.manage'), async (req, res) => {
  const contactId = parseContactId(req.params.id);
  if (!contactId) return res.status(400).json({
    error: "Invalid ID contact"
  });
  if (req.body?.is_active === undefined) {
    return res.status(400).json({
      error: "Champ is_active required."
    });
  }
  try {
    if (req.body?.is_active === true) {
      const contactBefore = await loadContactById(contactId);
      if (!contactBefore) return res.status(404).json({
        error: "Contact not found"
      });
      if (!contactBefore.portal_active) {
        await assertCommunityClientPortalLimit(1);
      }
    }
    const portal = await setPortalActive(contactId, req.body.is_active);
    const contact = await loadContactById(contactId);
    invalidateContactsListCache(contact?.client_id);
    invalidateContactsListCache(null);
    res.json({
      contact_id: contactId,
      portal
    });
  } catch (err) {
    if (err?.code?.startsWith("COMMUNITY_")) {
      return sendCommunityLimitError(res, err);
    }
    res.status(400).json({
      error: err.message || "Update not possible."
    });
  }
});
router.patch('/:id/portal/password', verifyJWT, requireAgent, requirePermission('contacts.manage'), async (req, res) => {
  const contactId = parseContactId(req.params.id);
  if (!contactId) return res.status(400).json({
    error: "Invalid ID contact"
  });
  const newPassword = String(req.body?.newPassword || req.body?.password || "");
  if (!validatePortalPassword(newPassword).valid) {
    return res.status(400).json({
      error: PORTAL_PASSWORD_ERROR
    });
  }
  try {
    await resetPortalPassword(contactId, newPassword);
    res.json({
      success: true
    });
  } catch (err) {
    res.status(400).json({
      error: err.message || "Reset not possible."
    });
  }
});
router.delete('/:id/portal', verifyJWT, requireAgent, requirePermission('contacts.manage'), async (req, res) => {
  const contactId = parseContactId(req.params.id);
  if (!contactId) return res.status(400).json({
    error: "Invalid ID contact"
  });
  try {
    const contact = await loadContactById(contactId);
    const removed = await deletePortalUserForContact(contactId);
    if (!removed) return res.status(404).json({
      error: "No portal account for this contact."
    });
    invalidateContactsListCache(contact?.client_id);
    invalidateContactsListCache(null);
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || "Deletion not possible."
    });
  }
});
router.post('/:id/portal/impersonate', verifyJWT, requireRole('admin'), async (req, res) => {
  const contactId = parseContactId(req.params.id);
  if (!contactId) return res.status(400).json({
    error: "Invalid ID contact"
  });
  if (req.cookies?.[IMPERSONATOR_COOKIE]) {
    return res.status(400).json({
      error: "An impersonation is already active. Exit it before starting a new one."
    });
  }
  try {
    const contact = await loadContactById(contactId);
    if (!contact) return res.status(404).json({
      error: "Contact not found"
    });
    if (!contact.portal_user_id) {
      return res.status(404).json({
        error: "No portal account for this contact."
      });
    }
    if (!contact.portal_active) {
      return res.status(403).json({
        error: "Portal account is disabled."
      });
    }
    const portalUser = await getPortalUserByContactId(contactId);
    if (!portalUser || portalUser.id !== contact.portal_user_id) {
      return res.status(404).json({
        error: "Portal account not found."
      });
    }
    if (portalUser.is_active === false) {
      return res.status(403).json({
        error: "Portal account is disabled."
      });
    }
    if (!portalUser.client_id) {
      return res.status(400).json({
        error: "This contact is not linked to any company."
      });
    }
    const agentToken = req.cookies?.token;
    if (!agentToken) {
      return res.status(401).json({
        error: "Agent session not found."
      });
    }
    const clientToken = signSessionToken(buildImpersonationClientPayload(portalUser, {
      id: req.user.id,
      email: req.user.email
    }));
    setImpersonatorCookie(req, res, agentToken);
    setSessionCookie(req, res, clientToken);
    console.info(`[impersonation][audit] ts=${new Date().toISOString()} ip=${req.ip} agent=${req.user.id} agent_email=${req.user.email} contact=${contactId} portal_user=${portalUser.id} client=${portalUser.client_id}`);
    res.json({
      id: portalUser.id,
      email: portalUser.email,
      username: portalUser.username || null,
      role: "client",
      client_id: portalUser.client_id,
      contact_id: contactId,
      contact_name: [contact.prenom, contact.nom].filter(Boolean).join(" ").trim() || null,
      impersonating: true
    });
  } catch (err) {
    console.error("POST /contacts/:id/portal/impersonate:", err);
    res.status(500).json({
      error: err.message || "Unable to start impersonation."
    });
  }
});
router.get('/:id/logs', verifyJWT, async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const result = await pool.query(`SELECT
        l.id,
        l.contact_id,
        l.client_id,
        l.user_id,
        COALESCE(u.username, u.email) AS user_name,
        l.action,
        l.details,
        l.created_at
       FROM v_b_contacts_logs l
       LEFT JOIN v_b_users u ON l.user_id::text = u.id::text
       WHERE l.contact_id = $1
       ORDER BY l.created_at DESC
       LIMIT $2 OFFSET $3`, [parseInt(id), limit, offset]);
    const countResult = await pool.query(`SELECT COUNT(*) as total
       FROM v_b_contacts_logs
       WHERE contact_id = $1`, [parseInt(id)]);
    const total = parseInt(countResult.rows[0].total) || 0;
    res.json({
      logs: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({
      error: "Error retrieving logs",
      details: err.message
    });
  }
});
router.get('/:id', async (req, res) => {
  const contactId = parseContactId(req.params.id);
  if (!contactId) return res.status(400).json({
    error: "Invalid ID contact"
  });
  try {
    const contact = await loadContactById(contactId);
    if (!contact) {
      return res.status(404).json({
        error: "Contact not found"
      });
    }
    const tags = await fetchTagsForContactId(contactId);
    res.json({
      ...contact,
      tags
    });
  } catch (err) {
    res.status(500).json({
      error: 'Error retrieving contact',
      details: err.message
    });
  }
});
router.post('/', verifyJWT, requirePermission('contacts.create'), async (req, res) => {
  try {
    await assertCommunityContactsLimit(1);
    const {
      nom,
      prenom,
      sexe,
      email,
      telephone,
      poste,
      statut,
      client_id,
      communications
    } = req.body;
    if (!nom) {
      return res.status(400).json({
        error: "Name is required"
      });
    }
    const normalizedSexe = normalizeContactSexe(sexe);
    if (Array.isArray(communications)) {
      const commError = validateContactCommunications(communications);
      if (commError) {
        return res.status(400).json({
          error: commError
        });
      }
    }
    const syncedComms = resolveContactCommunications({
      communications,
      email,
      telephone
    });
    const result = await pool.query(`
      INSERT INTO v_b_contacts (nom, prenom, sexe, email, telephone, poste, statut, client_id, communications, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING id, nom, prenom, sexe, email, telephone, poste, statut, client_id, communications, created_at, updated_at
    `, [nom, prenom || null, normalizedSexe, syncedComms.email, syncedComms.telephone, poste || null, statut || 'actif', client_id || null, JSON.stringify(syncedComms.communications)]);
    const newContact = hydrateContactRow(result.rows[0]);
    invalidateContactsListCache(newContact.client_id || null);
    await dispatchNotificationEvent({
      source: "contact",
      element: "created",
      enterpriseId: String(newContact.client_id || ""),
      user: req.user,
      context: {
        contact: newContact,
        entreprise: {
          id: String(newContact.client_id || "")
        }
      }
    }).catch(() => {});
    res.status(201).json(newContact);
  } catch (err) {
    if (err?.code?.startsWith("COMMUNITY_")) {
      return sendCommunityLimitError(res, err);
    }
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message
    });
  }
});
router.put('/:id', verifyJWT, requirePermission('contacts.edit'), async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const contactId = Number(id);
    if (!Number.isInteger(contactId) || contactId <= 0) {
      return res.status(400).json({
        error: "Invalid ID contact"
      });
    }
    const payload = req.body || {};
    const {
      nom,
      prenom,
      sexe,
      email,
      telephone,
      poste,
      statut,
      client_id,
      communications
    } = payload;
    const existing = await pool.query(`SELECT id, client_id, nom, prenom, sexe, email, telephone, poste, statut,
              COALESCE(communications, '[]'::jsonb) AS communications
       FROM v_b_contacts
       WHERE id = $1`, [contactId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: "Contact not found"
      });
    }
    const current = hydrateContactRow(existing.rows[0]);
    const hasOwn = key => Object.prototype.hasOwnProperty.call(payload, key);
    const resolvedNom = hasOwn('nom') ? (nom || '').trim() : current.nom || '';
    if (!resolvedNom) {
      return res.status(400).json({
        error: "Name is required"
      });
    }
    const resolvedPrenom = hasOwn('prenom') ? prenom || null : current.prenom || null;
    const resolvedSexe = hasOwn('sexe') ? normalizeContactSexe(sexe) : current.sexe || null;
    const resolvedPoste = hasOwn('poste') ? poste || null : current.poste || null;
    const resolvedStatut = hasOwn('statut') ? statut || current.statut || 'actif' : current.statut || 'actif';
    const resolvedClientId = hasOwn('client_id') ? client_id || null : current.client_id || null;
    if (Array.isArray(communications)) {
      const commError = validateContactCommunications(communications);
      if (commError) {
        return res.status(400).json({
          error: commError
        });
      }
    }
    const syncedComms = resolveContactCommunications(payload, current);
    const result = await pool.query(`
      UPDATE v_b_contacts
      SET nom = $1, prenom = $2, sexe = $3, email = $4, telephone = $5, poste = $6, statut = $7, client_id = $8,
          communications = $9::jsonb, updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING id, nom, prenom, sexe, email, telephone, poste, statut, client_id, communications, created_at, updated_at
    `, [resolvedNom, resolvedPrenom, resolvedSexe, syncedComms.email, syncedComms.telephone, resolvedPoste, resolvedStatut, resolvedClientId, JSON.stringify(syncedComms.communications), contactId]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Contact not found"
      });
    }
    const updatedContact = hydrateContactRow(result.rows[0]);
    const oldClientId = current?.client_id || null;
    const newClientId = updatedContact?.client_id || null;
    invalidateContactsListCache(oldClientId);
    if (newClientId !== oldClientId) {
      invalidateContactsListCache(newClientId);
    }
    const {
      modifiedFields,
      changes
    } = buildContactChanges(current, updatedContact);
    const rawUserId = req.user?.id || req.user?.user_id || null;
    const userId = rawUserId && uuidRegexUser.test(String(rawUserId)) ? String(rawUserId) : null;
    if (modifiedFields.length > 0) {
      try {
        await pool.query(`INSERT INTO v_b_contacts_logs
           (contact_id, client_id, user_id, action, details, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`, [updatedContact.id, updatedContact.client_id, userId, 'Contact update', JSON.stringify({
          modifiedFields,
          changes
        })]);
      } catch (logError) {
        console.warn('Error writing contact log:', logError);
      }
    }
    await dispatchNotificationEvent({
      source: "contact",
      element: "updated",
      enterpriseId: String(updatedContact.client_id || ""),
      user: req.user,
      context: {
        contact: updatedContact,
        changes,
        entreprise: {
          id: String(updatedContact.client_id || "")
        }
      }
    }).catch(() => {});
    try {
      await syncPortalUserFromContact(updatedContact);
    } catch (syncErr) {
      console.warn("Sync portail contact:", syncErr.message);
    }
    const enriched = await loadContactById(contactId);
    res.json(enriched || updatedContact);
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message
    });
  }
});
router.delete('/:id/logs', verifyJWT, async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const result = await pool.query(`
      DELETE FROM v_b_contacts_logs
      WHERE contact_id = $1
      RETURNING id
    `, [parseInt(id)]);
    res.json({
      success: true,
      message: `${result.rows.length} logs deleted`
    });
  } catch (err) {
    res.status(500).json({
      error: "Error purging logs",
      details: err.message
    });
  }
});
router.delete('/:id', verifyJWT, requirePermission('contacts.delete'), async (req, res) => {
  try {
    const {
      id
    } = req.params;
    const existing = await pool.query(`SELECT client_id FROM v_b_contacts WHERE id = $1`, [parseInt(id)]);
    await deletePortalUserForContact(parseInt(id)).catch(() => {});
    const result = await pool.query(`
      DELETE FROM v_b_contacts
      WHERE id = $1
      RETURNING id
    `, [parseInt(id)]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Contact not found"
      });
    }
    invalidateContactsListCache(existing.rows[0]?.client_id || null);
    res.json({
      success: true,
      message: "Contact deleted"
    });
  } catch (err) {
    res.status(500).json({
      error: "Internal error (SQL)",
      details: err.message
    });
  }
});
export default router;
