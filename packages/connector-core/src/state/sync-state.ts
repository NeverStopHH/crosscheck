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
 * timestamps, where a lost update costs a slightly stale age, never a count.
 */
export const SyncStateSchema = z.looseObject({
  lastSyncAt: z.string().nullable().default(null),
  lastOkAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
});

export type SyncState = z.infer<typeof SyncStateSchema>;

export const EMPTY_SYNC_STATE: SyncState = {
  lastSyncAt: null,
  lastOkAt: null,
  lastError: null,
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
