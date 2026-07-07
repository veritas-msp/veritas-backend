import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../database/db.js";
import { upsertUserSetting } from "./userSettingsStore.js";

export const USER_AVATAR_SETTING_KEY = "avatar";
export const TICKET_HELPDESK_DISPLAY_NAME_KEY = "ticket_helpdesk_display_name";

export const PRESET_AVATAR_IDS = [
  "blue",
  "green",
  "orange",
  "purple",
  "rose",
  "slate",
  "teal",
  "amber",
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AVATAR_UPLOAD_ROOT = path.join(__dirname, "..", "uploads", "avatars");

function parseJsonValue(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseUserAvatarSetting(raw) {
  const parsed = parseJsonValue(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const type = String(parsed.type || "").toLowerCase();
  if (type === "preset") {
    const presetId = String(parsed.presetId || "").toLowerCase();
    if (!PRESET_AVATAR_IDS.includes(presetId)) return null;
    return { type: "preset", presetId };
  }
  if (type === "upload") {
    const url = String(parsed.url || "").trim();
    if (!url.startsWith("/uploads/avatars/")) return null;
    return { type: "upload", url };
  }
  return null;
}

export function attachUserAvatar(row) {
  if (!row) return row;
  const avatar = parseUserAvatarSetting(row.avatar_setting_raw ?? row.avatar_setting);
  const next = { ...row };
  delete next.avatar_setting_raw;
  delete next.avatar_setting;
  return avatar ? { ...next, avatar } : next;
}

export function buildAvatarPublicPath(userId, filename) {
  return `/uploads/avatars/${userId}/${filename}`;
}

export async function upsertUserAvatarSetting(userId, avatar) {
  if (!userId) return;
  if (!avatar) {
    await pool.query(
      `DELETE FROM v_b_users_settings WHERE user_id = $1 AND setting_key = $2`,
      [userId, USER_AVATAR_SETTING_KEY]
    );
    return;
  }
  await upsertUserSetting(userId, USER_AVATAR_SETTING_KEY, avatar);
}

export async function loadAvatarsByUserIds(userIds = []) {
  const unique = [...new Set(userIds.filter(Boolean).map(String))];
  const map = new Map();
  if (!unique.length) return map;

  const { rows } = await pool.query(
    `SELECT u.id, av.setting_value AS avatar_setting_raw
     FROM v_b_users u
     LEFT JOIN v_b_users_settings av
       ON av.user_id = u.id AND av.setting_key = $2
     WHERE u.id::text = ANY($1::text[])`,
    [unique, USER_AVATAR_SETTING_KEY]
  );

  rows.forEach((row) => {
    const avatar = parseUserAvatarSetting(row.avatar_setting_raw);
    if (avatar) map.set(String(row.id), avatar);
  });
  return map;
}

export async function loadAuthorProfilesByUserIds(userIds = []) {
  const unique = [...new Set(userIds.filter(Boolean).map(String))];
  const map = new Map();
  if (!unique.length) return map;

  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.email, u.role,
            hs.setting_value AS helpdesk_name_raw,
            av.setting_value AS avatar_setting_raw
     FROM v_b_users u
     LEFT JOIN v_b_users_settings hs
       ON hs.user_id = u.id AND hs.setting_key = $2
     LEFT JOIN v_b_users_settings av
       ON av.user_id = u.id AND av.setting_key = $3
     WHERE u.id::text = ANY($1::text[])`,
    [unique, TICKET_HELPDESK_DISPLAY_NAME_KEY, USER_AVATAR_SETTING_KEY]
  );

  rows.forEach((row) => {
    const helpdeskRaw = parseJsonValue(row.helpdesk_name_raw);
    const helpdeskName =
      typeof helpdeskRaw === "string"
        ? helpdeskRaw.trim()
        : helpdeskRaw != null
        ? String(helpdeskRaw).trim()
        : "";
    const isClient = String(row.role || "").toLowerCase() === "client";
    const displayName = isClient
      ? row.username || row.email || "Client"
      : helpdeskName || row.username || row.email || "Agent";
    const avatar = parseUserAvatarSetting(row.avatar_setting_raw);
    map.set(String(row.id), {
      id: row.id,
      username: row.username,
      email: row.email,
      role: row.role,
      display_name: displayName,
      avatar: avatar || null,
    });
  });
  return map;
}

export function ensureAvatarUploadDir(userId) {
  const dir = path.join(AVATAR_UPLOAD_ROOT, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function validatePresetAvatarId(presetId) {
  return PRESET_AVATAR_IDS.includes(String(presetId || "").toLowerCase());
}
