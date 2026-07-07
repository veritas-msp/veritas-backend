import express from "express";
import { pool } from "../../database/db.js";
import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { body, param, validationResult } from "express-validator";
import multer from "multer";
import path from "path";

import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import {
  assertCommunityClientPortalLimit,
  assertMspAgentLimit,
  sendCommunityLimitError,
} from "../../utils/communityLimits.js";
import {
  USER_AVATAR_SETTING_KEY,
  attachUserAvatar,
  buildAvatarPublicPath,
  ensureAvatarUploadDir,
  upsertUserAvatarSetting,
  validatePresetAvatarId,
} from "../../utils/userAvatar.js";
import { findPortalUserByEmail } from "../../utils/contactPortal.js";

const router = express.Router();
router.use(verifyJWT);
const DEFAULT_USER_PROFILE = "Agent";
const OPTIONAL_BODY = { values: "falsy" };
const ALLOWED_USER_ROLES = ["admin", "superviseur", "utilisateur"];
const TICKET_HELPDESK_DISPLAY_NAME_KEY = "ticket_helpdesk_display_name";
const TICKET_CHAT_UI_SETTINGS_KEY = "ticket_chat_ui_settings";

/** Comptes portail client (role client) — exclus des listes agents / internes */
const AGENTS_LIST_WHERE = `WHERE COALESCE(role, '') <> 'client'`;

const HELPDESK_DISPLAY_JOIN = `
  LEFT JOIN v_b_users_settings hs
    ON hs.user_id = u.id AND hs.setting_key = '${TICKET_HELPDESK_DISPLAY_NAME_KEY}'`;

const CHAT_UI_SETTINGS_JOIN = `
  LEFT JOIN v_b_users_settings cs
    ON cs.user_id = u.id AND cs.setting_key = '${TICKET_CHAT_UI_SETTINGS_KEY}'`;

const AVATAR_JOIN = `
  LEFT JOIN v_b_users_settings av
    ON av.user_id = u.id AND av.setting_key = '${USER_AVATAR_SETTING_KEY}'`;

const avatarStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const dir = ensureAvatarUploadDir(req.user.id);
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(String(file.originalname || "")).toLowerCase();
    const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
    cb(null, `avatar-${Date.now()}${safeExt}`);
  },
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Format d'image non autorisé (JPG, PNG ou WebP)."));
    }
    cb(null, true);
  },
});

function parseJsonSettingString(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return String(value).trim() || null;
}

function parseTicketChatUiSettings(value) {
  if (value == null) return { textSizePx: 16, messageSpacingPx: 10 };
  let raw = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return { textSizePx: 16, messageSpacingPx: 10 };
    }
  }
  if (!raw || typeof raw !== "object") return { textSizePx: 16, messageSpacingPx: 10 };
  const textSizePx = Number(raw.textSizePx);
  const messageSpacingPx = Number(raw.messageSpacingPx);
  return {
    textSizePx: Number.isFinite(textSizePx) ? Math.min(24, Math.max(12, textSizePx)) : 16,
    messageSpacingPx: Number.isFinite(messageSpacingPx)
      ? Math.min(24, Math.max(0, messageSpacingPx))
      : 10,
  };
}

function attachHelpdeskDisplayName(row) {
  if (!row) return row;
  return {
    ...row,
    ticket_helpdesk_display_name: parseJsonSettingString(row.ticket_helpdesk_display_name),
  };
}

function attachUserProfileSettings(row) {
  if (!row) return row;
  const ticket_chat_ui_settings = parseTicketChatUiSettings(row.ticket_chat_ui_settings_raw);
  const base = attachHelpdeskDisplayName(row);
  delete base.ticket_chat_ui_settings_raw;
  return attachUserAvatar({ ...base, ticket_chat_ui_settings });
}

