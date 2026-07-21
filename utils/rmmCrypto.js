import crypto from "crypto";
const TOKEN_CIPHER_ALGO = "aes-256-gcm";
const TOKEN_CIPHER_SALT = "veritas-rmm-enrollment-token";
let tokenCipherKey = null;
function getTokenCipherKey() {
  if (tokenCipherKey) return tokenCipherKey;
  const secret = process.env.RMM_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) return null;
  tokenCipherKey = crypto.scryptSync(secret, TOKEN_CIPHER_SALT, 32);
  return tokenCipherKey;
}
export function hashRmmSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
export function generateRmmToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}
export function encryptRmmToken(plainToken) {
  const key = getTokenCipherKey();
  if (!key || !plainToken) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(TOKEN_CIPHER_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainToken), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}
export function decryptRmmToken(encoded) {
  const key = getTokenCipherKey();
  if (!key || !encoded) return null;
  try {
    const buffer = Buffer.from(encoded, "base64");
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const encrypted = buffer.subarray(28);
    const decipher = crypto.createDecipheriv(TOKEN_CIPHER_ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
export function mapEnrollmentTokenRow(row) {
  if (!row) return row;
  return {
    ...row,
    token: decryptRmmToken(row.token_encrypted) || null
  };
}
