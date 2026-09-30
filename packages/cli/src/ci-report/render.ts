/**
 * WHAT THE REPORTER PRINTS INTO THE CI LOG (spec 05 §5): counts, enum words
 * and its own outcome. NEVER A TEST NAME. A `test_id` is text out of a
 * repository, a fork pull request can name a test anything, and the CI log
 * is read by people and by agents — so no id reaches this surface at all,
 * which is stronger than sanitizing one. The names live on the hub, behind
 * `crosscheck status`, which frames them.
 *
 * THREE SLOTS THIS MODULE DOES NOT WRITE ITSELF, each through `bareUntrusted`:
 *
 *   - the hub's failure sentence, bounded by MAX_HUB_MESSAGE_CHARS — the
 *     constant written for exactly this ("a string THE HUB chose, as a tool
 *     prints it back");
 *   - `--job` and `--leg`, the workflow author's own words, bounded by the
 *     lane bound. They are already refused at the boundary if they carry a
 *     control character; the sanitizer is the second lock on the same door.
 *
 * Everything else — the short sha (hex, validated), the attempt, the counts,
 * `outcome`, the hub's `accepted`/`duplicate` and the run id (shape-checked
 * in post.ts before it is printed) — is a number or a word this side chose.
 *
 * Registered as `cli-ci-report` (src/render-surfaces.ts), BARE: the log is a
 * terminal-shaped surface with no QUOTED_DATA_NOTICE, so no « » frame — the
 * same reasoning `cli-claim-revalidate` and `cli-pin-observability` give.
 */
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import { MAX_HUB_MESSAGE_CHARS } from "@crosscheck/connector-core/constants.ts";
import { MAX_CI_LANE_FIELD_CHARS } from "@crosscheck/schema";

import type { CiRunPostOutcome } from "./post.ts";

const PREFIX = "ci-report:";

/** git's own default abbreviation: enough to open the commit, short enough to scan. */
const SHORT_SHA_CHARS = 7;

const shortSha = (commitSha: string): string =>
  commitSha.slice(0, SHORT_SHA_CHARS);

export type CiReportNotReportedReason = "no_token" | "no_hub_url" | "bad_hub_url";

const NOT_REPORTED_CLAUSES: Readonly<Record<CiReportNotReportedReason, string>> = {
  no_token:
    "CROSSCHECK_CI_TOKEN is not set in this environment (a fork pull request has no repository secrets)",
  no_hub_url: "CROSSCHECK_HUB_URL is not set in this environment",
  bad_hub_url: "CROSSCHECK_HUB_URL is not an http(s) URL",
};

/**
 * §8.3's one line: inform, never block. Exit 0 is the caller's; this is the
 * sentence that says WHY the hub will show `unknown` at this commit.
 */
export const ciReportNotReportedLine = (
  commitSha: string,
  reason: CiReportNotReportedReason,
): string =>
  `${PREFIX} not reported — ${NOT_REPORTED_CLAUSES[reason]}; coverage.ci stays unknown at ${shortSha(commitSha)}\n`;

export type CiReportStage = "primary" | "same_job";

export interface CiReportRunView {
  readonly commitSha: string;
  readonly job: string;
  readonly leg: string;
  readonly runAttempt: number;
  readonly stage: CiReportStage;
  /** Files handed to the re-run; 0 on the primary. */
  readonly rerunFiles: number;
  readonly tests: number;
  readonly failures: number;
  readonly skipped: number;
  /** Rows on the wire, after the cap. */
  readonly rowsSent: number;
  /** Non-green rows before the cap, so a truncation is said with its size. */
  readonly nonGreen: number;
  readonly ambiguousDropped: number;
  readonly outcome: string;
  readonly stored: { readonly status: string; readonly id: string };
}

const laneLabel = (job: string, leg: string): string => {
  const safeJob = bareUntrusted(job, MAX_CI_LANE_FIELD_CHARS);
  return leg.length === 0
    ? safeJob
    : `${safeJob}/${bareUntrusted(leg, MAX_CI_LANE_FIELD_CHARS)}`;
};

const stageLabel = (view: CiReportRunView): string =>
  view.stage === "primary"
    ? "primary"
    : `same_job re-run of ${String(view.rerunFiles)} file(s)`;

/** THE CUT IS SAID WHENEVER IT HAPPENED: a bound spent in silence is a coverage claim nobody made. */
const rowsClause = (view: CiReportRunView): string =>
  view.nonGreen > view.rowsSent
    ? `rows sent ${String(view.rowsSent)} of ${String(view.nonGreen)} non-green`
    : `rows sent ${String(view.rowsSent)}`;

export const ciReportRunLine = (view: CiReportRunView): string => {
  const head = `${PREFIX} ${shortSha(view.commitSha)} ${laneLabel(view.job, view.leg)} attempt ${String(view.runAttempt)} (${stageLabel(view)}):`;
  const counts = [
    `tests ${String(view.tests)}`,
    `failed ${String(view.failures)}`,
    `skipped ${String(view.skipped)}`,
    rowsClause(view),
    `ambiguous dropped ${String(view.ambiguousDropped)}`,
    `outcome ${view.outcome}`,
    `hub ${view.stored.status} ${view.stored.id}`,
  ];
  return `${head} ${counts.join(" · ")}\n`;
};

export type CiReportHubFailure = Exclude<CiRunPostOutcome, { kind: "stored" }>;

const hubSaid = (message: string): string =>
  bareUntrusted(message, MAX_HUB_MESSAGE_CHARS);

const failureClause = (failure: CiReportHubFailure): string => {
  switch (failure.kind) {
    case "network":
      return `hub unreachable (${hubSaid(failure.message)})`;
    case "refused":
      return `the hub refused this run (HTTP ${String(failure.httpStatus)}: ${hubSaid(failure.message)})`;
    case "malformed":
      return `the hub's answer did not parse (${hubSaid(failure.message)})`;
  }
};

/**
 * THREE OUTCOMES, NEVER TWO — `suspect`'s rule: a hub that could not answer
 * must never read like a hub that recorded the run. The consequence names
 * the stage, because a lost primary and a lost re-run leave the hub in
 * different states: nothing at all, or a red run waiting on a re-run.
 */
export const ciReportHubFailureLine = (
  commitSha: string,
  stage: CiReportStage,
  failure: CiReportHubFailure,
): string => {
  const consequence =
    stage === "primary"
      ? `this run is not recorded and no re-run was attempted; coverage.ci stays unknown at ${shortSha(commitSha)}`
      : "the re-run is not recorded; the primary run stays awaiting a re-run of this commit";
  return `${PREFIX} ${shortSha(commitSha)}: ${failureClause(failure)} — ${consequence}\n`;
};
