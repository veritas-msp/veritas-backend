import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

function resolveEncryptionKey() {
  const key = String(process.env.ENCRYPTION_KEY || '').trim();
  if (key) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY is required in production');
  }
  console.warn('[encryption] ENCRYPTION_KEY missing — ephemeral development key (do not use in production)');
  return crypto.randomBytes(32).toString('hex');
}

const ENCRYPTION_KEY_FINAL = resolveEncryptionKey();
const ALGORITHM = 'aes-256-gcm';

/** Legacy derivation (scrypt + static salt) — kept for decrypting existing data. */
function deriveLegacyKey() {
  return crypto.scryptSync(ENCRYPTION_KEY_FINAL, 'salt', 32);
}

/** Current derivation: SHA-256 of the master key (sufficient entropy, no static salt). */
function deriveKey() {
  return crypto.createHash('sha256').update(ENCRYPTION_KEY_FINAL).digest();
}

function decryptWithKey(encryptedText, ivHex, authTagHex, key) {
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Encrypts a value with AES-256-GCM
 * @param {string} text - Plain text to encrypt
 * @returns {Object} Object containing encrypted text and IV
 */
export function encrypt(text) {
  if (!text) return null;

  try {
    const iv = crypto.randomBytes(16);
    const key = deriveKey();
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return {
      encrypted: encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex')
    };
  } catch (error) {
    throw new Error('Erreur lors du chiffrement des données');
  }
}

/**
 * Decrypts an AES-256-GCM encrypted value
 * @param {string} encryptedText - Encrypted text
 * @param {string} ivHex - IV in hexadecimal
 * @param {string} authTagHex - Authentication tag in hexadecimal
 * @returns {string} Decrypted plain text
 */
export function decrypt(encryptedText, ivHex, authTagHex) {
  if (!encryptedText || !ivHex || !authTagHex) return null;

  try {
    return decryptWithKey(encryptedText, ivHex, authTagHex, deriveKey());
  } catch {
    try {
      return decryptWithKey(encryptedText, ivHex, authTagHex, deriveLegacyKey());
    } catch {
      throw new Error('Erreur lors du déchiffrement des données');
    }
  }
}
