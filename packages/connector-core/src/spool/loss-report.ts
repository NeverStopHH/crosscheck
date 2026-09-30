/**
 * THE LOSS REPORT, ASSEMBLED (docs/1.0/loss-accounting.md §4.1, §5.1): every
 * ledger on this machine that says telemetry was lost, folded into the
 * counts-and-kinds shape the hub reads on the session channel — and the one
 * spelling of it that `doctor` and `status` both print.
 *
 * THREE LEDGERS, ONE TOTAL. The `.drops` files and their archive (records
 * the connector wrote and did not deliver, by reason); the
 * `unrecorded.dropmarker` (the most recent batch the ledger itself could not
 * take — a floor, and the report says so); and the capture-loss ledger
 * (events upstream of any record: a timed-out hook, a host payload capture
 * could not read, a wire line the observer could not parse).
 *
 * KINDS, NEVER PATHS. The drop reasons map onto LOSS_KINDS; the record kinds
 * an `ignored` line names stay on this machine for doctor and never travel.
 */
import {
  EMPTY_LOSS_REPORT,
  UNATTRIBUTED_LOSS_KIND,
} from "@crosscheck/schema";
import type { LossKind, TelemetryLossReport } from "@crosscheck/schema";

import { HUB_COVERAGE_WINDOW_DAYS, MS_PER_DAY } from "../constants.ts";
import { readCaptureLosses } from "../state/loss-ledger.ts";
import type { CaptureLossSummary } from "../state/loss-ledger.ts";
import { readDropDetail, readUnrecordedDrop } from "./drops.ts";
import type { DropDetail, UnrecordedDrop } from "./drops.ts";

/**
 * The ledger's reason words → the wire's kinds. Three append refusals share
 * one kind because they share one remedy (the spool, not the hub); a reason
 * this map does not know — a future ledger, an edited file — is
 * `unattributed`, counted and unnamed.
 */
const DROP_REASON_KINDS: Readonly<Record<string, LossKind>> = {
  cap: "spool_refused",
  "short-write": "spool_refused",
  "write-failed": "spool_refused",
  unparsable: "spool_torn",
  expired: "spool_expired",
  rejected: "hub_rejected",
  ignored: "hub_ignored",
  "capture-capped": "capture_capped",
  "secret-path": "capture_secret_path",
  "outside-root": "touch_outside_root",
};

export const lossKindOfDropReason = (reason: string): LossKind =>
  DROP_REASON_KINDS[reason] ?? UNATTRIBUTED_LOSS_KIND;

type Counts = Readonly<Record<string, number>>;

const bump = (counts: Counts, name: string, by: number): Counts =>
  by <= 0 ? counts : { ...counts, [name]: (counts[name] ?? 0) + by };

const earlierIso = (left: string | null, right: string | null): string | null =>
  left === null || right === null ? (left ?? right) : right < left ? right : left;

const laterIso = (left: string | null, right: string | null): string | null =>
  left === null || right === null ? (left ?? right) : right > left ? right : left;

export interface LocalLosses {
  /** What the hub is sent. */
  readonly report: TelemetryLossReport;
  readonly drops: DropDetail;
  readonly unrecorded: UnrecordedDrop | null;
  readonly capture: CaptureLossSummary;
  /** True when a count is known to be BELOW the truth: a ledger refused a write. */
  readonly isFloor: boolean;
}

/** Pure, so the fold can be pinned without a filesystem. */
export const toLossReport = (
  drops: DropDetail,
  unrecorded: UnrecordedDrop | null,
  capture: CaptureLossSummary,
): TelemetryLossReport => {
  const fromDrops = Object.entries(drops.byReason).reduce<Counts>(
    (kinds, [reason, count]) => bump(kinds, lossKindOfDropReason(reason), count),
    {},
  );
  const withMarker =
    unrecorded === null
      ? fromDrops
      : bump(fromDrops, lossKindOfDropReason(unrecorded.reason), unrecorded.count);
  const kinds = Object.entries(capture.byKind).reduce<Counts>(
    (sum, [kind, count]) => bump(sum, kind, count),
    withMarker,
  );
  const total =
    drops.summary.records + (unrecorded?.count ?? 0) + capture.total;
  const markerAt = unrecorded?.at ?? null;
  return {
    total,
    kinds,
    oldestAt: earlierIso(earlierIso(drops.oldestAt, markerAt), capture.oldestAt),
    newestAt: laterIso(laterIso(drops.newestAt, markerAt), capture.newestAt),
  };
};

export const readLocalLosses = async (
  home: string,
  key: string,
): Promise<LocalLosses> => {
  const [drops, unrecorded, capture] = await Promise.all([
    readDropDetail(home, key),
    readUnrecordedDrop(home, key),
    readCaptureLosses(home, key),
  ]);
  const report = toLossReport(drops, unrecorded, capture);
  return {
    report: report.total === 0 ? EMPTY_LOSS_REPORT : report,
    drops,
    unrecorded,
    capture,
    isFloor: unrecorded !== null || capture.atCap || drops.summary.malformed > 0,
  };
};

