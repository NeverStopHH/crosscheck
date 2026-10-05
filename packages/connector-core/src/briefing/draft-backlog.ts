/**
 * THE OWN-DRAFTS BACKLOG, counted once for every surface that tells it — the
 * briefing's own-drafts section, the draft review nudge, doctor's `sharing`
 * line. Not a render module: it turns a hub listing into numbers and never
 * touches text.
 *
 * WHAT THE HUB GIVES: at most DRAFT_LISTING_CAP rows, NEWEST FIRST, plus — a
 * current hub — the backlog's exact `total` and its oldest draft's capture
 * instant. Newest-first is what makes the counts below exact rather than
 * guessed: every row the listing left out is at least as old as the oldest
 * row it kept, so once one listed row is past an age, every unlisted row is
 * too. Only the case where no listed row is past it and the oldest is leaves
 * a count unknown, and that count is then "at least 1" — the oldest itself.
 *
 * An older hub sends no totals. A listing SHORTER than the cap is still the
 * whole backlog, so its numbers are exact; one AT the cap is a floor, and
 * every count over it says "at least".
 */
import {
  DRAFT_LISTING_CAP,
  DRAFT_NUDGE_MIN_AGE_HOURS,
  DRAFT_RETENTION_HORIZON_DAYS,
  HOURS_PER_DAY,
  MS_PER_DAY,
} from "../constants.ts";
import type { DraftEntry, DraftListing } from "../http/hub.ts";

/** A draft is DUE once it has waited DRAFT_NUDGE_MIN_AGE_HOURS. */
export const DRAFT_DUE_AGE_MS = (DRAFT_NUDGE_MIN_AGE_HOURS * MS_PER_DAY) / HOURS_PER_DAY;
/** Past this a draft is named as old — and kept (binding principle 6). */
export const DRAFT_HORIZON_AGE_MS = DRAFT_RETENTION_HORIZON_DAYS * MS_PER_DAY;

export interface DraftBacklog {
  /** The hub's rows, newest first. */
  readonly listed: readonly DraftEntry[];
  /** The exact backlog size, or null when an older hub cut the listing at its cap. */
  readonly total: number | null;
  /** The oldest draft's capture instant, when known. */
  readonly oldestCreatedAt: string | null;
}

/** A count that is exact, or a floor ("at least"). */
export interface DraftCount {
  readonly count: number;
  readonly floor: boolean;
}

const createdMs = (entry: DraftEntry): number | null => {
  const ms = Date.parse(entry.createdAt);
  return Number.isNaN(ms) ? null : ms;
};

const oldestListed = (drafts: readonly DraftEntry[]): string | null => {
  const instants = drafts.flatMap((entry) => {
    const ms = createdMs(entry);
    return ms === null ? [] : [ms];
  });
  return instants.length === 0 ? null : new Date(Math.min(...instants)).toISOString();
};

export const backlogOf = (listing: DraftListing): DraftBacklog => {
  const complete = listing.drafts.length < DRAFT_LISTING_CAP;
  return {
    listed: listing.drafts,
    // A total smaller than the rows it came with is a hub contradicting
    // itself; the rows are the fact in hand, so they win.
    total:
      listing.total !== null
        ? Math.max(listing.total, listing.drafts.length)
        : complete
          ? listing.drafts.length
          : null,
    oldestCreatedAt: listing.oldestCreatedAt ?? (complete ? oldestListed(listing.drafts) : null),
  };
};

/** The listed rows captured at least `ageMs` before `now`, in the hub's order. */
export const listedAtLeastAged = (
  backlog: DraftBacklog,
  ageMs: number,
  now: Date,
): readonly DraftEntry[] =>
  backlog.listed.filter((entry) => {
    const ms = createdMs(entry);
    return ms !== null && now.getTime() - ms >= ageMs;
  });

/** Age of the oldest draft, when known. */
export const oldestAgeMs = (backlog: DraftBacklog, now: Date): number | null => {
  const ms = backlog.oldestCreatedAt === null ? Number.NaN : Date.parse(backlog.oldestCreatedAt);
  return Number.isNaN(ms) ? null : now.getTime() - ms;
};

/** The whole backlog's size. */
export const backlogSize = (backlog: DraftBacklog): DraftCount =>
  backlog.total === null
    ? { count: backlog.listed.length, floor: true }
    : { count: backlog.total, floor: false };

/** How many drafts of the WHOLE backlog were captured at least `ageMs` ago. */
export const countAtLeastAged = (backlog: DraftBacklog, ageMs: number, now: Date): DraftCount => {
  const listed = listedAtLeastAged(backlog, ageMs, now).length;
  if (backlog.total === null) {
    // The rows the older hub cut are older still, but how many is unknown.
    return { count: listed, floor: listed > 0 };
  }
  const unlisted = backlog.total - backlog.listed.length;
  if (unlisted === 0) {
    return { count: listed, floor: false };
  }
  if (listed > 0) {
    return { count: listed + unlisted, floor: false };
  }
  const oldest = oldestAgeMs(backlog, now);
  return oldest !== null && oldest >= ageMs ? { count: 1, floor: true } : { count: 0, floor: false };
};

export const amountOf = (count: DraftCount): string =>
  `${count.floor ? "at least " : ""}${String(count.count)}`;
