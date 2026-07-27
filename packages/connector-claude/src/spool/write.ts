/**
 * The ONLY way bytes are ever added to an append-only spool file — a session's
 * `.jsonl` data file or its `.drops` ledger. (The cursor, the two per-repo
 * aggregates and the `.pending-end` marker are whole-file writes through
 * `writePrivateFile`; nothing ever appends to those, which is why replacing
 * them atomically is safe and this path does not apply to them.)
 *
 * One `O_APPEND` write of the whole payload. POSIX makes that atomic with
 * respect to the file offset, so concurrent appenders interleave whole writes
 * and cannot overwrite each other. There is deliberately no lock, no repair and
 * no truncate here: every one of those existed to survive something else
 * RENAMING, REWRITING or TRUNCATING the file, and nothing does any of those to
 * a file this module appends to any more.
 *
 * What IS still done to a spool file is `reap` UNLINKING it, and an appender
 * whose open landed before that unlink writes to an inode with no name. The
 * `fstat` after the write is what detects exactly that, and it is the only
 * inode check on this path.
 *
 * Note what `open(path, "a")` does before the write: it CREATES the file when
 * it is missing, so a zero-length data file is a normal, expected state and
 * must never be read as "everything in it was delivered" (see reap.ts).
 */
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { PRIVATE_FILE_MODE } from "../constants.ts";
import { ensureDir } from "../config/paths.ts";
import { byteLength } from "./lines.ts";

type WriteOutcome =
  /** Every byte of the payload is in the file this path names. */
  | "written"
  /** Fewer bytes than asked for: the tail of the file is now a fragment. */
  | "short"
  /** Nothing could be opened or written at all. */
  | "failed";

/** Plus the one outcome only the writing handle can observe. */
type HandleOutcome =
  | WriteOutcome
  /** The bytes landed, but on an inode `reap` had already unlinked. */
  | "orphaned";

const writeWhole = async (
  handle: FileHandle,
  payload: string,
): Promise<HandleOutcome> => {
  const { bytesWritten } = await handle.write(payload);
  if (bytesWritten !== byteLength(payload)) {
    return "short";
  }
  // `nlink === 0` means the path this handle was opened through is gone: the
  // bytes are in an inode no `open` can reach by name again. Handles that were
  // already open still read it — reap's `rescueTail` is exactly such a handle,
  // which is why the recovery below is at-least-once.
  const { nlink } = await handle.stat();
  return nlink === 0 ? "orphaned" : "written";
};

/**
 * Writes the payload through an already-open handle and, if those bytes went to
 * an unlinked inode, appends them once more to the path — which recreates the
 * file.
 *
 * Re-appending is AT-LEAST-ONCE, not exactly-once. One reader can reach the
 * orphaned inode, and it is reap itself: `rescueTail` holds the data file open
 * across its own unlink and reads back whatever arrived after its last size
 * check (reap.ts). A write that lands in that gap is recovered twice — once
 * there, once here — and the record reaches the hub twice.
 *
 * Delivering twice is acceptable; losing the record is not, and it is the
 * direction with no recovery. Both copies are byte-identical, and both kinds
 * this connector sends dedup on a natural key server-side: `work_context` on
 * its primary key `id`, where an unchanged body returns `duplicate` with no
 * write and no event, and `target` on the primary key
 * (work_context_id, kind, value), which `onConflictDoNothing` turns into a
 * `duplicate` (server/src/services/record-handlers.ts; the full argument, kind
 * by kind, is in cursor.ts).
 *
 * What is exactly-once is delivery of these bytes relative to the CURSOR: reap
 * removes a data file only after finding its cursor at the file's size, so
 * everything it held had been delivered and our bytes went in after that check.
 * Reap's other removal branch, expiry, counts only the lines it read — ours were
 * not among them either. So the duplicate can only ever come from the recovery
 * race above, never from a re-delivery of something already sent.
 *
 * Separated from `appendOnce` so the orphan path can be exercised against a
 * real unlink, which needs the handle opened before reap runs.
 */
export const appendThroughHandle = async (
  handle: FileHandle,
  path: string,
  payload: string,
): Promise<WriteOutcome> => {
  const first = await writeWhole(handle, payload);
  if (first !== "orphaned") {
    return first;
  }
  const recreated = await open(path, "a", PRIVATE_FILE_MODE);
  try {
    const second = await writeWhole(recreated, payload);
    // Orphaned twice: the caller counts the batch rather than trying forever.
    return second === "orphaned" ? "failed" : second;
  } finally {
    await recreated.close();
  }
};

export const appendOnce = async (
  path: string,
  payload: string,
): Promise<WriteOutcome> => {
  if (payload.length === 0) {
    return "written";
  }
  try {
    await ensureDir(dirname(path));
    const handle = await open(path, "a", PRIVATE_FILE_MODE);
    try {
      return await appendThroughHandle(handle, path, payload);
    } finally {
      await handle.close();
    }
  } catch {
    return "failed";
  }
};