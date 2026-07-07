const ALLOWED_SEXE = new Set(["monsieur", "madame"]);

export function normalizeContactSexe(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).toLowerCase().trim();
  if (!raw) return null;
  if (["monsieur", "mr", "m.", "m", "homme", "masculin", "h"].includes(raw)) return "monsieur";
  if (["madame", "mme", "mme.", "mrs", "mlle", "femme", "féminin", "feminin", "f"].includes(raw)) {
    return "madame";
  }
  if (ALLOWED_SEXE.has(raw)) return raw;
  return null;
}
