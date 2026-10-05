/**
 * THE DERIVE COUNTERS OF ENDED SESSIONS — the evidence `doctor`'s sharing
 * lines (derive/sharing.ts) read once the session that could answer is gone.
 *
 * Every derive outcome is booked into session state, and SessionEnd deletes
 * that file (flows/end-session.ts) — rightly, a state file that outlives its
 * session makes a spool unreapable. But it took the only record of WHY
 * nothing was drafted with it: a developer who ran `crosscheck doctor` after
 * closing the editor read "no live sessions" on every derive line, which is
 * exactly when somebody asks "why does my agent share nothing?". So the end
 * flow folds the session's DIGEST — counts and the already-sanitized, already
 * bounded last-failure strings, nothing else — into this per-repo file first.
 *
 * Bounded at DERIVE_HISTORY_MAX_SESSIONS, newest kept; `folded` counts every
 * session ever folded, so a reader can say "the last 20 of 57". Fail-open on
 * both ends like every counter file here: a corrupt file reads as empty and
 * the next fold replaces it, and a fold that cannot write costs the record,
 * never the session's end.
 */
import { z } from "zod";

import { DERIVE_HISTORY_MAX_SESSIONS } from "../constants.ts";
import {
  deriveHistoryLockPath,
  deriveHistoryPath,
  readJsonOrNull,
  writePrivateFile,
} from "../config/paths.ts";
import { digestOf } from "../derive/sharing.ts";
import type { DeriveDigest } from "../derive/sharing.ts";
import { withLock } from "../spool/lock.ts";
import { readSessionState } from "./session-state.ts";

const count = z.number().int().min(0).catch(0);
const said = z.string().nullable().catch(null);

const DigestSchema = z.object({
  stopTurnCount: count,
  summarizerFireCount: count,
  summarizerNoneCount: count,
  summarizerDraftCount: count,
  summarizerFailCount: count,
  summarizerLastFailure: said,
  summarizerRejectCount: count,
  summarizerUnreadableCount: count,
  summarizerNoSliceCount: count,
  summarizerLastNoSlice: said,
  intentFireCount: count,
  intentNoneCount: count,
  intentSetCount: count,
  intentFailCount: count,
  intentLastFailure: said,
});

const HistorySchema = z.object({
  folded: count,
  sessions: z.array(DigestSchema).catch([]),
});

export interface DeriveHistory {
  /** Every session ever folded here, including the ones the bound let go. */
  readonly folded: number;
  /** The newest DERIVE_HISTORY_MAX_SESSIONS digests, newest first. */
  readonly sessions: readonly DeriveDigest[];
}

const EMPTY_HISTORY: DeriveHistory = { folded: 0, sessions: [] };

export const readDeriveHistory = async (home: string, key: string): Promise<DeriveHistory> => {
  const parsed = HistorySchema.safeParse(await readJsonOrNull(deriveHistoryPath(home, key)));
  return parsed.success ? parsed.data : EMPTY_HISTORY;
};

const withSession = (history: DeriveHistory, digest: DeriveDigest): DeriveHistory => ({
  folded: history.folded + 1,
  sessions: [digest, ...history.sessions].slice(0, DERIVE_HISTORY_MAX_SESSIONS),
});

/** Folds the session's digest in; a session with no state file folds nothing. */
export const foldDeriveHistory = async (
  home: string,
  key: string,
  hostSessionKey: string,
): Promise<void> => {
  try {
    const state = await readSessionState(home, hostSessionKey);
    if (state === null) {
      return;
    }
    await withLock(deriveHistoryLockPath(home, key), undefined, async () => {
      const next = withSession(await readDeriveHistory(home, key), digestOf(state));
      await writePrivateFile(deriveHistoryPath(home, key), JSON.stringify(next));
    });
  } catch {
    // Fail open: the record is lost, the session's end is not.
  }
};
