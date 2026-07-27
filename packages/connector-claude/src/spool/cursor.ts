/**
 * How many bytes of a session's spool the hub already has.
 *
 * Replacing this file atomically is safe in a way replacing a data file is not:
 * nothing ever APPENDS to a cursor, so a rename here cannot orphan anybody's
 * write. Delivery moves this number; it never moves the records.
 */
import { Buffer } from "node:buffer";
import { stat } from "node:fs/promises";
import { z } from "zod";

import { readJsonOrNull, writePrivateFile } from "../config/paths.ts";

const CursorSchema = z.looseObject({
  /**
   * Inode of the data file this offset belongs to. A file that `reap` removed
   * and a later append recreated has a different inode, so its stale cursor is
   * ignored rather than believed — which is why reap needs no cursor cleanup.
   */
  ino: z.number().int().min(0),
  offset: z.number().int().min(0),
});

const NOTHING_CONSUMED = 0;

interface FileFacts {
  readonly ino: number;
  readonly size: number;
}

const factsOf = async (path: string): Promise<FileFacts | null> => {
  try {
    const info = await stat(path);
    return { ino: info.ino, size: info.size };
  } catch {
    return null;
  }
};

/**
 * Zero unless the cursor provably belongs to the spool that is there now, and
 * describes a position that spool could actually have. Trusting a wrong offset
 * would skip records for good; re-sending records the hub already has costs a
 * `duplicate` in the ingest summary and nothing else.
 *
 * NOT because of the envelope id — the server never reads it. Ingest dispatches
 * on `kind`, `producer.developerId` and `producer.sessionId`
 * (server/src/services/records.ts), and each kind dedups on its own natural key
 * (server/src/services/record-handlers.ts). The two this connector sends:
 *   - `work_context`, keyed by `body.id`, which is `wc_` + the crosscheck
 *     session id and therefore identical on every re-send. The insert conflicts,
 *     the stored row is compared field by field, and an unchanged body returns
 *     `duplicate` without a write or an event.
 *   - `target`, keyed by the primary key (work_context_id, kind, value).
 *     `onConflictDoNothing` makes the re-send a `duplicate`; targets emit no
 *     event at all.
 * Claims and edges have natural keys of their own, and this connector emits
 * neither — nothing here writes a record kind whose re-send is not a no-op.
 *
 * A re-send is always a prefix from offset 0, never a middle slice: this
 * function returns 0 or the stored offset, so the file is replayed in the order
 * it was written and any later record that supersedes an earlier one is replayed
 * after it. The hub's final state is the same either way.
 *
 * An offset past the end of the file is corruption, and it used to be CLAMPED
 * to the size — which `reap` then read as "delivered in full" and deleted the
 * file on, destroying undelivered records without counting them. A cursor that
 * disagrees with its file is not evidence of delivery, so it buys nothing.
 */
export const readCursorOffset = async (
  spoolFile: string,
  cursorFile: string,
): Promise<number> => {
  const parsed = CursorSchema.safeParse(await readJsonOrNull(cursorFile));
  if (!parsed.success) {
    return NOTHING_CONSUMED;
  }
  const facts = await factsOf(spoolFile);
  return facts === null ||
    facts.ino !== parsed.data.ino ||
    parsed.data.offset > facts.size
    ? NOTHING_CONSUMED
    : parsed.data.offset;
};

/**
 * `deliveredFrom` is the inode the offset was computed against — the file the
 * flush actually read. Writing without it stamped whatever file happened to be
 * at the path NOW: if `reap` unlinked the spool after the flush read it and an
 * appender recreated it in between, a cursor for the old file was written
 * against the new one, and `readCursorOffset` had every reason to believe it.
 * The records the recreated file held were then skipped — not delivered, not
 * pending, not counted. Measured at 15 records in 5760 under load.
 *
 * The read side has always refused a cursor whose inode disagrees with its
 * file; this is the same refusal on the write side.
 */
export const writeCursorOffset = async (
  spoolFile: string,
  cursorFile: string,
  offset: number,
  deliveredFrom: number,
): Promise<void> => {
  const facts = await factsOf(spoolFile);
  if (facts === null || facts.ino !== deliveredFrom) {
    return;
  }
  await writePrivateFile(
    cursorFile,
    `${JSON.stringify({ ino: facts.ino, offset })}\n`,
  );
};

const NEWLINE = 0x0a;

/** Byte length of the first `count` complete, non-blank lines of `pending`. */
export const bytesOfLines = (pending: string, count: number): number => {
  const buffer = Buffer.from(pending, "utf8");
  let offset = 0;
  let taken = 0;
  while (taken < count) {
    const newline = buffer.indexOf(NEWLINE, offset);
    if (newline === -1) {
      return offset;
    }
    const line = buffer.subarray(offset, newline).toString("utf8").trim();
    offset = newline + 1;
    if (line.length > 0) {
      taken += 1;
    }
  }
  return offset;
};

export const sliceFrom = (raw: string, offset: number): string =>
  offset <= 0 ? raw : Buffer.from(raw, "utf8").subarray(offset).toString("utf8");
