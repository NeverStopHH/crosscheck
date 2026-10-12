/**
 * THE RESTS A SESSIONEND BOOKED WITHOUT ITS LOCK (final review of batch 2,
 * N10). SessionEnd books every recheck the session still owes; when the
 * state lock stays busy past its patience it books from an unlocked read
 * (review batch 2, M8) and the delete after it falls back the same way — but
 * a hook cut between the two leaves the state on disk with the rests it just
 * booked, and the reaper that finds the corpse a week later books them once
 * more. `rest_unchecked` is local (M3), so the hub never sees it; doctor and
 * status over-count by the rests.
 *
 * The booking leaves this marker beside the state: its own file, no lock —
 * the lock is exactly what was not to be had — naming the life whose rests
 * were booked. The reaper honours it for that life only (a resumed life
 * carries debts of its own) and removes it with the state; SessionEnd's own
 * delete removes it too, and a stale one is swept with the lineage notes
 * (state/session-lineage.ts). Written AFTER the booking: a cut between the
 * two leaves an over-count, never an unbooked debt.
 */
import { z } from "zod";

import { readJsonOrNull, removeFile, sessionRestsBookedPathForSlug, sessionSlug, writePrivateFile } from "../config/paths.ts";

const RestsBookedSchema = z.looseObject({
  crosscheckSessionId: z.string().min(1),
  count: z.number().int().min(0),
  at: z.string().min(1),
});

const pathOf = (home: string, hostSessionKey: string): string =>
  sessionRestsBookedPathForSlug(home, sessionSlug(hostSessionKey));

/** Fail-open: a marker that could not be written costs an over-count, never a booking. */
export const markOwedRestsBooked = async (
  home: string,
  hostSessionKey: string,
  crosscheckSessionId: string,
  count: number,
  now: Date,
): Promise<boolean> => {
  try {
    await writePrivateFile(pathOf(home, hostSessionKey), `${JSON.stringify({ crosscheckSessionId, count, at: now.toISOString() })}\n`);
    return true;
  } catch {
    return false;
  }
};

/** Whether the rests of this very life were booked by its SessionEnd already. */
export const wereOwedRestsBooked = async (home: string, hostSessionKey: string, crosscheckSessionId: string): Promise<boolean> => {
  const parsed = RestsBookedSchema.safeParse(await readJsonOrNull(pathOf(home, hostSessionKey)));
  return parsed.success && parsed.data.crosscheckSessionId === crosscheckSessionId;
};

export const removeOwedRestsBooked = (home: string, hostSessionKey: string): Promise<void> => removeFile(pathOf(home, hostSessionKey));
