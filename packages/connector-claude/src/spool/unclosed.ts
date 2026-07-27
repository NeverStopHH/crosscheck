/**
 * Sessions whose deferred `end` was never delivered, counted once the marker
 * that carried it aged out.
 *
 * A `.pending-end` marker is the one spool artifact that is not bytes waiting
 * to be sent — it is an intent: "tell the hub this session finished". Data
 * files age out by mtime and drop ledgers by their newest entry, and until this
 * existed markers aged out by nothing at all, so a hub that stayed slow left one
 * behind per session for good.
 *
 * Expiry must not make the FACT disappear, for the same reason the drop ledger
 * keeps its total: nothing marks either as seen, so age alone would quietly
 * discard the evidence that a session was never properly closed. The marker file
 * goes; what it stood for is folded into one line per repo that `doctor` reads.
 *
 * Rewritten in place rather than appended to, which is safe for exactly the
 * reason `archive.dropsummary` is: only `reap` writes it, only under the flush
 * lock, so there is no concurrent append to orphan.
 */
import { z } from "zod";

import {
  readJsonOrNull,
  spoolUnclosedPath,
  writePrivateFile,
} from "../config/paths.ts";

const UnclosedSchema = z.looseObject({
  /** When the newest retired marker was written by SessionEnd. */
  at: z.string().min(1),
  /** When the oldest one was. */
  oldestAt: z.string().min(1),
  sessions: z.number().int().min(0),
});

export interface UnclosedSummary {
  /** Sessions whose end this connector admits it never delivered. */
  readonly sessions: number;
  /** When the oldest of them was deferred, or null when there are none. */
  readonly oldestAt: string | null;
  /** When the newest of them was deferred, or null when there are none. */
  readonly latestAt: string | null;
}

const NONE: UnclosedSummary = {
  sessions: 0,
  oldestAt: null,
  latestAt: null,
};

export const readUnclosedSummary = async (
  home: string,
  key: string,
): Promise<UnclosedSummary> => {
  const parsed = UnclosedSchema.safeParse(
    await readJsonOrNull(spoolUnclosedPath(home, key)),
  );
  if (!parsed.success) {
    return NONE;
  }
  return {
    sessions: parsed.data.sessions,
    oldestAt: parsed.data.oldestAt,
    latestAt: parsed.data.at,
  };
};

const earlier = (left: string | null, right: string): string =>
  left === null || right < left ? right : left;

const later = (left: string | null, right: string): string =>
  left === null || right > left ? right : left;

/**
 * Adds one retired marker to the repo's count.
 *
 * `deferredAt` is when SessionEnd wrote the marker, never when it expired: the
 * question a developer asks of this number is how long a session has been
 * hanging open on the hub, and the answer is measured from the end that never
 * landed. `doctor` renders exactly that age, so the caller owes this function
 * one meaning and one only — `reap` resolves it from the stamp the marker
 * carries, falling back to the marker's own mtime, which is the same moment
 * because nothing rewrites a marker after SessionEnd writes it (reap.ts).
 *
 * Compared as strings, which orders correctly because every stamp on this path
 * is `Date#toISOString` — fixed width, UTC, zero-padded.
 */
export const recordUnclosedSession = async (
  home: string,
  key: string,
  deferredAt: Date,
): Promise<void> => {
  const stamp = deferredAt.toISOString();
  const current = await readUnclosedSummary(home, key);
  await writePrivateFile(
    spoolUnclosedPath(home, key),
    `${JSON.stringify({
      at: later(current.latestAt, stamp),
      oldestAt: earlier(current.oldestAt, stamp),
      sessions: current.sessions + 1,
    })}\n`,
  );
};
