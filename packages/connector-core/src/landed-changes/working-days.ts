/**
 * "Recent", for a landed change the reader already has: at most
 * LANDED_RECENT_WORKING_DAYS working days ago (docs/1.0/landed-changes.md,
 * decision 2).
 *
 * COUNTED ON CALENDAR DATES IN THE READER'S TIMEZONE, never as a number of
 * hours. "Landed yesterday" is a statement about the reader's calendar: a
 * change merged at 01:30 Berlin time on Wednesday landed on Wednesday for a
 * reader in Berlin, whatever UTC says. And a weekend does not age a change —
 * Monday to Friday count, Saturday and Sunday do not. Public holidays are not
 * known here and count as working days; that errs toward mentioning a change,
 * never toward hiding one the reader is missing (missing changes are never
 * windowed at all).
 */
import { LANDED_RECENT_WORKING_DAYS } from "../constants.ts";
import type { Env } from "../config/paths.ts";

const DAY_MS = 86_400_000;
const SUNDAY = 0;
const SATURDAY = 6;
/**
 * Days walked before the answer is certainly "more than the window": far
 * above any window this module is asked about, so the loop is bounded for a
 * timestamp from the distant past without changing any answer that matters.
 */
const MAX_DAYS_WALKED = 31;

const dayFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const fields = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", { ...fields, timeZone });
  } catch {
    // An unknown zone name is a configuration fault, not a reason to fail an
    // edit: the machine's own zone is the reader's best-known calendar.
    return new Intl.DateTimeFormat("en-CA", fields);
  }
};

/** Midnight UTC of the instant's calendar date in the formatter's zone. */
const calendarDay = (instant: Date, formatter: Intl.DateTimeFormat): number =>
  Date.parse(`${formatter.format(instant)}T00:00:00Z`);

const isWorkingDay = (dayMs: number): boolean => {
  const weekday = new Date(dayMs).getUTCDay();
  return weekday !== SATURDAY && weekday !== SUNDAY;
};

/**
 * Working days strictly after the landing day, up to and including today.
 * A landing ahead of the reader's clock is zero, never negative.
 */
export const workingDaysSince = (landedAt: Date, now: Date, timeZone: string): number => {
  const formatter = dayFormatter(timeZone);
  const today = calendarDay(now, formatter);
  const landedDay = calendarDay(landedAt, formatter);
  if (Number.isNaN(today) || Number.isNaN(landedDay)) {
    return Number.POSITIVE_INFINITY;
  }
  const days = Array.from(
    { length: Math.min(MAX_DAYS_WALKED, Math.max(0, Math.round((today - landedDay) / DAY_MS))) },
    (_, index) => landedDay + (index + 1) * DAY_MS,
  );
  return days.filter(isWorkingDay).length;
};

/** The reader's calendar day, `2026-09-24` — part of what a cached answer is keyed on. */
export const localDayKey = (now: Date, timeZone: string): string => dayFormatter(timeZone).format(now);

export const isRecentLanding = (landedAt: Date, now: Date, timeZone: string): boolean =>
  workingDaysSince(landedAt, now, timeZone) <= LANDED_RECENT_WORKING_DAYS;

const wallClockFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const fields = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", { ...fields, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-CA", fields);
  }
};

/** How far the zone's wall clock is ahead of UTC at `instantMs`. */
const zoneOffsetMs = (instantMs: number, formatter: Intl.DateTimeFormat): number => {
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(formatter.formatToParts(instantMs).find((p) => p.type === type)?.value ?? Number.NaN);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return wall - Math.floor(instantMs / 1000) * 1000;
};

/**
 * The instant the zone's calendar day `dayMs` (a UTC-midnight stamp of that
 * date) begins. Two passes, so a day that starts inside a daylight-saving
 * change still lands on its own midnight.
 */
const zonedMidnight = (dayMs: number, timeZone: string): Date => {
  const formatter = wallClockFormatter(timeZone);
  const first = dayMs - zoneOffsetMs(dayMs, formatter);
  return new Date(dayMs - zoneOffsetMs(first, formatter));
};

/**
 * The first instant that still counts as recent: local midnight of the
 * earliest calendar day a landing on which is at most the window's working
 * days old. What `isRecentLanding` answers per instant, this answers once,
 * so git can be asked for the window itself rather than a guess around it.
 */
export const recentWindowStart = (now: Date, timeZone: string): Date => {
  const today = calendarDay(now, dayFormatter(timeZone));
  const inWindow = Array.from({ length: MAX_DAYS_WALKED }, (_, index) => today - index * DAY_MS).filter(
    (day) =>
      Array.from({ length: Math.round((today - day) / DAY_MS) }, (_, index) => day + (index + 1) * DAY_MS).filter(
        isWorkingDay,
      ).length <= LANDED_RECENT_WORKING_DAYS,
  );
  return zonedMidnight(Math.min(...inWindow), timeZone);
};

/**
 * The reader's timezone: `TZ` when the environment sets one, otherwise the
 * machine's. The hook runs on the reader's machine, so this IS the reader's
 * calendar — not the hub's, and not the teammate's.
 */
export const resolveTimeZone = (env: Env): string =>
  env["TZ"] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
