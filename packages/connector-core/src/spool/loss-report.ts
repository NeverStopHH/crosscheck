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
  TelemetryLossReportSchema,
  UNATTRIBUTED_LOSS_KIND,
  clampLossCount,
} from "@crosscheck/schema";
import type { LossKind, TelemetryLossReport } from "@crosscheck/schema";

import { HUB_COVERAGE_WINDOW_DAYS, MS_PER_DAY } from "../constants.ts";
import { readCaptureLosses } from "../state/loss-ledger.ts";
import type { CaptureLossSummary } from "../state/loss-ledger.ts";
import { addCount } from "./counts.ts";
import type { Counts } from "./counts.ts";
import { NO_UNDATED, ledgerInstant, mergeUndated, undatedOf } from "./ledger-read.ts";
import {
  UNATTRIBUTED_DROP_REASON,
  readDropDetail,
  readUnrecordedDrop,
} from "./drops.ts";
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

/** Own keys only: `constructor` or `__proto__` in a ledger line is no reason. */
const isDropReasonWord = (reason: string): boolean =>
  Object.hasOwn(DROP_REASON_KINDS, reason);

export const lossKindOfDropReason = (reason: string): LossKind =>
  isDropReasonWord(reason)
    ? (DROP_REASON_KINDS[reason] ?? UNATTRIBUTED_LOSS_KIND)
    : UNATTRIBUTED_LOSS_KIND;

const bump = (counts: Counts, name: string, by: number): Counts =>
  by <= 0 ? counts : addCount(counts, name, by);

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

/** The instant as the wire carries it, or null (spool/ledger-read.ts, review M2). */
const wireInstant = (at: string): string | null => ledgerInstant(at);

/**
 * THE LAST LINE OF DEFENCE FOR THE CALL THE REPORT RIDES (review M2). Every
 * rule above aims at a report the hub's schema accepts; this checks it. A
 * report that still fails — a vocabulary the hub cannot fold, a count no
 * rule saturated — is sent as what is known for certain: at least one loss,
 * under no reason, undated. A hub refusing the block used to refuse the
 * register it rode, and a session whose registration fails never registers.
 */
export const toWireReport = (report: TelemetryLossReport): TelemetryLossReport => {
  if (TelemetryLossReportSchema.safeParse(report).success) {
    return report;
  }
  const total = Number.isSafeInteger(report.total)
    ? clampLossCount(Math.max(UNREADABLE_LINE_FLOOR, report.total))
    : UNREADABLE_LINE_FLOOR;
  return { total, kinds: { [UNATTRIBUTED_LOSS_KIND]: total }, oldestAt: null, newestAt: null };
};

/** Every count saturated at MAX_LOSS_COUNT (schema/telemetry-loss.ts, review C1). */
const saturated = (counts: Counts): Counts =>
  Object.fromEntries(
    Object.entries(counts).map(([kind, count]) => [kind, clampLossCount(count)]),
  );

/**
 * An unreadable ledger line is evidence that a loss was WRITTEN, with its
 * count unreadable: at least one, under no reason. Leaving it out would let
 * a ledger holding only a torn line report zero — the strengthening
 * direction §4.5 forbids.
 */
const UNREADABLE_LINE_FLOOR = 1;

interface ReportSpan {
  readonly oldestAt: string | null;
  readonly newestAt: string | null;
}

/**
 * The span the hub reads as "since when" and "still in the window".
 *
 * Content no instant dates — undated or unreadable lines, a marker whose
 * `at` will not parse — makes the OLDEST unknown (it may be older than any
 * dated entry) and bounds the NEWEST by the latest mtime of the files that
 * hold it (review H2): later than the truth, the side a loss may err on, and
 * finite, so the gap ages out instead of reading "current" for good.
 *
 * Two states leave the newest unknown, which the hub reads as current
 * (§4.5): undatable content no bound could be read for, and a capture
 * ledger at its cap whose refusal marker cannot be read — the one state in
 * which a refusal could have gone undated (state/loss-refusals.ts).
 */
