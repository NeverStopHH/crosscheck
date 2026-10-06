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

import { readJsonOrNull, sessionStatePathForSlug } from "../config/paths.ts";
import { isPastReapBound } from "../state/session-reap.ts";
import type { SessionSpool } from "./files.ts";

/** Who a spool belongs to, as one flusher sees it. */
export type SpoolOwner = "own" | "ended" | "abandoned" | "live-elsewhere";

interface StateStamps {
  readonly crosscheckSessionId?: unknown;
  readonly startedAt?: unknown;
  readonly lastHeartbeatAt?: unknown;
}

const writtenAtMs = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * The spool's owner. A state file that will not parse still speaks for a
 * live writer until the file itself has been silent past the bound: refusing
 * to read it never hands its records to someone else.
 */
export const ownerOf = async (
  home: string,
  slug: string,
  flusherSessionId: string,
  now: Date,
): Promise<SpoolOwner> => {
  const path = sessionStatePathForSlug(home, slug);
  const wroteAtMs = await writtenAtMs(path);
  if (wroteAtMs === null) {
    return "ended";
  }
  const state = (await readJsonOrNull(path)) as StateStamps | null;
  if (state?.crosscheckSessionId === flusherSessionId) {
    return "own";
  }
  const stamps = {
    startedAt: typeof state?.startedAt === "string" ? state.startedAt : "",
    lastHeartbeatAt: typeof state?.lastHeartbeatAt === "string" ? state.lastHeartbeatAt : null,
  };
  return isPastReapBound(stamps, wroteAtMs, now.getTime()) ? "abandoned" : "live-elsewhere";
};

/** Whether this flusher may send the spool's records at all. */
export const mayFlusherSend = async (
  home: string,
  spool: SessionSpool,
  flusherSessionId: string,
  now: Date,
): Promise<boolean> => (await ownerOf(home, spool.slug, flusherSessionId, now)) !== "live-elsewhere";

/**
 * Records that wait for their own conversation, another live session, which
 * no other flusher sends — what doctor says while there are any. Doctor is
 * no session's flusher, so every live session counts.
 */
export const countRecordsAwaitingOwners = async (
  home: string,
  spools: readonly SessionSpool[],
  now: Date,
): Promise<number> => {
  let records = 0;
  for (const spool of spools) {
    if ((await ownerOf(home, spool.slug, "", now)) === "live-elsewhere") {
      records += spool.lines.length;
    }
  }
  return records;
};
