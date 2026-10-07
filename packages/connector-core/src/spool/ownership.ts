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

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "../constants.ts";
import { readJsonOrNull, repoKey, sessionStatePathForSlug } from "../config/paths.ts";
import { isPastReapBound } from "../state/session-reap.ts";
import { sessionSilentForMs } from "../state/session-scan.ts";
import type { SessionSpool } from "./files.ts";
import { isAbsence } from "./ledger-read.ts";
import { lineTimestampMs } from "./lines.ts";
import { stampReleased } from "./release.ts";

/**
 * Who a spool belongs to, as one flusher sees it. `unreadable`: a state file
 * is there and cannot be looked at (review-2 round 8, L4) — a live writer's
 * for all this flusher knows, so held like one, and doctor says so.
 * `rebound`: a conversation now bound to another repo (M2), over for this one
 * like an ended one — told apart so doctor can say why its records wait.
 */
export type SpoolOwner = "own" | "ended" | "rebound" | "abandoned" | "live-elsewhere" | "unreadable";

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

/** A spool's owner, and — for another live session — how long it has been silent. */
interface OwnerSighting {
  readonly owner: SpoolOwner;
  /** state/session-scan.ts sessionSilentForMs, for `live-elsewhere`; null otherwise. */
  readonly silentMs: number | null;
}

const sighted = (owner: SpoolOwner): OwnerSighting => ({ owner, silentMs: null });

/**
 * The owner of the spool `slug` in the repo `key`. A state file that will not
 * parse still speaks for a live writer until the file itself has been silent
 * past the bound: refusing to read it never hands its records to someone
 * else. A state bound to another repo is over for this one.
 */
const sightOwner = async (
  home: string,
  key: string,
  slug: string,
  flusherSessionId: string,
  now: Date,
): Promise<OwnerSighting> => {
  const path = sessionStatePathForSlug(home, slug);
  const wroteAtMs = await writtenAtMs(path);
  if (wroteAtMs === null) {
    return sighted("ended");
  }
  if (wroteAtMs === "unreadable") {
    return sighted("unreadable");
  }
  const state = (await readJsonOrNull(path)) as StateStamps | null;
  if (state?.crosscheckSessionId === flusherSessionId) {
    return sighted("own");
  }
  if (isBoundElsewhere(state, key)) {
    return sighted("rebound");
  }
  const stamps = {
    startedAt: typeof state?.startedAt === "string" ? state.startedAt : "",
    lastHeartbeatAt: typeof state?.lastHeartbeatAt === "string" ? state.lastHeartbeatAt : null,
  };
  return isPastReapBound(stamps, wroteAtMs, now.getTime())
    ? sighted("abandoned")
    : { owner: "live-elsewhere", silentMs: sessionSilentForMs(stamps, wroteAtMs, now.getTime()) };
};

export const ownerOf = async (
  home: string,
  key: string,
  slug: string,
  flusherSessionId: string,
  now: Date,
): Promise<SpoolOwner> => (await sightOwner(home, key, slug, flusherSessionId, now)).owner;

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
  return owner === "own" || owner === "ended" || owner === "rebound" || owner === "abandoned";
};

/** Records no flusher but their own conversation's sends, as doctor says them. */
export interface AwaitingOwners {
  /** Another live session's: its own flush sends them. */
  readonly records: number;
  /** When the oldest of them was written (review-2 round 8, L9); null with none. */
  readonly oldestAtMs: number | null;
  /** How long the most recently heard of their owners has been silent; null with none. */
  readonly silentMs: number | null;
  /** When the last of them goes to any flusher if no owner is heard from again: the reap bound past its silence. */
  readonly releaseAtMs: number | null;
  /** A conversation's now bound to another repo (M2): this repo's next session sends them. */
  readonly reboundRecords: number;
  /** Held for a conversation whose state file cannot be looked at (L4): nothing sends them until it can. */
  readonly unreadableRecords: number;
}

/** When a spool's first waiting record was written: its own stamp, else the file's last write. */
const writtenAt = (spool: SessionSpool): number =>
  (spool.lines[0] === undefined ? null : lineTimestampMs(spool.lines[0])) ?? spool.mtimeMs;

const minOf = (values: readonly number[]): number | null => (values.length === 0 ? null : Math.min(...values));

/**
 * Records that wait for their own conversation, which no other flusher sends
 * — what doctor says while there are any. Doctor is no session's flusher, so
 * every live session counts. With them: how old the oldest is, how long their
 * owners have been silent, and when they are released if none is heard from
 * again (review-2 round 8, L9) — a crashed owner's records wait a week, and
 * "another live session" said nothing of that.
 */
export const countRecordsAwaitingOwners = async (
  home: string,
  key: string,
  spools: readonly SessionSpool[],
  now: Date,
): Promise<AwaitingOwners> => {
  const sightings = await Promise.all(spools.map((spool) => sightOwner(home, key, spool.slug, "", now)));
  const ownedBy = (owner: SpoolOwner): readonly SessionSpool[] =>
    spools.filter((spool, index) => spool.lines.length > 0 && sightings[index]?.owner === owner);
  const recordsOf = (owner: SpoolOwner): number => ownedBy(owner).reduce((total, spool) => total + spool.lines.length, 0);
  const silentMs = minOf(
    sightings.flatMap((sighting, index) =>
      sighting.owner === "live-elsewhere" && sighting.silentMs !== null && (spools[index]?.lines.length ?? 0) > 0
        ? [sighting.silentMs]
        : [],
    ),
  );
  return {
    records: recordsOf("live-elsewhere"),
    oldestAtMs: minOf(ownedBy("live-elsewhere").map(writtenAt)),
    silentMs,
    releaseAtMs: silentMs === null ? null : now.getTime() - silentMs + MAX_SPOOL_AGE_DAYS * MS_PER_DAY,
    reboundRecords: recordsOf("rebound"),
    unreadableRecords: recordsOf("unreadable"),
  };
};
