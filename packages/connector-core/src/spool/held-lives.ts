/**
 * ANOTHER LOCAL LIFE THE HUB HAS NOT REGISTERED, HELD ON DISK (review-2
 * MEDIUM-1).
 *
 * A flush drains the whole repo spool under its own session, and every other
 * session's backlog goes where its body says. That is right for a life the hub
 * knows, and wrong for one it does not: a live conversation whose register and
 * SessionStart heal were refused had its work context and targets delivered by
 * the other conversation's flush, refused by the hub ("session not found",
 * "work context not found"), and spent — before its own heal, five minutes
 * later, could register it. Those records were the life's whole first window.
 *
 * So a flush leaves such a life's records where they are: from that life's
 * first record on, its spool is not this flusher's to send. The flusher's own
 * records, and every other spool, still go — a hold never blocks the drain.
 *
 * BOUNDED BY THE LIFE AND BY AGE. The hold lasts while the life is live (its
 * state file names it) and unregistered (state/session-state.ts
 * `unregistered`): its heal clears the flag and delivers them under its own
 * name, its end deletes the state and they go to whichever flusher comes next,
 * every refusal counted. And a held record older than MAX_SPOOL_AGE_DAYS is
 * not kept past the bound every spool obeys: it is counted `expired` and
 * passed over — never silent.
 */
import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "../constants.ts";
import { readJsonOrNull, sessionStatePathForSlug } from "../config/paths.ts";
import type { SessionSpool } from "./files.ts";
import { lineTimestampMs } from "./lines.ts";

/** What of one spool a flusher may do now. */
export interface Deliverable {
  readonly spool: SessionSpool;
  /** Lines from the head that may be sent: up to the held life's first record. */
  readonly lines: number;
  /** Held lines at the head past the age bound: counted expired, not sent. */
  readonly expired: number;
}

/** The live, unregistered life a spool's host session is on — unless it is the flusher. */
const heldLifeOf = async (home: string, slug: string, flusherSessionId: string): Promise<string | null> => {
  const state = (await readJsonOrNull(sessionStatePathForSlug(home, slug))) as {
    crosscheckSessionId?: unknown;
    unregistered?: unknown;
  } | null;
  const lifeId = state?.crosscheckSessionId;
  return typeof lifeId === "string" && state?.unregistered === true && lifeId !== flusherSessionId
    ? lifeId
    : null;
};

/** The session that wrote a spooled line, as its envelope says. */
const writerOf = (line: string): unknown => {
  try {
    return (JSON.parse(line) as { producer?: { sessionId?: unknown } } | null)?.producer?.sessionId;
  } catch {
    return undefined;
  }
};

/** At most the next `limit` lines of the spool: what one batch could take. */
export const deliverableOf = async (
  home: string,
  spool: SessionSpool,
  flusherSessionId: string,
  now: Date,
  limit: number,
): Promise<Deliverable> => {
  const head = spool.lines.slice(0, limit);
  const held = await heldLifeOf(home, spool.slug, flusherSessionId);
  const firstHeld = held === null ? -1 : head.findIndex((line) => writerOf(line) === held);
  if (firstHeld !== 0) {
    return { spool, lines: firstHeld === -1 ? head.length : firstHeld, expired: 0 };
  }
  const cutoffMs = now.getTime() - MAX_SPOOL_AGE_DAYS * MS_PER_DAY;
  const young = head.findIndex(
    (line) => writerOf(line) !== held || (lineTimestampMs(line) ?? spool.mtimeMs) >= cutoffMs,
  );
  return { spool, lines: 0, expired: young === -1 ? head.length : young };
};