const spanOf = (
  drops: DropDetail,
  marker: UnrecordedDrop | null,
  capture: CaptureLossSummary,
): ReportSpan => {
  const markerAt = marker === null ? null : wireInstant(marker.at);
  const markerUndated =
    marker !== null && markerAt === null ? undatedOf(1, marker.writtenBy) : NO_UNDATED;
  const undated = mergeUndated(mergeUndated(drops.undated, capture.undated), markerUndated);
  const dated = laterIso(laterIso(drops.newestAt, markerAt), capture.newestAt);
  const unboundedUndated = undated.count > 0 && undated.by === null;
  const fullWithoutMarker = capture.atCap && capture.fullSince === null;
  return {
    oldestAt:
      undated.count > 0
        ? null
        : earlierIso(earlierIso(drops.oldestAt, markerAt), capture.oldestAt),
    newestAt:
      unboundedUndated || fullWithoutMarker
        ? null
        : laterIso(dated, undated.count > 0 ? undated.by : null),
  };
};

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
  const withCapture = Object.entries(capture.byKind).reduce<Counts>(
    (sum, [kind, count]) => bump(sum, kind, count),
    withMarker,
  );
  const unreadable =
    (drops.summary.malformed + capture.malformed) * UNREADABLE_LINE_FLOOR;
  const kinds = bump(withCapture, UNATTRIBUTED_LOSS_KIND, unreadable);
  const total =
    drops.summary.records + (unrecorded?.count ?? 0) + capture.total + unreadable;
  // Saturated, never refused (review C1): coverage reads WHETHER and SINCE
  // WHEN, so a count capped at int4 cannot change any coverage state, while a
  // count past it used to make the hub refuse the call the report rode.
  return {
    total: clampLossCount(total),
    kinds: saturated(kinds),
    ...spanOf(drops, unrecorded, capture),
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
    report: report.total === 0 ? EMPTY_LOSS_REPORT : toWireReport(report),
    drops,
    unrecorded,
    capture,
    isFloor:
      unrecorded !== null ||
      capture.atCap ||
      capture.refused > 0 ||
      drops.summary.malformed > 0 ||
      capture.malformed > 0,
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

/** A word no ledger writer spells — what a hand edit or a torn line left. */
const OTHER_REASON = "other";

/**
 * THE LEDGER'S OWN WORDS, AND NOTHING ELSE, REACH A TERMINAL. A `.drops`
 * reason and the marker's fields are strings read back from files, and files
 * get edited: a reason this module does not know prints as `other`, and the
 * marker's instant is re-formatted from `Date.parse` or printed `undated`.
 */
const screenReason = (reason: string): string =>
  isDropReasonWord(reason) || reason === UNATTRIBUTED_DROP_REASON ? reason : OTHER_REASON;

const screenReasons = (counts: Counts): Counts =>
  Object.entries(counts).reduce<Counts>(
    (screened, [reason, count]) => bump(screened, screenReason(reason), count),
    {},
  );

const markerClause = (marker: UnrecordedDrop | null): string =>
  marker === null
    ? ""
    : `, plus at least one batch its ledger could not take (${String(marker.count)} records, ` +
      `${screenReason(marker.reason)}, ${wireInstant(marker.at) ?? "undated"}) — the total is a lower bound`;

const droppedLine = (local: LocalLosses): string | null => {
  const { summary } = local.drops;
  if (summary.records === 0 && summary.malformed === 0 && local.unrecorded === null) {
    return null;
  }
  const malformed =
    summary.malformed === 0
      ? ""
      : `, ${plural(summary.malformed, "ledger entry", "ledger entries")} unreadable`;
  // Review M1: a ledger file, archive or directory that exists and cannot be
  // read is counted (at least one record each) and said, never read as none.
  const unreadable =
    local.drops.unreadable === 0
      ? ""
      : `, ${plural(local.drops.unreadable, "ledger file")} could not be read — counted as at least one record each`;
  return (
    `${plural(summary.records, "record")} discarded in ${plural(summary.entries, "batch", "batches")}` +
    `${parenthetical(breakdown(screenReasons(local.drops.byReason)))}${malformed}${unreadable}${markerClause(local.unrecorded)}`
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

const kindParts = (capture: CaptureLossSummary): readonly (string | null)[] => {
  const hooks = capture.byKind["hook_timed_out"] ?? 0;
  const drift = capture.byKind["host_contract_drift"] ?? 0;
  const wire = capture.byKind["wire_unobserved"] ?? 0;
  return [
    hooks === 0
      ? null
      : `${plural(hooks, "hook")} exceeded ${hooks === 1 ? "its" : "their"} budget before capture could finish${parenthetical(detailsOf(capture, "hook_timed_out"))}`,
    drift === 0
      ? null
      : `${plural(drift, "host payload")} lacked a field capture needs${parenthetical(detailsOf(capture, "host_contract_drift"))}`,
    wire === 0
      ? null
      : `${plural(wire, "ACP wire line")} could not be read by the observer`,
    // Review H3: these were counted into the report and printed nowhere.
    capture.malformed === 0
      ? null
      : capture.unreadable
        ? "the capture-loss ledger could not be read, counted as one loss"
        : `${plural(capture.malformed, "capture-ledger line")} unreadable, counted as one loss each`,
  ];
};

/** `2026-09-05T08:13Z` — the minute, as doctor's coverage line prints instants. */
const ISO_MINUTE_CHARS = 16;

const minuteOf = (iso: string): string => `${iso.slice(0, ISO_MINUTE_CHARS)}Z`;

/**
 * A FULL LEDGER, SAID OUT LOUD (review H3): since when, what it refused, and
 * the one safe way to clear it. Fourteen days after the file's last write by
 * any repo, nothing in it is inside any repo's window, so removing it then
 * changes no coverage state — any earlier, and it would erase a loss the hub
 * still has to hear about.
 */
const fullLedgerClause = (capture: CaptureLossSummary): string | null => {
  if (!capture.atCap && capture.refused === 0) {
    return null;
  }
  const since = capture.fullSince === null ? "full" : `full since ${minuteOf(capture.fullSince)}`;
  const refused =
    capture.refused === 0
      ? "nothing refused yet"
      : `${plural(capture.refused, "loss", "losses")} refused past its cap, counted without detail and charged to every repo${capture.refusedNewestAt === null ? "" : `, the newest at ${minuteOf(capture.refusedNewestAt)}`}`;
  const clear =
    capture.lastWriteAt === null
      ? "its last write is unknown, so the hub reads its newest loss as current"
      : `the file can be removed once ${String(HUB_COVERAGE_WINDOW_DAYS)} days have passed since its last write (${minuteOf(capture.lastWriteAt)})`;
  return `the capture-loss ledger is ${since}: ${refused} — the counts are floors; ${clear}`;
};

const captureLine = (local: LocalLosses): string | null => {
  const parts = kindParts(local.capture).filter((part): part is string => part !== null);
  const full = fullLedgerClause(local.capture);
  if (parts.length === 0 && full === null) {
    return null;
  }
  return [parts.join(" · "), full].filter((part) => part !== null && part.length > 0).join(" — ");
};

/** One spelling for both commands (the spool-drops discipline). */
export const formatLossLines = (local: LocalLosses): LossLines => ({
  dropped: droppedLine(local),
  ignored: ignoredLine(local),
  capture: captureLine(local),
});
