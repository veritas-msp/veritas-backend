export const SLA_SETTINGS_SECTION = "sla";
export const SLA_SETTINGS_KEY = "sla_settings_json";

export const SLA_TIME_MODES = ["calendar", "business_hours", "business_days"];

export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const WEEKDAY_LABELS = {
  0: "Dimanche",
  1: "Lundi",
  2: "Mardi",
  3: "Mercredi",
  4: "Jeudi",
  5: "Vendredi",
  6: "Samedi",
};

export function createDefaultWeekSchedule() {
  return WEEKDAY_ORDER.map((day) => ({
    day,
    enabled: day >= 1 && day <= 5,
    open: "09:00",
    close: "18:00",
  }));
}

export const DEFAULT_SLA_SETTINGS = {
  timeMode: "calendar",
  timezone: "Europe/Paris",
  weekSchedule: createDefaultWeekSchedule(),
};

function parseJsonObject(value, fallback = {}) {
  if (!value) return { ...fallback };
  if (typeof value === "object") return { ...fallback, ...value };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function normalizeTime(value, fallback = "09:00") {
  const raw = String(value || fallback).trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeSlaSettings(input = {}) {
  const source = parseJsonObject(input, {});
  const defaults = createDefaultWeekSchedule();
  const byDay = new Map(defaults.map((row) => [row.day, { ...row }]));

  for (const row of Array.isArray(source.weekSchedule) ? source.weekSchedule : []) {
    const day = Number(row?.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    const open = normalizeTime(row.open, byDay.get(day)?.open || "09:00");
    const close = normalizeTime(row.close, byDay.get(day)?.close || "18:00");
    byDay.set(day, {
      day,
      enabled: Boolean(row.enabled),
      open,
      close: parseHHMM(close) > parseHHMM(open) ? close : open,
    });
  }

  const timeMode = SLA_TIME_MODES.includes(source.timeMode) ? source.timeMode : DEFAULT_SLA_SETTINGS.timeMode;
  const timezone =
    typeof source.timezone === "string" && source.timezone.trim()
      ? source.timezone.trim()
      : DEFAULT_SLA_SETTINGS.timezone;

  return {
    timeMode,
    timezone,
    weekSchedule: WEEKDAY_ORDER.map((day) => byDay.get(day) || defaults.find((r) => r.day === day)),
  };
}

export function parseHHMM(str) {
  const [h, m] = String(str || "00:00").split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

export function formatWeekScheduleSummary(settings) {
  const normalized = normalizeSlaSettings(settings);
  const openDays = normalized.weekSchedule.filter((row) => row.enabled);
  if (!openDays.length) return "Aucun jour ouvré";
  const first = openDays[0];
  const sameHours = openDays.every((row) => row.open === first.open && row.close === first.close);
  const days = openDays.map((row) => WEEKDAY_LABELS[row.day]).join(", ");
  if (sameHours) return `${days} · ${first.open}–${first.close}`;
  return days;
}
