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
 *
 * EVERY LINE CARRIES ITS REASON, AND THE REASON TRAVELS (docs/1.0/loss-accounting.md
 * §4.3). `readDropSummary` is the three numbers doctor has always printed;
 * `readDropDetail` beside it reads the same files by reason, with the record
 * kinds an `ignored` line names and the span of the entries, because the
 * connector now REPORTS these losses to the hub as counts and kinds and the
 * hub turns them into a coverage reason. The archive line folds the reasons
 * in; an archive written before it kept them reports its count as
 * `unattributed`, which is the honest word for it.
 */
import { join } from "node:path";
import { z } from "zod";

import {
  spoolDir,
  spoolDropsArchivePath,
  spoolDropsPath,
  spoolUnrecordedDropsPath,
  writePrivateFile,
} from "../config/paths.ts";
import { addCount } from "./counts.ts";
import type { Counts } from "./counts.ts";
import {
  NO_UNDATED,
  ledgerInstant,
  ledgerMs,
  listLedgerNames,
  mergeUndated,
  readLedgerText,
  undatedOf,
} from "./ledger-read.ts";
import type { UndatedContent } from "./ledger-read.ts";
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
  | "rejected"
  /**
   * The hub answered 200 and IGNORED the record's kind — a hub from before
   * that kind, or a kind never ingested over this route (server
   * services/records.ts). The sibling of `rejected`, read nowhere until
   * docs/1.0/loss-accounting.md: a newer connector against an older hub lost
   * whole record kinds while `spool drops` printed "none". The line carries
   * `kinds`, the record kinds the hub ignored, so doctor can say what to
   * upgrade for.
   */
  | "ignored"
  /** Paths past MAX_TARGETS_PER_INVOCATION in one tool call — never written. */
  | "capture-capped"
  /** A path the secret scan refused to spool — never written. */
  | "secret-path"
  /** An edit whose path resolved to no root of this repo — never written. */
  | "outside-root";

/** The word a pre-reason archive's count is reported under. */
export const UNATTRIBUTED_DROP_REASON = "unattributed";

/**
 * A ledger file that exists and cannot be read holds an unknown number of
 * lost records: at least this many (review M1, §2 "unknown, never zero").
 */
const UNREADABLE_FLOOR = 1;

/** The marker reason for an unrecorded marker that will not parse; not a DropReason, so it reads as unattributed. */
const UNREADABLE_REASON = "unreadable";

const KindsSchema = z.record(z.string(), z.number().int().min(0));

