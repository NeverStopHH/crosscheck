/**
 * "Since when", as a caller may type it and as SQL needs it.
 *
 * Two spellings, both borrowed rather than invented: a RELATIVE window like
 * `14d` or `72h` (Jira's `-14d`, Linear's ISO-8601 durations, Slack's
 * `after:`) and a plain ISO date like `2026-08-01` (GitHub's `created:>=`).
 * Nothing else parses — no `last fortnight`, no `yesterday`, no operators —
 * because a filter grammar nobody can remember gets used wrong, and a window
 * parsed wrong silently answers a different question.
 *
 * THE CAP IS A REFUSAL, NOT A CLAMP, and that direction is the whole point.
 * Clamping a 400-day lookback to 365 would answer a NARROWER question than
 * the one asked, and nothing in the result would say so — work would simply
 * be missing. The refusal names the bound and names the alternative, which is
 * to omit the filter and search all of history.
 */
import { fitRefusal } from "./refusal.ts";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Longest lookback a single search may ask for. A year of team memory is far
 * past the 14-day decay half-life at which older work stops outranking fresh
 * work anyway (services/search.ts DECAY_HALF_LIFE_DAYS), and an unfiltered
 * search still reaches everything — so this bounds the FILTER, never the
 * corpus.
 *
 * VERIFY: bun -e 'const t=await import("./packages/server/src/services/time-window.ts");console.log(t.SEARCH_MAX_SINCE_DAYS)'
 * PRINTS: 365
 */
export const SEARCH_MAX_SINCE_DAYS = 365;

const RELATIVE_PATTERN = /^(\d{1,5})([dh])$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/;

export type SinceWindow =
  | { readonly ok: true; readonly since: Date }
  | { readonly ok: false; readonly reason: string };

/** One sentence, listing every form that works. Used by both refusals. */
const FORMS =
  "since takes a window like 14d or 72h, or an ISO date like 2026-08-01";

/**
 * Every sentence below is a hub refusal, and a hub refusal is quoted at
 * MAX_REFUSAL_CHARS by every connector — so these two, which have no list and
 * no echo to give back, simply have to BE short enough. Both were 201 and 204
 * characters and arrived cut; test/search-filters.test.ts now walks every
 * refusal this route can send and fails if one grows past the bound again.
 */
const tooOld = (): SinceWindow => ({
  ok: false,
  reason:
    `since may look back at most ${String(SEARCH_MAX_SINCE_DAYS)} days. Omit it ` +
    "to search all of history — a window is never narrowed for you, because " +
    "work missing from an answer with nothing saying so is worse than a refusal.",
});

const notAWindow = (term: string): SinceWindow => ({
  ok: false,
  // The one sentence here that echoes the caller: through the shared budget,
  // so a 40-character window term cannot push the forms off the end.
  reason: fitRefusal((echo) => `${FORMS}. ${echo} is neither.`, term),
});

/**
 * The instant a `since` filter means, or why it means nothing. Relative
 * windows are measured from `now` — the hub's clock, never the caller's, so
 * two agents asking for `14d` a second apart get the same answer.
 */
export const parseSinceWindow = (raw: string, now: Date): SinceWindow => {
  const term = raw.trim();
  const relative = RELATIVE_PATTERN.exec(term.toLowerCase());
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === "h" ? MS_PER_HOUR : MS_PER_DAY;
    if (amount < 1) {
      return {
        ok: false,
        reason: `since must look back at least one unit — ${FORMS}.`,
      };
    }
    const windowMs = amount * unitMs;
    if (windowMs > SEARCH_MAX_SINCE_DAYS * MS_PER_DAY) {
      return tooOld();
    }
    return { ok: true, since: new Date(now.getTime() - windowMs) };
  }
  if (!ISO_DATE_PATTERN.test(term)) {
    return notAWindow(term);
  }
  const parsedMs = Date.parse(term);
  if (Number.isNaN(parsedMs)) {
    return notAWindow(term);
  }
  /**
   * A DATE IS COMPARED AT DAY GRANULARITY, and only against the cap.
   *
   * `Date.parse` resolves a date-only term to midnight UTC, so on 2026-07-24
   * at 09:00 the term `2025-07-24` is 365 days and nine hours back — refused
   * by a sentence saying the limit is 365 days, while `365d`, the same window
   * spelled the other way, was accepted. The caller asked for a year and was
   * told a year is too far. Jira's JQL documents this exact mismatch and
   * answers it with startOfDay(); this is the same answer, applied to `now`
   * so the term the caller typed is never silently moved.
   *
   * The FUTURE check below keeps the instant, deliberately: flooring there
   * would let a date later today through, and a window starting after the
   * hits it is filtering can only answer "nothing".
   */
  const capFrom = term.includes("T")
    ? now.getTime()
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (parsedMs > now.getTime()) {
    return {
      ok: false,
      reason:
        "since must be in the past: a window starting in the future can only " +
        `answer "nothing", which reads as a fact about the team. ${FORMS}.`,
    };
  }
  if (capFrom - parsedMs > SEARCH_MAX_SINCE_DAYS * MS_PER_DAY) {
    return tooOld();
  }
  return { ok: true, since: new Date(parsedMs) };
};
