/**
 * Deleting session-state files whose sessions are long gone (trial finding M6).
 *
 * A state file is removed at SessionEnd and nowhere else, so every session
 * that was killed, whose terminal was closed, or whose SessionEnd ran out of
 * budget leaves one behind forever. The trial machine had 100, three quarters
 * of them past an hour old and half of them past a day.
 *
 * They are not inert. `spool/reap.ts isSessionLive` refuses to delete a spool
 * data file while its session's state file exists — deliberately, because an
 * appender may still be holding it — so 100 corpses pinned 100 delivered
 * `.jsonl` files (836-852 KB) that could never be reaped. The state files are
 * the thing to remove; the spools then go on the next pass.
 *
 * THE THRESHOLD IS MAX_SPOOL_AGE_DAYS, not the one-hour "stale" mark doctor
 * warns at, and the gap is deliberate. Doctor's line is a REPORT — an hour
 * without a heartbeat means nothing is capturing — while this is a DELETION,
 * and a deletion has to be certain. Seven days is the same bound every other
 * spool artifact obeys, and a session that has said nothing for a week has no
 * hook left that could write to it.
 */
import { rm } from "node:fs/promises";

import {
  CLOCK_SKEW_MS,
  MAX_SPOOL_AGE_DAYS,
  MS_PER_DAY,
  SESSION_STATE_REAP_MAX_PER_RUN,
  SESSION_STATE_SCAN_MAX_FILES,
} from "../constants.ts";
import { readJsonOrNull, repoKey, sessionSlug, spoolPendingEndPath } from "../config/paths.ts";
import { appendRecords } from "../spool/append.ts";
import { writeEndMarker } from "../spool/end-marker.ts";
import { stampReleased } from "../spool/release.ts";
import { lastWorkContextRecords } from "../spool/work-context-ack.ts";
import { listSessionStateFiles, sessionSilentForMs } from "./session-scan.ts";
import { lifeRungOf } from "./session-lineage.ts";
import { crosscheckSessionIdFor, SessionStateSchema, updateSessionState } from "./session-state.ts";
import type { SessionState } from "./session-state.ts";

const STATE_SUFFIX = ".json";

/**
 * Silent past the bound a deletion has to be certain of (header) — the one a
 * state file is reaped on, and the one past which a flush reads its host
 * session as abandoned rather than another live conversation
 * (spool/ownership.ts).
 */
export const isPastReapBound = (
  state: { readonly lastHeartbeatAt: string | null; readonly startedAt: string },
  wroteAtMs: number | null,
  nowMs: number,
): boolean => {
  const silentMs = sessionSilentForMs(state, wroteAtMs, nowMs);
  return silentMs !== null && silentMs > MAX_SPOOL_AGE_DAYS * MS_PER_DAY;
};

/**
 * THE LIFE'S LAST WORD, ON ITS END MARKER (review-2 round 8, M3, seed 10895):
 * a work context spooled or owed for the life goes with the title and status
 * the state held, read from its marker once the state is gone
 * (spool/owed-work-context.ts readLifeState) — without it, the copy spooled
 * at SessionStart put back the status set_intent had set since. The marker is
 * also its deferred end: reap ends the dead life on the hub once its backlog
 * is gone. One SessionEnd already wrote is never overwritten.
 *
 * ...AND THE LIFE'S EPOCH AND NEXT POSITION (review-2 round 9, M1 + M2): the
 * counter goes with the state, and a laptop asleep a week came back to a
 * state-less resume that put a fresh epoch — or the epoch of the life before
 * — onto this life, splitting its order or issuing its positions twice. The
 * end's position is the one past everything the counter handed out, as
 * SessionEnd's own is; a state-less register onto this life restores both
 * (flows/register-session.ts).
 */
const writeDownReapedLife = async (
  home: string,
  key: string,
  slug: string,
  state: SessionState,
  now: Date,
): Promise<void> => {
  const rung = lifeRungOf(crosscheckSessionIdFor(state.hostSessionKey), state.crosscheckSessionId);
  if (rung === null) {
    return;
  }
  const path = spoolPendingEndPath(home, key, slug, rung);
  if (await Bun.file(path).exists()) {
    return;
  }
  try {
    await writeEndMarker(path, {
      sessionId: state.crosscheckSessionId,
      at: now,
      ...(state.seqEpoch === null ? {} : { seq: { epoch: state.seqEpoch, n: state.eventSeq + 1 } }),
      standing: { workContextTitle: state.workContextTitle, workContextStatus: state.workContextStatus },
    });
    // ...and SessionEnd's last word, which a host that died never said: the
    // work context once more when the hub may be behind the state on it
    // (spool/work-context-ack.ts, L7) — spooled ahead of the end this marker
    // defers, and sent by whichever flusher drains the dead host's spool.
    const records = lastWorkContextRecords(state, now);
    if (records.length > 0) {
      await appendRecords(home, key, state.hostSessionKey, records, now);
    }
  } catch {
    // Best-effort: the state goes regardless, as it always did.
  }
};

