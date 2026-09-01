/**
 * The drop ledger: append-only, one line per dropped batch, one file per
 * session.
 *
 * `spoolDropped` used to be a counter in the sync state that every hook read,
 * incremented and wrote back without a lock, so simultaneous hooks lost each
 * other's increments and the number came out BELOW the truth — the one failure
 * mode a drop counter must not have. Here the number is not stored at all: it
 * is derived by summing an append-only file, which needs no lock to be exact.
 *
 * A `.drops` file outlives the data file it belongs to. `reap` deletes a
 * session's data and cursor as soon as they are safe to delete, but a drop must
 * stay visible to `doctor` afterwards; MAX_SPOOL_AGE_DAYS bounds how long the
 * per-batch DETAIL is kept.
 *
 * The TOTAL is not bounded by anything, deliberately. Nothing marks a ledger as
 * seen, so age-based deletion alone would quietly discard the evidence of an
 * outage before the developer who was away ever read it. When the sweep removes
 * a ledger it folds the counts into one aggregate line that never ages out.
 *
 * Summing an append-only file is exact only for what reached it, and the append
 * itself can fail. `recordDrop` checks its result and, when a count reached no
 * ledger, says so in `unrecorded.dropmarker` — after which `doctor` reports the
 * total as a lower bound rather than as the truth.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  readTextOrNull,
  readJsonOrNull,
  spoolDir,
  spoolDropsArchivePath,
  spoolDropsPath,
  spoolUnrecordedDropsPath,
  writePrivateFile,
} from "../config/paths.ts";
import { toLines } from "./lines.ts";
import { appendOnce } from "./write.ts";

export type DropReason =
  /** The session's data file was already at MAX_SPOOL_BYTES. */
  | "cap"
  /** The write did not land whole; the batch was not written. */
  | "short-write"
  /** The file could not be opened or written at all. */
  | "write-failed"
  /** A complete line on disk that is not JSON — the torn-fragment case. */
  | "unparsable"
  /** Undelivered records of a dead session past MAX_SPOOL_AGE_DAYS. */
  | "expired"
  /**
   * The hub answered 200 and refused the record — `accepted:0, rejected:N`.
   *
   * The cursor still advances (a rejected record is not going to become
   * acceptable on a retry, and refusing to advance would wedge the spool
   * behind it), so these lines are gone. Counting them is what keeps that from
   * being SILENT: `rejected` was read nowhere in the connector, so a session
   * the hub had closed lost everything it captured while `spool drops` printed
   * "none" (review finding B2-01/B2-07).
   */
  | "rejected";

const DropSchema = z.looseObject({
  at: z.string().min(1),
  count: z.number().int().min(0),
  reason: z.string().min(1),
});

export const DROPS_SUFFIX = ".drops";

export interface DropSummary {
  /** Records the connector admits it did not deliver. */
  readonly records: number;
  /** Ledger lines behind that number. */
  readonly entries: number;
  /** Ledger lines that could not be read — an unknown number of records. */
  readonly malformed: number;
}

const EMPTY_DROPS: DropSummary = {
  records: 0,
  entries: 0,
  malformed: 0,
};

export interface UnrecordedDrop {
  /** When the ledger append failed. */
  readonly at: string;
  /** Records in the batch it could not take. */
  readonly count: number;
  readonly reason: string;
}

const UnrecordedSchema = z.looseObject({
  at: z.string().min(1),
  count: z.number().int().min(0),
  reason: z.string().min(1),
});

/** Non-null once a ledger append has failed: the most recent batch it lost. */
export const readUnrecordedDrop = async (
  home: string,
  key: string,
): Promise<UnrecordedDrop | null> => {
  const parsed = UnrecordedSchema.safeParse(
    await readJsonOrNull(spoolUnrecordedDropsPath(home, key)),
  );
  return parsed.success
    ? {
        at: parsed.data.at,
        count: parsed.data.count,
        reason: parsed.data.reason,
      }
    : null;
};