// ───────────────────────────────────────────────
// 🙋‍♂️ GET /me — Infos utilisateur connecté
// ───────────────────────────────────────────────
router.get("/me", verifyJWT, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.role, u.profile, u.is_active,
              u.last_login_at, u.created_at,
              COALESCE(u.mfa_enabled, false) AS mfa_enabled,
              (COALESCE(u.mfa_enabled, false) = false
               AND u.mfa_secret IS NOT NULL AND TRIM(u.mfa_secret) <> '') AS mfa_pending_setup,
              p.label AS profile_label,
              p.monitoring_enabled,
              p.infrastructure_enabled,
              p.cybersecurite_enabled,
              p.planning_enabled,
              p.service_enabled,
              p.contrat_enabled,
              p.contact_enabled,
              p.tickets_enabled,
              p.configurateur_enabled,
              p.dashboard_enabled,
              hs.setting_value AS ticket_helpdesk_display_name,
              cs.setting_value AS ticket_chat_ui_settings_raw,
              av.setting_value AS avatar_setting_raw
       FROM v_b_users u
       LEFT JOIN v_b_users_profiles p ON p.name = u.profile
       ${HELPDESK_DISPLAY_JOIN}
       ${CHAT_UI_SETTINGS_JOIN}
       ${AVATAR_JOIN}
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json(attachUserProfileSettings(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/me/avatar", verifyJWT, (req, res) => {
  uploadAvatar.single("avatar")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || "Erreur lors de l'upload." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Fichier avatar requis." });
    }
    try {
      const avatar = {
        type: "upload",
        url: buildAvatarPublicPath(req.user.id, req.file.filename),
      };
      await upsertUserAvatarSetting(req.user.id, avatar);
      res.json({ success: true, avatar });
    } catch (uploadErr) {
      console.error("POST /users/me/avatar:", uploadErr);
      res.status(500).json({ error: "Erreur lors de l'enregistrement de l'avatar." });
    }
  });
});

router.post(
  "/me/avatar/preset",
  verifyJWT,
  [body("presetId").isString().trim().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: errors.array().map((e) => e.msg).filter(Boolean).join(" · ") || "Données invalides.",
        errors: errors.array(),
      });
    }

    const presetId = String(req.body.presetId || "").toLowerCase();
    if (!validatePresetAvatarId(presetId)) {
      return res.status(400).json({ error: "Avatar prédéfini invalide." });
    }

    try {
      const avatar = { type: "preset", presetId };
      await upsertUserAvatarSetting(req.user.id, avatar);
      res.json({ success: true, avatar });
    } catch (err) {
      console.error("POST /users/me/avatar/preset:", err);
      res.status(500).json({ error: "Erreur lors de l'enregistrement de l'avatar." });
    }
  }
);

router.delete("/me/avatar", verifyJWT, async (req, res) => {
  try {
    await upsertUserAvatarSetting(req.user.id, null);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /users/me/avatar:", err);
    res.status(500).json({ error: "Erreur lors de la suppression de l'avatar." });
  }
});

// ───────────────────────────────────────────────
// 👥 GET /active — Utilisateurs actifs (tous rôles, pour sélection dans l'app)
// ───────────────────────────────────────────────
router.get("/active", verifyJWT, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.email,
              hs.setting_value AS ticket_helpdesk_display_name,
              av.setting_value AS avatar_setting_raw
       FROM v_b_users u
       ${HELPDESK_DISPLAY_JOIN}
       ${AVATAR_JOIN}
       ${AGENTS_LIST_WHERE}
         AND u.is_active = true
       ORDER BY u.username NULLS LAST, u.email ASC`
    );
    res.json(result.rows.map((row) => attachUserAvatar(attachHelpdeskDisplayName(row))));
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la récupération des utilisateurs actifs" });
  }
});

// ───────────────────────────────────────────────
// 👥 GET / — Tous les utilisateurs (admin uniquement)
// ───────────────────────────────────────────────
router.get("/", verifyJWT, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.role, u.profile, u.is_active,
              COALESCE(u.mfa_enabled, false) AS mfa_enabled,
              (COALESCE(u.mfa_enabled, false) = false
               AND u.mfa_secret IS NOT NULL AND TRIM(u.mfa_secret) <> '') AS mfa_pending_setup,
              u.last_login_at, u.created_at,
              hs.setting_value AS ticket_helpdesk_display_name,
              av.setting_value AS avatar_setting_raw
       FROM v_b_users u
       ${HELPDESK_DISPLAY_JOIN}
       ${AVATAR_JOIN}
       ${AGENTS_LIST_WHERE}
       ORDER BY u.created_at DESC`
    );
    res.json(result.rows.map((row) => attachUserAvatar(attachHelpdeskDisplayName(row))));
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la récupération des utilisateurs" });
  }
});

