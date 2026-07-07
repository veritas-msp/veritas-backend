import { normalizeSlaSettings, parseHHMM } from "./slaSettings.js";

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function getZonedDateParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = {};
  for (const piece of dtf.formatToParts(date)) {
    if (piece.type !== "literal") parts[piece.type] = piece.value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dayOfWeek: WEEKDAY_MAP[parts.weekday],
  };
}

function addCalendarDays(year, month, day, delta) {
  const anchor = new Date(Date.UTC(year, month - 1, day + delta));
  return {
    year: anchor.getUTCFullYear(),
    month: anchor.getUTCMonth() + 1,
    day: anchor.getUTCDate(),
  };
}

export function buildDateInTimeZone(year, month, day, hour, minute, timeZone) {
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const parts = getZonedDateParts(utc, timeZone);
    const diffMinutes =
      (year - parts.year) * 525600 +
      (month - parts.month) * 43200 +
      (day - parts.day) * 1440 +
      (hour - parts.hour) * 60 +
      (minute - parts.minute);

    if (diffMinutes === 0) break;
    utc = new Date(utc.getTime() + diffMinutes * 60 * 1000);
  }

  return utc;
}

function getScheduleRow(settings, dayOfWeek) {
  return settings.weekSchedule.find((row) => row.day === dayOfWeek);
}

function setZonedMinutesFromMidnight(anchorDate, timeZone, minutesFromMidnight) {
  const parts = getZonedDateParts(anchorDate, timeZone);
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  return buildDateInTimeZone(parts.year, parts.month, parts.day, hour, minute, timeZone);
}

function findNextEnabledDayStart(parts, settings) {
  for (let offset = 1; offset <= 14; offset += 1) {
    const next = addCalendarDays(parts.year, parts.month, parts.day, offset);
    const row = getScheduleRow(settings, getZonedDateParts(
      buildDateInTimeZone(next.year, next.month, next.day, 12, 0, settings.timezone),
      settings.timezone
    ).dayOfWeek);
    if (row?.enabled) {
      const open = parseHHMM(row.open);
      return buildDateInTimeZone(
        next.year,
        next.month,
        next.day,
        Math.floor(open / 60),
        open % 60,
        settings.timezone
      );
    }
  }
  return buildDateInTimeZone(parts.year, parts.month, parts.day + 1, 9, 0, settings.timezone);
}

export function alignToBusinessStart(startDate, settingsInput) {
  const settings = normalizeSlaSettings(settingsInput);
  let current = new Date(startDate);
  if (Number.isNaN(current.getTime())) return null;

  for (let guard = 0; guard < 400; guard += 1) {
    const parts = getZonedDateParts(current, settings.timezone);
    const row = getScheduleRow(settings, parts.dayOfWeek);
    if (!row?.enabled) {
      current = findNextEnabledDayStart(parts, settings);
      continue;
    }

    const open = parseHHMM(row.open);
    const close = parseHHMM(row.close);
    const minutes = parts.hour * 60 + parts.minute;

    if (minutes < open) {
      return setZonedMinutesFromMidnight(current, settings.timezone, open);
    }
    if (minutes < close) {
      return current;
    }
    current = findNextEnabledDayStart(parts, settings);
  }

  return current;
}

export function addBusinessMinutes(startDate, minutesToAdd, settingsInput) {
  const settings = normalizeSlaSettings(settingsInput);
  if (!minutesToAdd || minutesToAdd <= 0) return new Date(startDate);

  let current = alignToBusinessStart(startDate, settings);
  let remaining = Math.ceil(minutesToAdd);
  let guard = 0;

  while (remaining > 0 && guard < 200000) {
    guard += 1;
    const parts = getZonedDateParts(current, settings.timezone);
    const row = getScheduleRow(settings, parts.dayOfWeek);

    if (!row?.enabled) {
      current = findNextEnabledDayStart(parts, settings);
      continue;
    }

    const open = parseHHMM(row.open);
    const close = parseHHMM(row.close);
    let minutes = parts.hour * 60 + parts.minute;

    if (minutes < open) {
      current = setZonedMinutesFromMidnight(current, settings.timezone, open);
      minutes = open;
    }

    if (minutes >= close) {
      current = findNextEnabledDayStart(parts, settings);
      continue;
    }

    const available = close - minutes;
    const consume = Math.min(remaining, available);
    remaining -= consume;
    current = new Date(current.getTime() + consume * 60 * 1000);

    if (remaining > 0) {
      const after = getZonedDateParts(current, settings.timezone);
      current = findNextEnabledDayStart(after, settings);
    }
  }

  return current;
}

export function addBusinessDays(startDate, daysToAdd, settingsInput) {
  const settings = normalizeSlaSettings(settingsInput);
  const days = Math.max(0, Number(daysToAdd) || 0);
  if (!days) return new Date(startDate);

  let current = alignToBusinessStart(startDate, settings);
  let remaining = Math.ceil(days);

  while (remaining > 0) {
    const parts = getZonedDateParts(current, settings.timezone);
    const row = getScheduleRow(settings, parts.dayOfWeek);
    if (row?.enabled) {
      const close = parseHHMM(row.close);
      current = setZonedMinutesFromMidnight(current, settings.timezone, close);
      remaining -= 1;
    }
    if (remaining > 0) {
      current = findNextEnabledDayStart(parts, settings);
    }
  }

  return current;
}

export function addCalendarHours(startDate, hours) {
  const date = new Date(startDate);
  if (Number.isNaN(date.getTime())) return null;
  date.setTime(date.getTime() + Number(hours || 0) * 60 * 60 * 1000);
  return date;
}

export function computeSlaDueAt({ startDate, amount, settingsInput }) {
  const settings = normalizeSlaSettings(settingsInput);
  const start = new Date(startDate);
  const value = Number(amount);
  if (Number.isNaN(start.getTime()) || !value) return null;

  if (settings.timeMode === "business_days") {
    return addBusinessDays(start, value, settings);
  }
  if (settings.timeMode === "business_hours") {
    return addBusinessMinutes(start, value * 60, settings);
  }
  return addCalendarHours(start, value);
}