/**
 * Says the ledgers are INCOMPLETE, and by how much the last time it happened.
 * The append below can fail like any other — a full disk, a mode change, a
 * `.drops` name taken by something that is not our file — and a drop counter
 * that loses counts is the exact failure this module exists to prevent (see the
 * header). The count cannot be written where it belongs, so the fact is written
 * somewhere else: a whole-file write through `writePrivateFile`, which is a
 * different syscall path from the O_APPEND that just failed and therefore has
 * its own chance of landing. Best effort, honestly: a filesystem that refuses
 * everything refuses this too, and then nothing on disk can be exact.
 *
 * A marker rather than a running counter, deliberately. A counter would have to
 * be read, added to and written back with no lock, and simultaneous hooks would
 * lose each other's increments — the very bug the append-only ledger replaced.
 * "At least one batch is missing, most recently this one" needs no read, so
 * concurrent writers cannot corrupt it; the worst two at once cost is one of
 * the two batches' detail. `doctor` renders the drop total as a lower bound for
 * as long as this file exists.
 *
 * Not retried: the same write has just failed for a reason a second attempt
 * microseconds later does not change, and a retry that also fails would still
 * need this. Recording the loss is what the caller needs; landing the byte is
 * not something this layer can promise.
 *
 * Its own failure is swallowed, like every other best-effort write here. This
 * runs on the hook's hot path via `appendRecords`, and a developer's session
 * must not die because the accounting for a record that was already lost could
 * not be written down either.
 */
const markUnrecordedDrop = async (
  home: string,
  key: string,
  count: number,
  reason: DropReason,
  now: Date,
): Promise<void> => {
  try {
    await writePrivateFile(
      spoolUnrecordedDropsPath(home, key),
      `${JSON.stringify({ at: now.toISOString(), count, reason })}\n`,
    );
  } catch {
    // Nothing left to fall back to: the disk has refused both an append and a
    // whole-file write, and no number this process holds can survive that.
  }
};

/**
 * Terminates the fragment a short ledger write left behind, so the NEXT entry
 * starts on its own line instead of being glued to it. Without it one failed
 * append costs two counts: the torn one and the readable one that follows it
 * into the same unparsable line. Same best-effort repair `appendRecords` makes
 * on the data file, and deliberately not a truncate.
 */
const LEDGER_TERMINATOR = "\n";

export const recordDrop = async (
  home: string,
  key: string,
  slug: string,
  count: number,
  reason: DropReason,
  now: Date,
): Promise<void> => {
  if (count <= 0) {
    return;
  }
  const path = spoolDropsPath(home, key, slug);
  const outcome = await appendOnce(
    path,
    `${JSON.stringify({ at: now.toISOString(), count, reason })}\n`,
  );
  if (outcome === "written") {
    return;
  }
  if (outcome === "short") {
    await appendOnce(path, LEDGER_TERMINATOR);
  }
  // The result is CHECKED rather than discarded: an append that came back short
  // or failed leaves this count in no ledger, and summing the ledgers would
  // then report below the truth — under-counting, which is the one direction a
  // drop counter must never fail in.
  await markUnrecordedDrop(home, key, count, reason, now);
};

const safeJson = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
};

const summarize = (lines: readonly string[]): DropSummary =>
  lines.reduce<DropSummary>((total, line) => {
    const parsed = DropSchema.safeParse(safeJson(line));
    return parsed.success
      ? {
          ...total,
          records: total.records + parsed.data.count,
          entries: total.entries + 1,
        }
      : { ...total, malformed: total.malformed + 1 };
  }, EMPTY_DROPS);

const add = (left: DropSummary, right: DropSummary): DropSummary => ({
  records: left.records + right.records,
  entries: left.entries + right.entries,
  malformed: left.malformed + right.malformed,
});

interface DropSpan {
  readonly oldestMs: number | null;
  readonly newestMs: number | null;
}

const NO_SPAN: DropSpan = { oldestMs: null, newestMs: null };

/** When a ledger's readable entries were written, first and last. */
const spanOf = (lines: readonly string[]): DropSpan =>
  lines.reduce<DropSpan>((span, line) => {
    const parsed = DropSchema.safeParse(safeJson(line));
    if (!parsed.success) {
      return span;
    }
    const ms = Date.parse(parsed.data.at);
    if (Number.isNaN(ms)) {
      return span;
    }
    return {
      oldestMs: span.oldestMs === null || ms < span.oldestMs ? ms : span.oldestMs,
      newestMs: span.newestMs === null || ms > span.newestMs ? ms : span.newestMs,
    };
  }, NO_SPAN);

