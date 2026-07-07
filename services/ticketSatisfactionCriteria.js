/** Critères de notation client (portail) — clés stables en base. */
export const TICKET_SATISFACTION_CRITERIA = [
  {
    key: "responsiveness",
    label: "Réactivité",
    hint: "Rapidité de prise en charge et suivi de votre demande",
  },
  {
    key: "solution_quality",
    label: "Qualité de la solution",
    hint: "Pertinence et efficacité de la résolution apportée",
  },
  {
    key: "communication",
    label: "Communication",
    hint: "Clarté, écoute et courtoisie des échanges",
  },
  {
    key: "professionalism",
    label: "Professionnalisme",
    hint: "Expertise et attitude de l'équipe support",
  },
  {
    key: "overall",
    label: "Impression globale",
    hint: "Votre satisfaction générale sur cette demande",
  },
];

export const TICKET_SATISFACTION_CRITERIA_KEYS = TICKET_SATISFACTION_CRITERIA.map((c) => c.key);

export function normalizeSatisfactionRatingsInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const normalized = {};
  for (const { key } of TICKET_SATISFACTION_CRITERIA) {
    const value = Number(raw[key]);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return null;
    }
    normalized[key] = value;
  }
  return normalized;
}

export function buildLegacyRatingsFromRating(rating) {
  const value = Math.max(1, Math.min(5, Number(rating) || 0));
  if (!value) return null;
  return Object.fromEntries(TICKET_SATISFACTION_CRITERIA_KEYS.map((key) => [key, value]));
}

export function resolveStoredRatings(row) {
  if (!row) return null;
  const raw = row.ratings;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const parsed = normalizeSatisfactionRatingsInput(raw);
    if (parsed) return parsed;
  }
  return buildLegacyRatingsFromRating(row.rating);
}

export function computeSatisfactionAverage(ratings) {
  if (!ratings) return 0;
  const values = TICKET_SATISFACTION_CRITERIA_KEYS.map((key) => Number(ratings[key])).filter(
    (v) => Number.isInteger(v) && v >= 1 && v <= 5
  );
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
}

export function formatSatisfactionRatingsSummary(ratings) {
  if (!ratings) return "";
  return TICKET_SATISFACTION_CRITERIA.map(({ key, label }) => `${label} ${ratings[key]}/5`).join(" · ");
}
