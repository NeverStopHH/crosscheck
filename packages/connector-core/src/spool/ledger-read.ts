/**
 * READING A LOSS LEDGER BACK (docs/1.0/loss-accounting.md §4.3, "a line is a
 * file, and files get edited"): the one instant rule every ledger reader
 * shares, so the span the hub receives always parses on its schema.
 *
 * `Date.parse` alone is not that rule. It reads `+275760-09-13T00:00:00.000Z`
 * and `-000001-01-01T00:00:00.000Z`, and `toISOString` writes them back with
 * the extended-year sign — which `z.iso.datetime()` on the hub refuses, so one
 * such line used to refuse every register, heartbeat and end (review M2). An
 * instant counts only inside the four-digit years the wire can carry.
 */
import { readFile, stat } from "node:fs/promises";

/** 0000-01-01T00:00:00.000Z — the first instant a four-digit ISO year spells. */
const FIRST_WIRE_MS = -62_167_219_200_000;
/** 9999-12-31T23:59:59.999Z — the last. */
const LAST_WIRE_MS = 253_402_300_799_999;

/** The instant's epoch milliseconds, or null when the wire could not carry it. */
export const ledgerMs = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) && ms >= FIRST_WIRE_MS && ms <= LAST_WIRE_MS ? ms : null;
};

/** The instant re-formatted for the wire, or null when it has none the wire takes. */
export const ledgerInstant = (value: string | number | null | undefined): string | null => {
  const ms = ledgerMs(value);
  return ms === null ? null : new Date(ms).toISOString();
};

/**
 * A LEDGER FILE AND THE LATEST INSTANT ANY LINE IN IT CAN CARRY (review H2).
 * No line in a file was written after the file's last modification, so its
 * mtime is an UPPER bound on every line it holds — including the ones whose
 * own `at` will not parse. That is the bound undatable content takes: later
 * than the truth, the side a loss may err on (§4.5), and finite, so the loss
 * leaves the hub's window instead of reading "current" for ever. The one way
 * to break it is setting the mtime backwards by hand; `cp -p` from a backup
 * copies a source mtime that already bounds the same content.
 */
export interface LedgerText {
  /** The file's text; null when it is absent or could not be read. */
  readonly text: string | null;
  /** The file's mtime as a wire instant; null when it could not be read. */
  readonly writtenBy: string | null;
}

export const readLedgerText = async (path: string): Promise<LedgerText> => {
  try {
    const info = await stat(path);
    const text = await readFile(path, "utf8").catch(() => null);
    return { text, writtenBy: ledgerInstant(info.mtimeMs) };
  } catch {
    return { text: null, writtenBy: null };
  }
};

/**
 * Entries a reader counted but could not date (undated or unreadable lines),
 * and the latest instant they can have been written. `by` null beside a
 * non-zero count means no bound could be read: the newest is then unknown.
 */
export interface UndatedContent {
  readonly count: number;
  readonly by: string | null;
}

export const NO_UNDATED: UndatedContent = { count: 0, by: null };

export const undatedOf = (count: number, by: string | null): UndatedContent =>
  count > 0 ? { count, by } : NO_UNDATED;

/** Counts add; the bound is the later of the two, and unbounded wins. */
export const mergeUndated = (left: UndatedContent, right: UndatedContent): UndatedContent => {
  if (left.count === 0) {
    return right;
  }
  if (right.count === 0) {
    return left;
  }
  const by =
    left.by === null || right.by === null ? null : right.by > left.by ? right.by : left.by;
  return { count: left.count + right.count, by };
};
