/**
 * WHOSE RECORDS A FLUSH MAY SEND — the ownership rule (review-2 round 7).
 *
 * A flush drains the repo's spool under its own session, and it used to send
 * every host session's backlog. Six rounds of special cases followed from
 * that one fact: a live conversation's records delivered by ANOTHER
 * conversation's flusher — before their own life was registered, or without
 * the work context they were still owed — were refused, and spent as that
 * flusher's refusals. A hold on "unregistered" lives patched one shape of it
 * and opened others: a mark that never cleared, an hour of silence that
 * released a life still alive, a healing flusher that re-sent another life's
 * records without the work context they needed.
 *
 * So a flusher sends only:
 *   - its OWN host session's spool — the one whose state names its life;
 *   - an ENDED host session's — no state file: SessionEnd ran, or reap took a
 *     corpse;
 *   - an ABANDONED host session's — a state silent past the bound session-reap
 *     deletes on (state/session-reap.ts isPastReapBound).
 * Another LIVE conversation's spool is never this flusher's: that
 * conversation delivers its own records, heals its own life and pays its own
 * work context, and no other conversation can spend them.
 */
import { stat } from "node:fs/promises";

import { readJsonOrNull, repoKey, sessionStatePathForSlug } from "../config/paths.ts";
import { isPastReapBound } from "../state/session-reap.ts";
import type { SessionSpool } from "./files.ts";
import { isAbsence } from "./ledger-read.ts";
import { stampReleased } from "./release.ts";

/**
 * Who a spool belongs to, as one flusher sees it. `unreadable`: a state file
 * is there and cannot be looked at (review-2 round 8, L4) — a live writer's
 * for all this flusher knows, so held like one, and doctor says so.
 */
export type SpoolOwner = "own" | "ended" | "abandoned" | "live-elsewhere" | "unreadable";

interface StateStamps {
  readonly crosscheckSessionId?: unknown;
  readonly startedAt?: unknown;
  readonly lastHeartbeatAt?: unknown;
  readonly hubUrl?: unknown;
  readonly repoId?: unknown;
}

/**
 * Whether the state binds its conversation to ANOTHER repo than this spool's
 * (review-2 round 8, M2): resumed from another checkout, it flushes that repo
 * from now on and never this one, and its records here would wait for it for
 * good — reap expires nothing while a state exists.
 */
const isBoundElsewhere = (state: StateStamps | null, key: string): boolean =>
  typeof state?.hubUrl === "string" && typeof state.repoId === "string" && repoKey(state.hubUrl, state.repoId) !== key;

/**
 * The state file's last write; null when there is no file. ONLY ABSENCE IS AN
 * ENDED CONVERSATION (review-2 round 8, L4): a stat that failed for any other
 * reason — EACCES, EIO — read as "ended" handed a live conversation's records
 * to whichever flusher came next.
 */
const writtenAtMs = async (path: string): Promise<number | null | "unreadable"> => {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    return isAbsence(error) ? null : "unreadable";
  }
};

/**
 * The owner of the spool `slug` in the repo `key`. A state file that will not
 * parse still speaks for a live writer until the file itself has been silent
 * past the bound: refusing to read it never hands its records to someone
 * else. A state bound to another repo is over for this one.
 */
export const ownerOf = async (
  home: string,
  key: string,
  slug: string,
  flusherSessionId: string,
  now: Date,
): Promise<SpoolOwner> => {
  const path = sessionStatePathForSlug(home, slug);
  const wroteAtMs = await writtenAtMs(path);
  if (wroteAtMs === null) {
    return "ended";
  }
  if (wroteAtMs === "unreadable") {
    return "unreadable";
  }
  const state = (await readJsonOrNull(path)) as StateStamps | null;
  if (state?.crosscheckSessionId === flusherSessionId) {
    return "own";
  }
  if (isBoundElsewhere(state, key)) {
    return "ended";
  }
  const stamps = {
    startedAt: typeof state?.startedAt === "string" ? state.startedAt : "",
    lastHeartbeatAt: typeof state?.lastHeartbeatAt === "string" ? state.lastHeartbeatAt : null,
  };
  return isPastReapBound(stamps, wroteAtMs, now.getTime()) ? "abandoned" : "live-elsewhere";
};

/**
 * Whether this flusher may send the spool's records at all. The first send of
 * an abandoned host's spool is its release, and is stamped so (spool/release.ts):
 * reap's expiry clock starts there.
 */
export const mayFlusherSend = async (
  home: string,
  key: string,
  spool: SessionSpool,
  flusherSessionId: string,
  now: Date,
): Promise<boolean> => {
  const owner = await ownerOf(home, key, spool.slug, flusherSessionId, now);
  if (owner === "abandoned") {
    await stampReleased(home, key, spool.slug, now);
  }
  return owner === "own" || owner === "ended" || owner === "abandoned";
};

/** Records no flusher but their own conversation's sends, as doctor says them. */
export interface AwaitingOwners {
  /** Another live session's: its own flush sends them. */
  readonly records: number;
  /** Held for a conversation whose state file cannot be looked at (L4): nothing sends them until it can. */
  readonly unreadableRecords: number;
}

/**
 * Records that wait for their own conversation, which no other flusher sends
 * — what doctor says while there are any. Doctor is no session's flusher, so
 * every live session counts.
 */
export const countRecordsAwaitingOwners = async (
  home: string,
  key: string,
  spools: readonly SessionSpool[],
  now: Date,
): Promise<AwaitingOwners> => {
  const owners = await Promise.all(spools.map((spool) => ownerOf(home, key, spool.slug, "", now)));
  const recordsOf = (owner: SpoolOwner): number =>
    spools.reduce((total, spool, index) => total + (owners[index] === owner ? spool.lines.length : 0), 0);
  return { records: recordsOf("live-elsewhere"), unreadableRecords: recordsOf("unreadable") };
};
