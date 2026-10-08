/**
 * WHEN A SPOOL WAS RELEASED (review-2 round 8, H2).
 *
 * A live conversation's spool is its own (spool/ownership.ts); it goes to every
 * flusher once its host session is over — the state deleted at SessionEnd, the
 * state reaped as stale, or the state silent past the bound (abandoned). Reap
 * expired a spool whose data file was MAX_SPOOL_AGE_DAYS old, and a dead host's
 * data file is exactly that old at the moment it is released as abandoned: the
 * first successor SessionStart reaped the corpse's state, the next one expired
 * the backlog that successor had not sent yet — 2605 of 3000 records in the
 * review's probe, counted, but lost all the same.
 *
 * So a release is stamped, once, and a released spool's expiry clock starts
 * there (spool/reap.ts): it has the full bound of successor hooks to go out. A
 * spool its own SessionEnd released is stamped by nothing, and expires as it
 * always did, from its last write — which is no earlier than its end.
 *
 * Best-effort, like every ledger write on a hook path: a stamp that does not
 * land costs that spool the old clock, never a record.
 */
import { z } from "zod";

import { readJsonOrNull, removeFile, spoolDataPath, spoolReleasedPath, writePrivateFile } from "../config/paths.ts";
import { ledgerMs } from "./ledger-read.ts";

const ReleasedSchema = z.looseObject({ at: z.string().min(1) });

/**
 * Stamps the spool released now, unless it was already — the first release is
 * when its clock started — or there is no spool to time: a stamp with no data
 * file beside it would start a later spool of the same name on an old clock.
 */
export const stampReleased = async (home: string, key: string, slug: string, now: Date): Promise<void> => {
  const path = spoolReleasedPath(home, key, slug);
  if ((await Bun.file(path).exists()) || !(await Bun.file(spoolDataPath(home, key, slug)).exists())) {
    return;
  }
  try {
    await writePrivateFile(path, `${JSON.stringify({ at: now.toISOString() })}\n`);
  } catch {
    // Best-effort, as above.
  }
};

/** When the spool was released, or null when no release was stamped (or the stamp will not read). */
export const releasedAtMs = async (home: string, key: string, slug: string): Promise<number | null> => {
  const parsed = ReleasedSchema.safeParse(await readJsonOrNull(spoolReleasedPath(home, key, slug)));
  return parsed.success ? ledgerMs(parsed.data.at) : null;
};

/** The stamp goes with the spool it timed. */
export const removeReleaseStamp = async (home: string, key: string, slug: string): Promise<void> => {
  await removeFile(spoolReleasedPath(home, key, slug));
};
