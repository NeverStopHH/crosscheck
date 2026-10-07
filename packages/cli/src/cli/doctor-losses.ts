/**
 * WHAT THIS MACHINE LOST, AND WHETHER THE HUB KNOWS (docs/1.0/loss-accounting.md
 * §5.1, §5.2).
 *
 * Four lines from the machine's own ledgers, spelled once in
 * connector-core/src/spool/loss-report.ts `formatLossLines` so `doctor` and
 * `status` cannot describe one loss two ways: records discarded (by reason),
 * records the hub rejected (by cause — why, and what clears it), record kinds
 * an older hub ignored (by kind — what an upgrade recovers), and
 * losses upstream of any record (timed-out hooks, host drift, unread wire
 * lines). Each is a WARN when non-zero and a PASS "none" otherwise.
 *
 * And ONE cross-check, the one place an old hub is named. The connector
 * cannot see from its own call that a hub stripped the `losses` field — zod
 * answers 200 either way (§4.2) — so the contradiction is read off data both
 * sides already hold: recent local losses beside an `agent_event` rung that
 * reads `complete`. That pair, and only that pair, is a WARN. A rung the
 * hub turned incomplete FOR the loss is a PASS; a rung incomplete for any
 * other reason, unknown, or unreachable is no contradiction — the coverage
 * line one screen up already prints it — and gets no line at all.
 *
 * Every string here is a count, a ledger reason word, a LOSS_KINDS value, a
 * screened record kind or hook/host event name (loss-report.ts and the two
 * ledgers screen them), or a renderer-owned literal; the instant is
 * re-formatted from `Date.parse` before it is printed.
 */
import type { TelemetryLossReport } from "@crosscheck/schema";
import { HUB_COVERAGE_WINDOW_DAYS } from "@crosscheck/connector-core/constants.ts";
import type { CoverageRecord } from "@crosscheck/connector-core/http/coverage.ts";
import {
  formatLossLines,
  hasRecentLoss,
} from "@crosscheck/connector-core/spool/loss-report.ts";
import type { LocalLosses, LossLines } from "@crosscheck/connector-core/spool/loss-report.ts";

import type { Check, CheckLevel } from "./doctor.ts";

const REPORTING = "coverage reporting";

/** The two reasons a hub that recorded the report puts on the agent rung (§4.6). */
const LOSS_REASONS: ReadonlySet<string> = new Set(["telemetry_lost", "record_kinds_ignored"]);

/** `2026-09-05T08:13Z` — the minute, as `doctor`'s coverage line prints instants. */
const ISO_MINUTE_CHARS = 16;

const lossCheck = (level: CheckLevel, name: string, detail: string): Check => ({
  level,
  name,
  detail,
});

const lineCheck = (name: string, line: string | null): Check =>
  line === null ? lossCheck("PASS", name, "none") : lossCheck("WARN", name, line);

const IGNORED = "hub ignored records";

/**
 * Review M3: ignored records inside the hub's window are the WARN with the
 * remedy; ones from before it are a PASS that still names them — an upgraded
 * hub is not told to upgrade by an archive that outlives the window.
 */
const ignoredCheck = (lines: LossLines): Check =>
  lines.ignored !== null
    ? lossCheck("WARN", IGNORED, lines.ignored)
    : lossCheck("PASS", IGNORED, lines.ignoredEarlier ?? "none");

/** §5.1: the three ledger lines, in the order the ledgers are layered. */
export const lossChecks = (local: LocalLosses, now: Date): readonly Check[] => {
  const lines = formatLossLines(local, now);
  return [
    lineCheck("spool drops", lines.dropped),
    // WHY the hub refused what `spool drops` counts as `rejected` (§4.3).
    lineCheck("hub rejected records", lines.rejected),
    // ...and what was never sent because the hub had ended its life.
    lineCheck("withheld records", lines.withheld),
    ignoredCheck(lines),
    lineCheck("capture losses", lines.capture),
    // ...and what a connector before 1.0 lost, apart from all of the above:
    // its ledgers kept only counts, so nothing of it is re-sent.
    lineCheck("legacy losses", lines.legacy),
  ];
};

const newestPhrase = (newestAt: string | null): string => {
  const ms = newestAt === null ? Number.NaN : Date.parse(newestAt);
  return Number.isNaN(ms)
    ? "the newest undated, which the hub reads as current"
    : `the newest at ${new Date(ms).toISOString().slice(0, ISO_MINUTE_CHARS)}Z, inside the hub's ${String(HUB_COVERAGE_WINDOW_DAYS)}-day coverage window`;
};

const contradiction = (report: TelemetryLossReport): Check =>
  lossCheck(
    "WARN",
    REPORTING,
    `local ledgers hold ${String(report.total)} telemetry loss${report.total === 1 ? "" : "es"}, ` +
      `${newestPhrase(report.newestAt)}, but the hub's coverage for this repo reads complete: ` +
      "the hub has not recorded them — the next session registration or heartbeat from this " +
      "machine sends them, and a hub older than this connector discards them; if this " +
      "persists, upgrade the hub",
  );

/**
 * §5.2. Null when the hub's answer is no contradiction and gets no line of
 * its own (incomplete for another reason, unknown, unreachable).
 */
export const coverageReportingCheck = (
  report: TelemetryLossReport,
  coverage: CoverageRecord | null,
  now: Date,
): Check | null => {
  if (!hasRecentLoss(report, now)) {
    return lossCheck("PASS", REPORTING, "no recent losses to reflect");
  }
  const agent = coverage?.sources.find((row) => row.source === "agent_event");
  if (agent?.state === "complete") {
    return contradiction(report);
  }
  if (agent?.state === "incomplete" && LOSS_REASONS.has(agent.reason)) {
    return lossCheck("PASS", REPORTING, "the hub's coverage reflects the losses this connector reported");
  }
  return null;
};
