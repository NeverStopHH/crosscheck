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
 *
 * AND THE MARK DOES NOT STICK (review-2 round 6, HIGH-2). A register the hub
 * committed but answered too late reads as refused; the life's own accepted
 * records and its answered heartbeats clear the mark (`forgetUnregistered`,
 * flows/heartbeat.ts). A life whose state has said nothing for
 * STALE_SESSION_STATE_MS — the hour doctor calls a state file a corpse — is
 * not held at all: a host that died without SessionEnd must not pin its
 * backlog for a week.
 */
import { stat } from "node:fs/promises";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "../constants.ts";
import { readJsonOrNull, sessionStatePathForSlug } from "../config/paths.ts";
import type { IngestSummary } from "../http/hub.ts";
import { sessionSilentForMs } from "../state/session-scan.ts";
import { STALE_SESSION_STATE_MS, markLifeRegistered } from "../state/session-state.ts";
import { lineEnds, readCountedLines } from "./cursor.ts";
import type { SessionSpool } from "./files.ts";
import { lineTimestampMs } from "./lines.ts";
import { isTaken } from "./owed-work-context.ts";

/** What of one spool a flusher may do now. */
export interface Deliverable {
  readonly spool: SessionSpool;
  /** The life whose records stay where they are, or null when none is held. */
  readonly held: string | null;
  /**
   * Lines of the next batch this flusher may settle: every line, or — while a
   * life is held — every line of ANOTHER life not settled yet (review-2 round
   * 6, LOW-4): a straggler an older life wrote behind the held life's first
   * record goes now, and is noted so it never goes twice.
   */
  readonly lines: number;
  /** Held lines at the head past the age bound: counted expired, not sent. */
  readonly expired: number;
}

interface MarkedState {
  readonly crosscheckSessionId?: unknown;
  readonly unregistered?: unknown;
  readonly startedAt?: unknown;
  readonly lastHeartbeatAt?: unknown;
}

const readMarkedState = async (home: string, slug: string): Promise<MarkedState | null> =>
  (await readJsonOrNull(sessionStatePathForSlug(home, slug))) as MarkedState | null;

const writtenAtMs = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
};

/** Whether the state has said nothing — no heartbeat, no write — for STALE_SESSION_STATE_MS. */
const isSilent = async (home: string, slug: string, state: MarkedState, now: Date): Promise<boolean> => {
  const silentMs = sessionSilentForMs(
    {
      startedAt: typeof state.startedAt === "string" ? state.startedAt : "",
      lastHeartbeatAt: typeof state.lastHeartbeatAt === "string" ? state.lastHeartbeatAt : null,
    },
    await writtenAtMs(sessionStatePathForSlug(home, slug)),
    now.getTime(),
  );
  return silentMs !== null && silentMs > STALE_SESSION_STATE_MS;
};

/** The live, unregistered life a spool's host session is on — unless it is the flusher, or silent. */
const heldLifeOf = async (
  home: string,
  slug: string,
  flusherSessionId: string,
  now: Date,
): Promise<string | null> => {
  const state = await readMarkedState(home, slug);
  const lifeId = state?.crosscheckSessionId;
  if (state === null || typeof lifeId !== "string" || state.unregistered !== true || lifeId === flusherSessionId) {
    return null;
  }
  return (await isSilent(home, slug, state, now)) ? null : lifeId;
};

/** The host session a spool slug belongs to; null for a name no slug is. */
const hostSessionKeyOf = (slug: string): string | null => {
  try {
    return decodeURIComponent(slug);
  } catch {
    return null;
  }
};

/**
 * The hub took a record this batch delivered under `producerId`: it knows
 * that life, so the mark on the spool's state goes when it names it.
 */
export const forgetUnregistered = async (
  home: string,
  slug: string,
  producerId: string,
  summary: IngestSummary,
): Promise<void> => {
  const tookOne =
    summary.results === undefined ? summary.accepted + summary.duplicates > 0 : summary.results.some(isTaken);
  if (!tookOne) {
    return;
  }
  const state = await readMarkedState(home, slug);
  const hostSessionKey = hostSessionKeyOf(slug);
  if (state?.unregistered === true && state.crosscheckSessionId === producerId && hostSessionKey !== null) {
    await markLifeRegistered(home, hostSessionKey, producerId);
  }
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
  const held = await heldLifeOf(home, spool.slug, flusherSessionId, now);
  if (held === null) {
    return { spool, held, lines: head.length, expired: 0 };
  }
  const cutoffMs = now.getTime() - MAX_SPOOL_AGE_DAYS * MS_PER_DAY;
  const young = head.findIndex(
    (line) => writerOf(line) !== held || (lineTimestampMs(line) ?? spool.mtimeMs) >= cutoffMs,
  );
  const expired = young === -1 ? head.length : young;
  if (expired > 0) {
    return { spool, held, lines: 0, expired };
  }
  const settled = await readCountedLines(spool.cursorPath, spool);
  const ends = lineEnds(spool.pending, head.length, spool.offset);
  const free = head.filter((line, index) => writerOf(line) !== held && !settled.has(ends[index] ?? -1));
  return { spool, held, lines: free.length, expired: 0 };
};

/** Whether a spooled line was written by the life a hold is for. */
export const isHeldLine = (held: string | null, line: string): boolean => held !== null && writerOf(line) === held;

/** What doctor says while a hold exists: how many records, and when the first of them expires. */
export interface HeldRecords {
  readonly records: number;
  /** When the oldest held record passes MAX_SPOOL_AGE_DAYS and is counted `expired`; null when none is held. */
  readonly expiresAt: string | null;
}

/** Every record held for a live life the hub has not registered, across the repo's spools. */
export const readHeldRecords = async (
  home: string,
  spools: readonly SessionSpool[],
  now: Date,
): Promise<HeldRecords> => {
  let records = 0;
  let oldestMs: number | null = null;
  for (const spool of spools) {
    const held = await heldLifeOf(home, spool.slug, "", now);
    if (held === null) {
      continue;
    }
    for (const line of spool.lines) {
      if (writerOf(line) !== held) {
        continue;
      }
      records += 1;
      const atMs = lineTimestampMs(line) ?? spool.mtimeMs;
      oldestMs = oldestMs === null ? atMs : Math.min(oldestMs, atMs);
    }
  }
  return {
    records,
    expiresAt: oldestMs === null ? null : new Date(oldestMs + MAX_SPOOL_AGE_DAYS * MS_PER_DAY).toISOString(),
  };
};