/**
 * When the ledger last recorded something, read from its CONTENT rather than
 * its mtime. Retention has to survive `reap` writing an expiry drop and then
 * considering that same ledger for removal in the same pass, and a file's mtime
 * says nothing useful once an injected or skewed clock is involved.
 */
export const newestDropMs = async (path: string): Promise<number | null> =>
  spanOf(toLines(await readTextOrNull(path))).newestMs;

/**
 * The single line that survives the age sweep, holding what the removed ledgers
 * added up to. `reason: "aggregated"` distinguishes it from a real batch, and
 * the counts are carried explicitly so folding is lossless — summing the line
 * as if it were one batch would silently reset `entries` and `malformed`.
 */
const ArchiveSchema = z.looseObject({
  at: z.string().min(1),
  oldestAt: z.string().min(1),
  count: z.number().int().min(0),
  entries: z.number().int().min(0),
  malformed: z.number().int().min(0),
});

interface Archive {
  readonly summary: DropSummary;
  readonly span: DropSpan;
}

const EMPTY_ARCHIVE: Archive = { summary: EMPTY_DROPS, span: NO_SPAN };

const msOrNull = (value: string): number | null => {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

const readArchive = async (path: string): Promise<Archive> => {
  const parsed = ArchiveSchema.safeParse(
    safeJson(toLines(await readTextOrNull(path))[0] ?? ""),
  );
  if (!parsed.success) {
    return EMPTY_ARCHIVE;
  }
  return {
    summary: {
      records: parsed.data.count,
      entries: parsed.data.entries,
      malformed: parsed.data.malformed,
    },
    span: {
      oldestMs: msOrNull(parsed.data.oldestAt),
      newestMs: msOrNull(parsed.data.at),
    },
  };
};

const earliest = (left: number | null, right: number | null): number | null =>
  left === null || right === null ? (left ?? right) : Math.min(left, right);

const latest = (left: number | null, right: number | null): number | null =>
  left === null || right === null ? (left ?? right) : Math.max(left, right);

const isEmpty = (summary: DropSummary): boolean =>
  summary.records === 0 && summary.entries === 0 && summary.malformed === 0;

/**
 * Folds a ledger's totals into the repo's aggregate so the NUMBER outlives the
 * file the age sweep is about to remove. Only `reap` calls this, under the
 * flush lock, which is what makes rewriting the aggregate in place safe:
 * nothing else ever writes it, so there is no append to orphan.
 *
 * This is a read-modify-write, so "under the flush lock" has to mean ONE reap
 * at a time, and for a while it did not: the lock was taken from a holder that
 * was merely slow, which let two reaps fold into this file at once and lose one
 * of the two totals — under-reporting drops, in the one file that exists
 * precisely so a number is not quietly lost. What makes it single now is that a
 * claim whose holder process is still running is never taken (spool/lock.ts).
 */
export const archiveLedger = async (
  home: string,
  key: string,
  ledgerPath: string,
): Promise<void> => {
  const lines = toLines(await readTextOrNull(ledgerPath));
  const folding = summarize(lines);
  if (isEmpty(folding)) {
    return;
  }
  const path = spoolDropsArchivePath(home, key);
  const archive = await readArchive(path);
  const span = spanOf(lines);
  const total = add(archive.summary, folding);
  const oldestMs = earliest(archive.span.oldestMs, span.oldestMs);
  const newestMs = latest(archive.span.newestMs, span.newestMs);
  const stamp = (ms: number | null): string =>
    new Date(ms ?? Date.now()).toISOString();
  await writePrivateFile(
    path,
    `${JSON.stringify({
      at: stamp(newestMs),
      oldestAt: stamp(oldestMs),
      count: total.records,
      entries: total.entries,
      malformed: total.malformed,
      reason: "aggregated",
    })}\n`,
  );
};

/** Every drop this repo has recorded, counted from disk — aggregate included. */
export const readDropSummary = async (
  home: string,
  key: string,
): Promise<DropSummary> => {
  const dir = spoolDir(home, key);
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch {
    return EMPTY_DROPS;
  }
  const summaries = await Promise.all(
    names
      .filter((name) => name.endsWith(DROPS_SUFFIX))
      .map(async (name) => summarize(toLines(await readTextOrNull(join(dir, name))))),
  );
  const archive = await readArchive(spoolDropsArchivePath(home, key));
  return summaries.reduce(add, archive.summary);
};