// ───────────────────────────────────────────────
// 🛠️ PATCH /:id — Modifier le rôle ou le profil
// ───────────────────────────────────────────────
router.patch(
  "/:id",
  verifyJWT,
  [
    param("id").isUUID(),
    body("role").optional(OPTIONAL_BODY).isIn(ALLOWED_USER_ROLES),
    body("profile").optional(OPTIONAL_BODY).isString().trim().isLength({ min: 2 }),
    body("is_active").optional().isBoolean(),
    body("username").optional(OPTIONAL_BODY).isString().trim().isLength({ min: 2, max: 50 }),
    body("email").optional(OPTIONAL_BODY).isEmail(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { id } = req.params;
    const { role, profile, is_active, username, email } = req.body;

    if (req.user.id !== id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Non autorisé à modifier cet utilisateur." });
    }

    try {
      if (is_active === true) {
        const target = await pool.query(
          `SELECT id, role, is_active FROM v_b_users WHERE id = $1`,
          [id]
        );
        const row = target.rows[0];
        if (row && !row.is_active) {
          if (String(row.role || "").toLowerCase() === "client") {
            await assertCommunityClientPortalLimit(1);
          } else {
            await assertMspAgentLimit(1);
          }
        }
      }
      if (role !== undefined && role !== null && String(role).trim() !== "") {
        await pool.query("UPDATE v_b_users SET role = $1 WHERE id = $2", [role, id]);
      }
      if (profile !== undefined && profile !== null && String(profile).trim() !== "") {
        await pool.query("UPDATE v_b_users SET profile = $1 WHERE id = $2", [profile, id]);
      }
      if (is_active !== undefined) {
        await pool.query("UPDATE v_b_users SET is_active = $1 WHERE id = $2", [is_active, id]);
      }
      if (username !== undefined && username !== null && String(username).trim() !== "") {
        await pool.query("UPDATE v_b_users SET username = $1 WHERE id = $2", [username, id]);
      }
      if (email !== undefined && email !== null && String(email).trim() !== "") {
        await pool.query("UPDATE v_b_users SET email = $1 WHERE id = $2", [email, id]);
      }
      res.json({ success: true });
    } catch (err) {
      if (err?.code?.startsWith("COMMUNITY_") || err?.code === "PRO_AGENT_LIMIT") {
        return sendCommunityLimitError(res, err);
      }
      console.error("PATCH /users/:id", err);
      res.status(500).json({ error: "Erreur lors de la mise à jour" });
    }
  }
);

// ───────────────────────────────────────────────
// 🔑 PATCH /:id/password — Réinitialiser mot de passe
// ───────────────────────────────────────────────
router.patch(
  "/:id/password",
  verifyJWT,
  [
    param("id").isUUID(),
    body("newPassword").isString().isLength({ min: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { id } = req.params;
    const { newPassword } = req.body;

    if (req.user.role !== "admin" && req.user.id !== id) {
      return res.status(403).json({ error: "Non autorisé à changer ce mot de passe." });
    }

    try {
      const hash = await bcrypt.hash(newPassword, 10);
      await pool.query("UPDATE v_b_users SET password_hash = $1 WHERE id = $2", [hash, id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Erreur lors du changement de mot de passe" });
    }
  }
);

// ───────────────────────────────────────────────
// ➕ POST / — Créer un utilisateur (admin uniquement)
// ───────────────────────────────────────────────
router.post(
  "/",
  verifyJWT,
  requireRole("admin"),
  [
    body("email").isEmail(),
    body("profile").optional().isString().isLength({ min: 2 }),
    body("password").isString().isLength({ min: 6 }),
    body("username").optional().isString().trim().isLength({ min: 2, max: 50 }),
    body("is_active").optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password, username, is_active } = req.body;

    try {
      const willBeActive = is_active === undefined ? true : is_active;
      if (willBeActive) {
        await assertMspAgentLimit(1);
      }
      const hash = await bcrypt.hash(password, 10);
      const result = await pool.query(
        `INSERT INTO v_b_users (id, email, username, profile, password_hash, is_active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [randomUUID(), email, username || null, DEFAULT_USER_PROFILE, hash, is_active === undefined ? true : is_active]
      );

      res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
      if (err?.code?.startsWith("COMMUNITY_") || err?.code === "PRO_AGENT_LIMIT") {
        return sendCommunityLimitError(res, err);
      }
      res.status(500).json({ error: "Erreur lors de la création de l'utilisateur" });
    }
  }
);

// ───────────────────────────────────────────────
// ❌ DELETE /:id — Supprimer un utilisateur (admin uniquement)
// ───────────────────────────────────────────────
router.delete("/:id", verifyJWT, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  try {
    const target = await pool.query(
      `SELECT id, role FROM v_b_users WHERE id = $1`,
      [id]
    );

    if (target.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    if (target.rows[0].role === "admin") {
      const admins = await pool.query(
        `SELECT COUNT(*)::int AS total FROM v_b_users WHERE role = 'admin'`
      );
      if ((admins.rows[0]?.total || 0) <= 1) {
        return res.status(409).json({
          error: "Impossible de supprimer le dernier administrateur. Il doit rester au moins un compte admin.",
        });
      }
    }

    await pool.query("DELETE FROM v_b_users WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /users/:id", err);
    res.status(500).json({ error: "Erreur lors de la suppression" });
  }
});

// ───────────────────────────────────────────────
// 🧑 GET /:id — Détails utilisateur (admin uniquement)
// ───────────────────────────────────────────────
router.get("/:id", verifyJWT, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, username, email, role, profile, is_active,
              COALESCE(mfa_enabled, false) AS mfa_enabled,
              (COALESCE(mfa_enabled, false) = false
               AND mfa_secret IS NOT NULL AND TRIM(mfa_secret) <> '') AS mfa_pending_setup,
              last_login_at, created_at
       FROM v_b_users WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la récupération de l'utilisateur" });
  }
});

// ───────────────────────────────────────────────
// ✏️ PATCH /:id/username — Modifier le username
// ───────────────────────────────────────────────
router.patch(
  "/:id/username",
  verifyJWT,
  [
    param("id").isUUID(),
    body("username").isString().trim().isLength({ min: 2, max: 50 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { id } = req.params;
    const { username } = req.body;

    if (req.user.id !== id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Non autorisé à modifier ce username." });
    }

    try {
      await pool.query("UPDATE v_b_users SET username = $1 WHERE id = $2", [username, id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Erreur lors de la mise à jour du username" });
    }
  }
);

// ───────────────────────────────────────────────
// 🔓 DELETE /:id/mfa — Réinitialiser la MFA (admin uniquement)
// ───────────────────────────────────────────────
router.delete("/:id/mfa", verifyJWT, requireRole("admin"), [param("id").isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { id } = req.params;

  try {
    const existing = await pool.query(
      `SELECT id, COALESCE(mfa_enabled, false) AS mfa_enabled,
              (mfa_secret IS NOT NULL AND TRIM(mfa_secret) <> '') AS has_secret
       FROM v_b_users WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    const user = existing.rows[0];
    if (!user.mfa_enabled && !user.has_secret) {
      return res.status(400).json({ error: "La MFA n'est pas configurée pour cet utilisateur." });
    }

    await pool.query(
      `UPDATE v_b_users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1`,
      [id]
    );

    res.json({ success: true, mfa_enabled: false, mfa_pending_setup: false });
  } catch (err) {
    console.error("DELETE /users/:id/mfa", err);
    res.status(500).json({ error: "Erreur lors de la réinitialisation MFA" });
  }
});

// ───────────────────────────────────────────────
// 📧 PATCH /:id/email — Modifier l'email
// ───────────────────────────────────────────────
router.patch(
  "/:id/email",
  verifyJWT,
  [
    param("id").isUUID(),
    body("email").isEmail(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { id } = req.params;
    const { email } = req.body;

    if (req.user.id !== id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Non autorisé à modifier cet email." });
    }

    try {
      const target = await pool.query(
        `SELECT id, role, contact_id FROM v_b_users WHERE id = $1`,
        [id]
      );
      if (target.rows.length === 0) {
        return res.status(404).json({ error: "Utilisateur introuvable." });
      }

      const row = target.rows[0];
      if (String(row.role || "").toLowerCase() === "client") {
        const emailTaken = await findPortalUserByEmail(email, row.contact_id);
        if (emailTaken) {
          return res.status(409).json({ error: "Cet email est déjà utilisé par un autre compte." });
        }
      }

      await pool.query("UPDATE v_b_users SET email = $1 WHERE id = $2", [email, id]);

      if (row.contact_id) {
        await pool.query("UPDATE v_b_contacts SET email = $1 WHERE id = $2", [email, row.contact_id]);
      }

      res.json({ success: true });
    } catch (err) {
      if (err.code === "23505") {
        return res.status(409).json({ error: "Cet email est déjà utilisé." });
      }
      res.status(500).json({ error: "Erreur lors de la mise à jour de l'email" });
    }
  }
);

export default router;
