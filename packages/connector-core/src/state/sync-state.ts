import { z } from "zod";

import { readJsonOrNull, syncStatePath, writePrivateFile } from "../config/paths.ts";

/**
 * The anti-silent-death record (DESIGN.md §10 risk 5): written after every hub
 * interaction, success or failure, and read by the statusline and `doctor`.
 *
 * Deliberately holds no counters. `spoolDepth` and `spoolDropped` used to live
 * here, and every hook read-modified-wrote them without a lock, so simultaneous
 * hooks lost each other's increments and `spoolDropped` reported BELOW the
 * truth. Both are now derived from the spool directory itself — depth by
 * counting pending lines, drops by summing the append-only `.drops` ledger —
 * which needs no lock to be exact. What remains here are last-writer-wins
 * timestamps (and one last-writer-wins status code), where a lost update costs
 * a slightly stale age or a slightly stale reason, never a count.
 */
export const SyncStateSchema = z.looseObject({
  lastSyncAt: z.string().nullable().default(null),
  lastOkAt: z.string().nullable().default(null),
  /**
   * The last time a CAPTURE call — register, heartbeat, records, end — reached
   * the hub (http/hub.ts marks exactly those four `capture: true`). Trial
   * finding #14/H5: `lastOkAt` above is stamped by EVERY ok request, doctor's
   * own reachability probe and the statusline's presence poll included, so a
   * surface that read it was reading what it had just written — `PASS last
   * sync 0s ago` printed beside hooks that had not fired in hours. This field
   * only moves when the hook path itself succeeded AND the hub did something
   * with what it sent, which is what makes the age non-tautological. The
   * second half is not pedantry: ingest answers HTTP 200 with `accepted:0,
   * rejected:N` for a session it believes has ended, so stamping on the
   * envelope alone left this field fresh through a session whose every record
   * was being discarded (review finding B2-07). `postRecords` therefore marks
   * itself with a predicate over the ingest summary, not a flag.
   *
   * `null` on every state file written before this field existed, and on a
   * machine whose hooks have never reached the hub — the two are told apart by
   * whether a live session state exists, not by this value (cli doctor's
   * checkLastSync).
   */
  lastCaptureOkAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  /**
   * HTTP status of the last failure, or null when the last call succeeded.
   *
   * `lastError` above is a `code: message` string, and the statusline was
   * pattern-free: it branched on `result.ok` alone and rendered a rejected api
   * key as `hub unreachable` (trial finding M4). The number is what lets the
   * CACHED statusline path — fresh presence cache, no live call — still say
   * "key rejected" rather than repeating a stale success.
   */
  lastErrorStatus: z.number().int().nullable().default(null),
  /**
   * Last `cursor_version` a Cursor sessionStart hook reported for this repo
   * (design §3.2) — `doctor`'s evidence that the observed Cursor build is one
   * whose hooks API exists (≥ 1.7). A last-writer-wins string like its
   * siblings: a lost update costs a slightly stale version, never a count.
   */
  cursorVersion: z.string().nullable().default(null),
});

export type SyncState = z.infer<typeof SyncStateSchema>;

export const EMPTY_SYNC_STATE: SyncState = {
  lastSyncAt: null,
  lastOkAt: null,
  lastCaptureOkAt: null,
  lastError: null,
  lastErrorStatus: null,
  cursorVersion: null,
};

export const readSyncState = async (
  home: string,
  key: string,
): Promise<SyncState> => {
  const parsed = SyncStateSchema.safeParse(
    await readJsonOrNull(syncStatePath(home, key)),
  );
  return parsed.success ? parsed.data : EMPTY_SYNC_STATE;
};

export const updateSyncState = async (
  home: string,
  key: string,
  patch: Partial<SyncState>,
): Promise<SyncState> => {
  const current = await readSyncState(home, key);
  const next: SyncState = { ...current, ...patch };
  await writePrivateFile(
    syncStatePath(home, key),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
};
