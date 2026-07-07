export const ADMIN_PASSWORD_MIN_LENGTH = 12;

const RULES = [
  {
    code: "TOO_SHORT",
    test: (password) => String(password || "").length >= ADMIN_PASSWORD_MIN_LENGTH,
  },
  {
    code: "MISSING_LOWERCASE",
    test: (password) => /[a-z]/.test(password),
  },
  {
    code: "MISSING_UPPERCASE",
    test: (password) => /[A-Z]/.test(password),
  },
  {
    code: "MISSING_DIGIT",
    test: (password) => /[0-9]/.test(password),
  },
  {
    code: "MISSING_SPECIAL",
    test: (password) => /[^A-Za-z0-9]/.test(password),
  },
];

export function validateStrongPassword(password) {
  const failed = RULES.filter((rule) => !rule.test(password)).map((rule) => rule.code);
  return { valid: failed.length === 0, codes: failed };
}

export const PORTAL_PASSWORD_MIN_LENGTH = 10;

/** Politique pour les comptes portail client : 10 caractères + lettre + chiffre. */
const PORTAL_RULES = [
  {
    code: "TOO_SHORT",
    test: (password) => String(password || "").length >= PORTAL_PASSWORD_MIN_LENGTH,
  },
  {
    code: "MISSING_LETTER",
    test: (password) => /[a-zA-Z]/.test(password),
  },
  {
    code: "MISSING_DIGIT",
    test: (password) => /[0-9]/.test(password),
  },
];

export function validatePortalPassword(password) {
  const failed = PORTAL_RULES.filter((rule) => !rule.test(password)).map((rule) => rule.code);
  return { valid: failed.length === 0, codes: failed };
}
