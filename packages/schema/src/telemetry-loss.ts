/**
 * THE LOSS REPORT (docs/1.0/loss-accounting.md §4.1) — what a connector tells
 * the hub about the telemetry it knows it did not deliver: counts and kinds,
 * nothing else. No path, no record text, no record kind name, no hook name
 * crosses the wire; those stay in the machine's ledgers for `doctor`.
 *
 * WHY IT LIVES IN `schema`. Both sides read it: the connector builds it from
 * its ledgers and the hub folds it into a session row that Coverage reads.
 * The hub can import this package and cannot import the connector, which is
 * the same argument that put the secret scan here (secret-scan.ts).
 *
 * THE FOLD IS THE CONTRACT. A hub older than a kind must not read that kind
 * as zero — a loss report the hub cannot fully read is still a report of a
 * loss — so `kinds` is a loose map on the wire and `foldLossKinds` sums every
 * key it does not know into `unattributed`. Unknown keys are never stored
 * under their own name: a connector is untrusted, and a free-text key would
 * be an author-written string on a record that renders (03 §3.3).
 */
import { z } from "zod";

/**
 * The vocabulary. Each value names the MECHANISM that lost the telemetry,
 * which is what a reader can act on; the coverage reason above it
 * (`telemetry_lost` / `record_kinds_ignored`) is coarser on purpose.
 */
export const LOSS_KINDS = [
  /** Append refused: the session's file at MAX_SPOOL_BYTES, a short write, a write that failed. */
  "spool_refused",
  /** A complete line on disk that is not JSON, counted at flush. */
  "spool_torn",
  /** Undelivered records of a dead session past MAX_SPOOL_AGE_DAYS. */
  "spool_expired",
  /** The hub answered 200 and refused the record. */
  "hub_rejected",
  /** The hub answered 200 and ignored the record's kind. */
  "hub_ignored",
  /** Paths past MAX_TARGETS_PER_INVOCATION in one tool call. */
  "capture_capped",
  /** A path the secret scan refused to spool. */
  "capture_secret_path",
  /** An edit whose path resolved to no root of this repo. */
  "touch_outside_root",
  /** Hooks that exceeded their budget before capture could finish (hooks, not records). */
  "hook_timed_out",
  /** Host payloads that lacked a field capture needs (payloads, not records). */
  "host_contract_drift",
  /** ACP wire lines the observer could not read (lines, not records). */
  "wire_unobserved",
  /** Counted before the ledger kept reasons, or a kind this hub does not know. */
  "unattributed",
] as const;

export type LossKind = (typeof LOSS_KINDS)[number];

export const UNATTRIBUTED_LOSS_KIND: LossKind = "unattributed";

const LOSS_KIND_SET: ReadonlySet<string> = new Set(LOSS_KINDS);

export const isLossKind = (value: string): value is LossKind =>
  LOSS_KIND_SET.has(value);

/**
 * The largest `kinds` map a hub accepts: the twelve kinds above, doubled, so
 * a connector two vocabularies ahead of this hub still parses while a client
 * sending thousands of keys is refused at the schema rather than folded one
 * by one.
 */
export const MAX_LOSS_KIND_ENTRIES = 24;

/** A key longer than this is nobody's enum value. */
export const MAX_LOSS_KIND_CHARS = 64;

export const TelemetryLossReportSchema = z.object({
  /** At least the sum of `kinds`; a FLOOR while a ledger append has failed. */
  total: z.number().int().min(0),
  /** Loose on the wire, folded on the hub — never refused for a key. */
  kinds: z
    .record(
      z.string().min(1).max(MAX_LOSS_KIND_CHARS),
      z.number().int().min(0),
    )
    .refine((kinds) => Object.keys(kinds).length <= MAX_LOSS_KIND_ENTRIES, {
      message: `kinds: at most ${String(MAX_LOSS_KIND_ENTRIES)} entries`,
    }),
  /** The earliest instant the ledgers admit a loss; null when there is none. */
  oldestAt: z.iso.datetime().nullable(),
  /** The latest such instant; null when there is none. */
  newestAt: z.iso.datetime().nullable(),
});

export type TelemetryLossReport = z.infer<typeof TelemetryLossReportSchema>;

/** What a connector with clean ledgers sends: a statement, not a silence. */
export const EMPTY_LOSS_REPORT: TelemetryLossReport = {
  total: 0,
  kinds: {},
  oldestAt: null,
  newestAt: null,
};

export type FoldedLossKinds = Partial<Record<LossKind, number>>;

/**
 * Keys this hub knows pass through; every other key's count is added to
 * `unattributed` — on top of one the connector sent itself, never over it.
 * Zero counts are dropped so the stored object names only real losses.
 */
export const foldLossKinds = (
  kinds: Readonly<Record<string, number>>,
): FoldedLossKinds =>
  Object.entries(kinds).reduce<FoldedLossKinds>((folded, [key, count]) => {
    if (count <= 0) {
      return folded;
    }
    const kind: LossKind = isLossKind(key) ? key : UNATTRIBUTED_LOSS_KIND;
    return { ...folded, [kind]: (folded[kind] ?? 0) + count };
  }, {});
