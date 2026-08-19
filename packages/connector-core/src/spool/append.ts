/**
 * The hot path, and the whole point of the redesign.
 *
 * An append takes no lock, repairs nothing and truncates nothing. It writes to
 * the file of ITS OWN session, which nothing renames, rewrites or truncates.
 *
 * That session's hooks are the normal writer of that file, not the only one:
 * recovery appends to files it does not own. `rescueTail` puts bytes it read
 * off an unlinked inode back onto another session's path (reap.ts), and the
 * re-append inside `appendThroughHandle` recreates whichever file reap unlinked
 * under it (write.ts) — reap and flush reach that path too, for sessions that
 * are not theirs. Every one of them is an O_APPEND write exactly like this one,
 * which is why an extra writer costs a reader nothing.
 *
 * The one thing that can still happen to that file is `reap` DELETING it, and
 * an append whose open landed before the unlink writes to an inode with no
 * name. That much is settled inside the write itself: one `fstat` on the handle
 * afterwards, and a re-append when the bytes went to an unlinked inode
 * (write.ts). An append that finishes just before the unlink cannot see the
 * problem at all, and is put back by reap instead (`rescueTail`). Reap's own
 * conditions make both rare; they do not prevent either.
 *
 * Over the cap, an append REFUSES rather than making room. Refusing is a
 * visible outcome (a line in the `.drops` ledger and `persisted: false`);
 * making room meant rewriting a file that other processes were appending to,
 * which is the defect class this design removes.
 */
import { MAX_SPOOL_BYTES } from "../constants.ts";
import { sessionSlug, spoolDataPath } from "../config/paths.ts";
import { sizeOf } from "./files.ts";
import { serialize } from "./lines.ts";
import { recordDrop } from "./drops.ts";
import type { DropReason } from "./drops.ts";
import { appendOnce } from "./write.ts";

export interface AppendResult {
  /** True only when every record is in the file this path names. */
  readonly persisted: boolean;
  /** Records this call put in the `.drops` ledger instead of the spool. */
  readonly dropped: number;
}

const PERSISTED_NOTHING: AppendResult = { persisted: true, dropped: 0 };

/**
 * Terminates the fragment a short write left behind so the NEXT record starts
 * on a clean line instead of being glued to it. This is best effort, and it is
 * deliberately not a truncate: cutting the file back would cut away a
 * concurrent appender's record that landed behind ours.
 *
 * Residual risk, and how it is closed: if this newline does not land either, a
 * later record can still be glued to the fragment. That produces ONE complete
 * line that is not JSON, and `flush` counts exactly that in `.drops` before it
 * moves the cursor past it. The record is then counted, never silently gone.
 */
const LINE_TERMINATOR = "\n";

const refuse = async (
  home: string,
  key: string,
  slug: string,
  count: number,
  reason: DropReason,
  now: Date,
): Promise<AppendResult> => {
  await recordDrop(home, key, slug, count, reason, now);
  return { persisted: false, dropped: count };
};

/**
 * Every record write goes to the spool first (spec §E) so an unreachable hub
 * costs nothing but disk. On disk awaiting flush, delivered to the hub, or
 * COUNTED as a drop: there is no fourth outcome. The count normally lands in
 * the session's `.drops` ledger; when that append fails too it lands in
 * `unrecorded.dropmarker` instead, which is what keeps a failed ledger write
 * from quietly reporting below the truth (drops.ts).
 */
export const appendRecords = async (
  home: string,
  key: string,
  hostSessionKey: string,
  records: readonly unknown[],
  now: Date,
): Promise<AppendResult> => {
  if (records.length === 0) {
    return PERSISTED_NOTHING;
  }
  const slug = sessionSlug(hostSessionKey);
  const path = spoolDataPath(home, key, slug);
  if ((await sizeOf(path)) >= MAX_SPOOL_BYTES) {
    return refuse(home, key, slug, records.length, "cap", now);
  }

  const payload = serialize(records.map((record) => JSON.stringify(record)));
  const outcome = await appendOnce(path, payload);
  if (outcome === "written") {
    return PERSISTED_NOTHING;
  }
  if (outcome === "short") {
    await appendOnce(path, LINE_TERMINATOR);
    return refuse(home, key, slug, records.length, "short-write", now);
  }
  return refuse(home, key, slug, records.length, "write-failed", now);
};