/**
 * Whether the state's own stamp or its file's last write is dated past now
 * plus CLOCK_SKEW_MS (review-2 round 8, L5): written while the clock ran
 * ahead, it read as fresh until the clock caught up — a dead host's state
 * never reaped, its spool never released.
 */
const isDatedAhead = (state: SessionState, wroteAtMs: number, nowMs: number): boolean => {
  const boundMs = nowMs + CLOCK_SKEW_MS;
  const saidMs = Date.parse(state.lastHeartbeatAt ?? state.startedAt);
  return (!Number.isNaN(saidMs) && saidMs > boundMs) || wroteAtMs > boundMs;
};

/** The stamp, or the bound when it is later or unreadable. */
const atMost = (iso: string, boundMs: number): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) || ms > boundMs ? new Date(boundMs).toISOString() : iso;
};

/**
 * A STATE DATED AHEAD IS WRITTEN DOWN AT THE BOUND: its heartbeat clamped to
 * now plus CLOCK_SKEW_MS, and the file rewritten under its lock, so its
 * silence — what reaps it and releases its spool — runs from here.
 */
const clampDatedAhead = async (home: string, state: SessionState, now: Date): Promise<void> => {
  const boundMs = now.getTime() + CLOCK_SKEW_MS;
  await updateSessionState(home, state.hostSessionKey, (fresh) => ({
    ...fresh,
    lastHeartbeatAt: atMost(fresh.lastHeartbeatAt ?? fresh.startedAt, boundMs),
  }));
};

export interface StateReapOptions {
  /** Never reaped, whatever its age: the caller is mid-session inside it. */
  readonly keepHostSessionKey?: string;
  readonly maxFiles?: number;
}

/**
 * Removes at most SESSION_STATE_REAP_MAX_PER_RUN corpses and answers how many.
 *
 * BOUNDED PER RUN because this hangs off SessionStart, the hook whose latency
 * a developer feels most: a home with a hundred corpses drains over four
 * sessions instead of costing one session a hundred-file unlink storm. It runs
 * in the maintenance region after the briefing is already in hand, so the cost
 * it can impose is bounded work after the developer has their answer.
 *
 * Fail-open throughout: an unreadable file, an undatable one, or an unlink
 * that is refused all skip that file and cost nothing else.
 */
export const reapStaleSessionStates = async (
  home: string,
  now: Date,
  options: StateReapOptions = {},
): Promise<number> => {
  const listing = await listSessionStateFiles(
    home,
    options.maxFiles ?? SESSION_STATE_SCAN_MAX_FILES,
  );
  const keepName =
    options.keepHostSessionKey === undefined
      ? null
      : `${sessionSlug(options.keepHostSessionKey)}.json`;
  let reaped = 0;
  // Oldest first: `listSessionStateFiles` answers newest-first, and the files
  // worth spending this run's budget on are at the other end.
  for (const file of [...listing.files].reverse()) {
    if (reaped >= SESSION_STATE_REAP_MAX_PER_RUN) {
      break;
    }
    if (keepName !== null && file.name === keepName) {
      continue;
    }
    const parsed = SessionStateSchema.safeParse(await readJsonOrNull(file.path));
    if (!parsed.success) {
      continue;
    }
    if (isDatedAhead(parsed.data, file.mtimeMs, now.getTime())) {
      await clampDatedAhead(home, parsed.data, now);
      continue;
    }
    if (!isPastReapBound(parsed.data, file.mtimeMs, now.getTime())) {
      continue;
    }
    const key = repoKey(parsed.data.hubUrl, parsed.data.repoId);
    const slug = file.name.slice(0, -STATE_SUFFIX.length);
    // RELEASED NOW (review-2 round 8, H2): its spool goes to every flusher from
    // here, and reap's expiry clock starts here, not at its last write — which
    // is as old as this state, and would expire it at the next SessionStart.
    await stampReleased(home, key, slug, now);
    await writeDownReapedLife(home, key, slug, parsed.data, now);
    try {
      await rm(file.path, { force: true });
      reaped += 1;
    } catch {
      // A file that will not go stays; the next SessionStart tries again.
    }
  }
  return reaped;
};