const DropSchema = z.looseObject({
  at: z.string().min(1),
  count: z.number().int().min(0),
  reason: z.string().min(1),
  /** Record kinds behind the count, on `ignored` and `rejected` lines. */
  kinds: KindsSchema.optional(),
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
  /** The marker file's mtime — an upper bound on `at` when `at` will not parse (review H2). */
  readonly writtenBy: string | null;
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
  const { text, writtenBy, unreadable } = await readLedgerText(spoolUnrecordedDropsPath(home, key));
  if (text === null && !unreadable) {
    return null;
  }
  const parsed = UnrecordedSchema.safeParse(safeJson(text ?? ""));
  // A marker that exists and will not parse still says a ledger append
  // failed (review M1): one batch of unknown size, undated, bounded by the
  // marker's mtime — never the absence of a marker.
  return parsed.success
    ? {
        at: parsed.data.at,
        count: parsed.data.count,
        reason: parsed.data.reason,
        writtenBy,
      }
    : { at: "", count: UNREADABLE_FLOOR, reason: UNREADABLE_REASON, writtenBy };
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

/**
 * Record kinds are the connector's own vocabulary (@crosscheck/schema
 * KNOWN_RECORD_KINDS), but a ledger line is a file on disk that a renderer
 * reads back, so a name is kept only when it has that vocabulary's shape and
 * anything else is counted under `other`. The same screen runs at read time,
 * because a line is a file and files get edited.
 */
const RECORD_KIND_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;
const OTHER_KIND = "other";

const screenKinds = (kinds: Counts): Counts =>
  Object.entries(kinds).reduce<Counts>(
    (screened, [kind, count]) =>
      count <= 0
        ? screened
        : addCount(screened, RECORD_KIND_PATTERN.test(kind) ? kind : OTHER_KIND, count),
    {},
  );

export const recordDrop = async (
  home: string,
  key: string,
  slug: string,
  count: number,
  reason: DropReason,
  now: Date,
  kinds: Readonly<Record<string, number>> = {},
): Promise<void> => {
  if (count <= 0) {
    return;
  }
  const path = spoolDropsPath(home, key, slug);
  const screened = screenKinds(kinds);
  const line = {
    at: now.toISOString(),
    count,
    reason,
    ...(Object.keys(screened).length === 0 ? {} : { kinds: screened }),
  };
  const outcome = await appendOnce(path, `${JSON.stringify(line)}\n`);
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

const addCounts = (left: Counts, right: Counts): Counts =>
  Object.entries(right).reduce<Counts>(
    (sum, [name, count]) => addCount(sum, name, count),
    left,
  );

const sumOf = (counts: Counts): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

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
    const ms = ledgerMs(parsed.data.at);
    if (ms === null) {
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
 *
 * EXCEPT WHEN THE CONTENT NAMES NO INSTANT AT ALL (review H2, PROBE 4): a
 * ledger of torn or undatable lines answered null here, so `reap` never
 * folded it and its repo's span stayed unknown for good. Its mtime is the
 * one bound on when those lines were written, and reap ages it by that.
 */
export const newestDropMs = async (path: string): Promise<number | null> => {
  const { text, writtenBy } = await readLedgerText(path);
  const lines = toLines(text);
  return spanOf(lines).newestMs ?? (lines.length > 0 ? ledgerMs(writtenBy) : null);
};

/**
 * The per-reason half of a ledger (docs/1.0/loss-accounting.md §4.3).
 *
 * `byReason` counts records under the line's own reason word; the
 * `ignoredRecordKinds` map is the sum of the `kinds` an `ignored` line
 * carries — the record kinds a hub older than this connector threw away,
 * which is what doctor needs to say what an upgrade would recover.
 */
export interface DropDetail {
  readonly summary: DropSummary;
  /** Records by ledger reason; a pre-reason archive's count is `unattributed`. */
  readonly byReason: Counts;
  /** Ledger lines by reason. */
  readonly entriesByReason: Counts;
  /** Record kinds the hub ignored, summed over the `ignored` lines. */
  readonly ignoredRecordKinds: Counts;
  readonly oldestAt: string | null;
  readonly newestAt: string | null;
  /**
   * Entries the span cannot date — lines whose `at` will not parse and lines
   * that will not parse at all — with the latest instant they can have been
   * written: their file's mtime (spool/ledger-read.ts, review H2). The
   * report keeps the oldest unknown and takes the bound as a newest, which
   * is later than the truth and lets the loss age out.
   */
  readonly undated: UndatedContent;
  /** Ledger files, archives or directories that exist and could not be read (review M1). */
  readonly unreadable: number;
}

const EMPTY_DETAIL: DropDetail = {
  summary: EMPTY_DROPS,
  byReason: {},
  entriesByReason: {},
  ignoredRecordKinds: {},
  oldestAt: null,
  newestAt: null,
  undated: NO_UNDATED,
  unreadable: 0,
};

/**
 * WHAT AN UNREADABLE LEDGER IS WORTH (review M1): `records` lost under no
 * reason — at least one, or the count an unparseable archive still names —
 * undated and bounded by the file's mtime. It used to read as zero.
 */
const unreadableDetail = (records: number, writtenBy: string | null): DropDetail => {
  const counted = Math.max(UNREADABLE_FLOOR, records);
  return {
    ...EMPTY_DETAIL,
    summary: { records: counted, entries: 0, malformed: 0 },
    byReason: { [UNATTRIBUTED_DROP_REASON]: counted },
    undated: undatedOf(1, writtenBy),
    unreadable: 1,
  };
};

const isUndated = (at: string): boolean => ledgerMs(at) === null;

const isoOrNull = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

/** `writtenBy` is the ledger file's mtime: the bound its undatable lines take. */
const detailOf = (lines: readonly string[], writtenBy: string | null): DropDetail => {
  const span = spanOf(lines);
  const summary = summarize(lines);
  const counted = lines.reduce<DropDetail>(
    (detail, line) => {
      const parsed = DropSchema.safeParse(safeJson(line));
      if (!parsed.success) {
        return detail;
      }
      const { at, reason, count, kinds } = parsed.data;
      return {
        ...detail,
        undated: isUndated(at) ? mergeUndated(detail.undated, undatedOf(1, writtenBy)) : detail.undated,
        byReason: addCounts(detail.byReason, { [reason]: count }),
        entriesByReason: addCounts(detail.entriesByReason, { [reason]: 1 }),
        ignoredRecordKinds:
          reason === "ignored" && kinds !== undefined
            ? addCounts(detail.ignoredRecordKinds, screenKinds(kinds))
            : detail.ignoredRecordKinds,
      };
    },
    {
      ...EMPTY_DETAIL,
      summary,
      oldestAt: isoOrNull(span.oldestMs),
      newestAt: isoOrNull(span.newestMs),
    },
  );
  // A line that will not parse names no instant either: same bound.
  return { ...counted, undated: mergeUndated(counted.undated, undatedOf(summary.malformed, writtenBy)) };
};

const earliest = (left: number | null, right: number | null): number | null =>
  left === null || right === null ? (left ?? right) : Math.min(left, right);

const latest = (left: number | null, right: number | null): number | null =>
  left === null || right === null ? (left ?? right) : Math.max(left, right);

const msOrNull = (value: string | null): number | null => ledgerMs(value);

const addDetail = (left: DropDetail, right: DropDetail): DropDetail => ({
  summary: add(left.summary, right.summary),
  byReason: addCounts(left.byReason, right.byReason),
  entriesByReason: addCounts(left.entriesByReason, right.entriesByReason),
  ignoredRecordKinds: addCounts(left.ignoredRecordKinds, right.ignoredRecordKinds),
  oldestAt: isoOrNull(earliest(msOrNull(left.oldestAt), msOrNull(right.oldestAt))),
  newestAt: isoOrNull(latest(msOrNull(left.newestAt), msOrNull(right.newestAt))),
  undated: mergeUndated(left.undated, right.undated),
  unreadable: left.unreadable + right.unreadable,
});

/**
 * The single line that survives the age sweep, holding what the removed ledgers
 * added up to. `reason: "aggregated"` distinguishes it from a real batch, and
 * the counts are carried explicitly so folding is lossless — summing the line
 * as if it were one batch would silently reset `entries` and `malformed`.
 *
 * `byReason`, `entriesByReason` and `ignoredKinds` are folded in beside them
 * so the reasons survive the sweep too. An archive from before those fields
 * parses without them, and the part of its count no reason accounts for is
 * reported as `unattributed` — never dropped, never guessed.
 */
const ArchiveSchema = z.looseObject({
  at: z.string().min(1),
  oldestAt: z.string().min(1),
  count: z.number().int().min(0),
  entries: z.number().int().min(0),
  malformed: z.number().int().min(0),
  byReason: KindsSchema.optional(),
  entriesByReason: KindsSchema.optional(),
  ignoredKinds: KindsSchema.optional(),
  /** Undatable entries folded in, and their bound (review H2). */
  undatable: z.number().int().min(0).optional(),
  undatableBy: z.string().nullable().optional(),
  /** This branch's first spelling of `undatable`, before it kept a bound. */
  undated: z.number().int().min(0).optional(),
});

/** What an archive that fails ArchiveSchema may still say about its size. */
const LooseCountSchema = z.looseObject({ count: z.number().int().min(0) });

const readArchiveDetail = async (path: string): Promise<DropDetail> => {
  const { text, writtenBy, unreadable } = await readLedgerText(path);
  if (unreadable) {
    return unreadableDetail(UNREADABLE_FLOOR, writtenBy);
  }
  if (text === null) {
    return EMPTY_DETAIL;
  }
  const line = safeJson(toLines(text)[0] ?? "");
  const parsed = ArchiveSchema.safeParse(line);
  if (!parsed.success) {
    // Review M1 (PROBE 3): a torn archive holding 382 records read as zero.
    const loose = LooseCountSchema.safeParse(line);
    return unreadableDetail(loose.success ? loose.data.count : UNREADABLE_FLOOR, writtenBy);
  }
  const byReason = parsed.data.byReason ?? {};
  const unattributed = parsed.data.count - sumOf(byReason);
  const oldestAt = isoOrNull(msOrNull(parsed.data.oldestAt));
  const newestAt = isoOrNull(msOrNull(parsed.data.at));
  // An archive whose own instants do not parse holds counted records with no
  // date — the same unknown span as an undated line, carried forward.
  const undatedHere = parsed.data.count > 0 && (oldestAt === null || newestAt === null) ? 1 : 0;
  return {
    summary: {
      records: parsed.data.count,
      entries: parsed.data.entries,
      malformed: parsed.data.malformed,
    },
    byReason:
      unattributed > 0
        ? addCounts(byReason, { [UNATTRIBUTED_DROP_REASON]: unattributed })
        : byReason,
    entriesByReason: parsed.data.entriesByReason ?? {},
    ignoredRecordKinds: screenKinds(parsed.data.ignoredKinds ?? {}),
    oldestAt,
    newestAt,
    // The bound the fold kept, else the archive's own mtime: it is rewritten
    // at every fold, so it is no earlier than anything it holds.
    undated: undatedOf(
      (parsed.data.undatable ?? (parsed.data.undated ?? 0) + parsed.data.malformed) + undatedHere,
      ledgerInstant(parsed.data.undatableBy) ?? writtenBy,
    ),
    unreadable: 0,
  };
};

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
  const ledger = await readLedgerText(ledgerPath);
  const folding = detailOf(toLines(ledger.text), ledger.writtenBy);
  if (isEmpty(folding.summary)) {
    return;
  }
  const path = spoolDropsArchivePath(home, key);
  const total = addDetail(await readArchiveDetail(path), folding);
  const stamp = (iso: string | null): string => iso ?? new Date().toISOString();
  // `unattributed` is a READ-side word for the count an older archive kept
  // without reasons; written back under a reason it would look like a line
  // somebody recorded, so it is left out of `byReason` and recovered from the
  // difference again on the next read.
  const { [UNATTRIBUTED_DROP_REASON]: _unattributed, ...byReason } = total.byReason;
  await writePrivateFile(
    path,
    `${JSON.stringify({
      at: stamp(total.newestAt),
      oldestAt: stamp(total.oldestAt),
      count: total.summary.records,
      entries: total.summary.entries,
      malformed: total.summary.malformed,
      reason: "aggregated",
      byReason,
      entriesByReason: total.entriesByReason,
      ignoredKinds: total.ignoredRecordKinds,
      // Carried, because `stamp` above writes a real instant even when every
      // folded line was undatable, and the archive must not launder that —
      // with the bound those lines had, so they still age out (review H2).
      undatable: total.undated.count,
      undatableBy: total.undated.by,
    })}\n`,
  );
};

/** One ledger file: its detail, or — when it exists and cannot be read — an unknown loss. */
const ledgerDetail = async (path: string): Promise<DropDetail> => {
  const ledger = await readLedgerText(path);
  return ledger.unreadable
    ? unreadableDetail(UNREADABLE_FLOOR, ledger.writtenBy)
    : detailOf(toLines(ledger.text), ledger.writtenBy);
};

/** Every drop this repo has recorded, counted from disk — aggregate included. */
export const readDropSummary = async (
  home: string,
  key: string,
): Promise<DropSummary> => (await readDropDetail(home, key)).summary;

/** The same files, by reason and with their span (loss-accounting §4.3). */
export const readDropDetail = async (
  home: string,
  key: string,
): Promise<DropDetail> => {
  const dir = spoolDir(home, key);
  const listing = await listLedgerNames(dir, DROPS_SUFFIX);
  const details = await Promise.all(listing.names.map((name) => ledgerDetail(join(dir, name))));
  // A spool directory that exists and cannot be listed hides every ledger in
  // it: an unknown loss, never "no drops" (review M1).
  const unlisted = listing.unreadable ? [unreadableDetail(UNREADABLE_FLOOR, listing.writtenBy)] : [];
  const archive = await readArchiveDetail(spoolDropsArchivePath(home, key));
  return [...details, ...unlisted].reduce(addDetail, archive);
};
