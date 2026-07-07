/**
 * v_b_events.start / end sont TIMESTAMP WITHOUT TIME ZONE :
 * on conserve l'horloge murale (Europe/Paris côté utilisateur), sans conversion UTC.
 */

const WALL_CLOCK_RE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(?:[zZ]|[+-]\d{2}:?\d{2})?$/;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatWallClockFromParts(year, month, day, hours, minutes, seconds = 0) {
  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * Normalise une entrée API en "YYYY-MM-DD HH:mm:ss" pour PostgreSQL.
 */
export function normalizePlanningEventDateInput(value) {
  if (value == null || value === "") return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return formatWallClockFromParts(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds()
    );
  }

  const str = String(value).trim();
  const match = str.match(WALL_CLOCK_RE);
  if (!match) {
    const parsed = new Date(str);
    if (Number.isNaN(parsed.getTime())) return null;
    return formatWallClockFromParts(
      parsed.getFullYear(),
      parsed.getMonth() + 1,
      parsed.getDate(),
      parsed.getHours(),
      parsed.getMinutes(),
      parsed.getSeconds()
    );
  }

  const [, datePart, hourMinute, secondsPart] = match;
  const seconds = secondsPart != null ? secondsPart : "00";
  return `${datePart} ${hourMinute}:${seconds}`;
}

export function isValidPlanningEventDateInput(value) {
  return normalizePlanningEventDateInput(value) != null;
}

export function comparePlanningEventDates(left, right) {
  const a = normalizePlanningEventDateInput(left);
  const b = normalizePlanningEventDateInput(right);
  if (!a || !b) return 0;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
