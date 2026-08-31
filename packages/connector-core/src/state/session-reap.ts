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
  MAX_SPOOL_AGE_DAYS,
  MS_PER_DAY,
  SESSION_STATE_REAP_MAX_PER_RUN,
  SESSION_STATE_SCAN_MAX_FILES,
} from "../constants.ts";
import { readJsonOrNull, sessionSlug } from "../config/paths.ts";
import { listSessionStateFiles, sessionSilentForMs } from "./session-scan.ts";
import { SessionStateSchema } from "./session-state.ts";

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
  const maxAgeMs = MAX_SPOOL_AGE_DAYS * MS_PER_DAY;
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
    const ageMs = sessionSilentForMs(parsed.data, file.mtimeMs, now.getTime());
    if (ageMs === null || ageMs <= maxAgeMs) {
      continue;
    }
    try {
      await rm(file.path, { force: true });
      reaped += 1;
    } catch {
      // A file that will not go stays; the next SessionStart tries again.
    }
  }
  return reaped;
};
