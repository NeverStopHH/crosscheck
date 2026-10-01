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

/**
 * The largest count a report may carry: PostgreSQL `integer` (int4), the type
 * of `agent_sessions.loss_total`. Review C1 (2026-10-01): with no bound, one
 * report of 3e9 made the hub's INSERT fail with a 500, and a `hub_ignored` of
 * 3e9 cast `::int` at read time made `readCoverage` throw for every developer
 * on the repo. Coverage carries no count (03 §3.1) — it reads WHETHER and
 * SINCE WHEN — so saturating a count here can never change a coverage state.
 */
export const MAX_LOSS_COUNT = 2_147_483_647;

const LossCountSchema = z.number().int().min(0).max(MAX_LOSS_COUNT);

export const TelemetryLossReportSchema = z.object({
  /** At least the sum of `kinds`; a FLOOR while a ledger append has failed. */
  total: LossCountSchema,
  /** Loose on the wire, folded on the hub — never refused for a key. */
  kinds: z
    .record(z.string().min(1).max(MAX_LOSS_KIND_CHARS), LossCountSchema)
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

/**
 * WHAT A HUB STORES FOR A REPORT IT CANNOT READ (review M2): a count past
 * MAX_LOSS_COUNT, an unsafe integer, more kinds than any vocabulary, an
 * instant no ISO parser reads, a block that is not an object. Refusing the
 * block refused the whole register, heartbeat or end — and a session whose
 * registration fails is never registered at all. The connector meant to say
 * something about its losses, so the block reads as ONE loss with no span:
 * §2's "an unreadable report reads as unknown, never as zero", in the one
 * shape coverage can carry.
 */
export const UNREADABLE_LOSS_REPORT: TelemetryLossReport = {
  total: 1,
  kinds: { [UNATTRIBUTED_LOSS_KIND]: 1 },
  oldestAt: null,
  newestAt: null,
};

/** Saturates at MAX_LOSS_COUNT; a count is a floor, and coverage reads none. */
export const clampLossCount = (count: number): number =>
  Math.min(MAX_LOSS_COUNT, Math.max(0, count));

export interface SettledLossCounts {
  readonly total: number;
  readonly kinds: FoldedLossKinds;
}

const sumKinds = (kinds: FoldedLossKinds): number =>
  Object.values(kinds).reduce((sum, count) => sum + (count ?? 0), 0);

/**
 * THE COUNTS A HUB STORES, ONE RULE FOR ALL THREE CALLS. The total is the
 * larger of the sent `total` and the sum of the folded kinds — a report of
 * `{total: 0, kinds: {hub_ignored: 7}}` read `complete` when the hub trusted
 * the total alone (review PROBE C) — and whatever the kinds do not account
 * for is `unattributed`: that is where a key zod's record parse drops
 * silently (`__proto__`, PROBE F) is folded. Both moves can only raise what
 * the row says was lost; every count saturates at MAX_LOSS_COUNT.
 */
export const settleLossReport = (report: TelemetryLossReport): SettledLossCounts => {
  const folded = foldLossKinds(report.kinds);
  const counted = sumKinds(folded);
  const total = clampLossCount(Math.max(report.total, counted));
  const remainder = total - Math.min(total, counted);
  const withRemainder: FoldedLossKinds =
    remainder > 0
      ? { ...folded, [UNATTRIBUTED_LOSS_KIND]: (folded[UNATTRIBUTED_LOSS_KIND] ?? 0) + remainder }
      : folded;
  const kinds = Object.fromEntries(
    Object.entries(withRemainder).map(([kind, count]) => [kind, clampLossCount(count ?? 0)]),
  ) as FoldedLossKinds;
  return { total, kinds };
};