/** The wire shape alone — what the three session calls attach. */
export const readTelemetryLossReport = async (
  home: string,
  key: string,
): Promise<TelemetryLossReport> => (await readLocalLosses(home, key)).report;

/**
 * The hub's own window rule, mirrored (§4.5): a loss is one the hub's
 * coverage should be reflecting while its newest instant is inside
 * HUB_COVERAGE_WINDOW_DAYS. A loss with no instant at all is read as recent,
 * because "we do not know when" must not become "not now".
 */
export const hasRecentLoss = (report: TelemetryLossReport, now: Date): boolean => {
  if (report.total === 0) {
    return false;
  }
  if (report.newestAt === null) {
    return true;
  }
  const newestMs = Date.parse(report.newestAt);
  return (
    Number.isNaN(newestMs) ||
    now.getTime() - newestMs < HUB_COVERAGE_WINDOW_DAYS * MS_PER_DAY
  );
};

const plural = (count: number, noun: string, nouns = `${noun}s`): string =>
  `${String(count)} ${count === 1 ? noun : nouns}`;

/** `expired 3, ignored 2` — largest first, then by name, so the line is stable. */
const breakdown = (counts: Counts): string =>
  Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([leftName, left], [rightName, right]) =>
      right - left || leftName.localeCompare(rightName),
    )
    .map(([name, count]) => `${name} ${String(count)}`)
    .join(", ");

const parenthetical = (text: string): string => (text.length === 0 ? "" : ` (${text})`);

/** Every `kind:detail` of one kind, as `detail count`. */
const detailsOf = (capture: CaptureLossSummary, kind: LossKind): string =>
  breakdown(
    Object.entries(capture.byDetail).reduce<Counts>((counts, [name, count]) => {
      const [entryKind, detail] = name.split(":");
      return entryKind === kind && detail !== undefined
        ? bump(counts, detail, count)
        : counts;
    }, {}),
  );

export interface LossLines {
  /** The spool-drops sentence: records discarded, in batches, by reason. */
  readonly dropped: string | null;
  /** Records a hub older than this connector threw away, with their kinds. */
  readonly ignored: string | null;
  /** Losses upstream of any record: timed-out hooks, host drift, wire lines. */
  readonly capture: string | null;
}

const droppedLine = (local: LocalLosses): string | null => {
  const { summary } = local.drops;
  if (summary.records === 0 && summary.malformed === 0 && local.unrecorded === null) {
    return null;
  }
  const unrecorded =
    local.unrecorded === null
      ? ""
      : `, plus at least one batch its ledger could not take (${String(local.unrecorded.count)} records, ${local.unrecorded.reason}, ${local.unrecorded.at}) — the total is a lower bound`;
  const malformed =
    summary.malformed === 0
      ? ""
      : `, ${plural(summary.malformed, "ledger entry", "ledger entries")} unreadable`;
  return (
    `${plural(summary.records, "record")} discarded in ${plural(summary.entries, "batch", "batches")}` +
    `${parenthetical(breakdown(local.drops.byReason))}${malformed}${unrecorded}`
  );
};

const ignoredLine = (local: LocalLosses): string | null => {
  const records = local.drops.byReason["ignored"] ?? 0;
  if (records === 0) {
    return null;
  }
  const batches = local.drops.entriesByReason["ignored"] ?? 0;
  return (
    `${plural(records, "record")} in ${plural(batches, "batch", "batches")} ignored by the hub` +
    `${parenthetical(breakdown(local.drops.ignoredRecordKinds))} — a hub older than this ` +
    "connector discards record kinds it does not know; upgrade the hub"
  );
};

const captureLine = (local: LocalLosses): string | null => {
  const { capture } = local;
  const hooks = capture.byKind["hook_timed_out"] ?? 0;
  const drift = capture.byKind["host_contract_drift"] ?? 0;
  const wire = capture.byKind["wire_unobserved"] ?? 0;
  const parts = [
    hooks === 0
      ? null
      : `${plural(hooks, "hook")} exceeded ${hooks === 1 ? "its" : "their"} budget before capture could finish${parenthetical(detailsOf(capture, "hook_timed_out"))}`,
    drift === 0
      ? null
      : `${plural(drift, "host payload")} lacked a field capture needs${parenthetical(detailsOf(capture, "host_contract_drift"))}`,
    wire === 0
      ? null
      : `${plural(wire, "ACP wire line")} could not be read by the observer`,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) {
    return null;
  }
  const floor = capture.atCap
    ? " — the ledger is at its cap, so these counts are floors"
    : "";
  return `${parts.join(" · ")}${floor}`;
};

/** One spelling for both commands (the spool-drops discipline). */
export const formatLossLines = (local: LocalLosses): LossLines => ({
  dropped: droppedLine(local),
  ignored: ignoredLine(local),
  capture: captureLine(local),
});
