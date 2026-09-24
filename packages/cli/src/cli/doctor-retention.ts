/**
 * WHAT THE SKELETON SWEEP IS KEEPING, AND WHY (1.0 spec 01a §5).
 *
 * The mode line beside this one says whether the hub retires session events
 * at all. This line says what that retention is holding back — because every
 * KEEP in 01a is conservative on purpose, and a conservative rule nobody can
 * see the price of is indistinguishable from a leak. So each reason gets its
 * number: the roots (with the spec that still owes a root its liveness rule),
 * the file identities the hub could not resolve, what the interim mode holds
 * back, the sessions the reaper closed, and the pins that freeze their repo.
 *
 * THE NUMBERS ARE THE LAST COMPLETED CYCLE'S, and the line says when that
 * was: the hub judges its sessions window by window and publishes each full
 * cycle, so the counts are the deleting statement's own judgement, not a
 * second query that could disagree with it.
 *
 * WARN only for the states in which the sweep is not doing what the mode line
 * says: held by a root nobody built, or failing. Everything else is a
 * decision working as decided, and reads PASS with its cost beside it.
 *
 * Counts, root names and pin ids from the hub's own vocabulary; the pin ids
 * were checked against the record-id alphabet before they got here.
 */
import { RETENTION_ROOT_LIVENESS_OWNER } from "@crosscheck/schema";
import type {
  RetentionRootName,
  SessionEventRetentionMode,
  SkeletonRetentionReport,
} from "@crosscheck/schema";
import type { UnreadableSkeletonReport } from "@crosscheck/connector-core/http/hub.ts";

import type { Check } from "./doctor.ts";

const NAME = "skeleton retention";

const ROOT_LABEL: Readonly<Record<RetentionRootName, string>> = {
  claims: "claims",
  claim_edges: "claim edges",
  pins: "pinned files",
  intent_versions: "intent versions",
  pilot_sessions: "pilot session records",
  pilot_attributions: "pilot attributions",
};

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

const rootPart = (root: RetentionRootName, sessions: number): string => {
  const owner = RETENTION_ROOT_LIVENESS_OWNER[root];
  return `${ROOT_LABEL[root]} ${String(sessions)}${owner === null ? "" : ` (liveness owed by ${owner})`}`;
};

/** What the last cycle judged, in the mode the hub declares. */
const cycleParts = (
  report: SkeletonRetentionReport,
  mode: SessionEventRetentionMode | "unknown" | null,
): readonly string[] => {
  if (report.aged === 0) {
    return ["no explicitly ended session past the window held a skeleton"];
  }
  const roots = report.keptBy.filter((row) => row.sessions > 0);
  return [
    `${plural(report.aged, "explicitly ended session", "explicitly ended sessions")} past the window held a skeleton and ${String(report.swept)} ${report.swept === 1 ? "was" : "were"} retired`,
    roots.length === 0
      ? "no root reached any of them"
      : `reached by ${roots.map((row) => rootPart(row.root, row.sessions)).join(", ")}`,
    ...(report.unresolved === 0
      ? []
      : [`${String(report.unresolved)} kept because a file identity could not be resolved`]),
    ...(mode === "interim" && report.fileBearing > 0
      ? [`${String(report.fileBearing)} touched files, which this mode keeps whatever reaches them`]
      : []),
    "a session counts under every reason that keeps it",
  ];
};

const standingParts = (report: SkeletonRetentionReport): readonly string[] => [
  ...(report.reapedAwaitingEnd === 0
    ? []
    : [
        `${plural(report.reapedAwaitingEnd, "reaped session", "reaped sessions")} past the window ${report.reapedAwaitingEnd === 1 ? "is" : "are"} never retired while the end is only inferred from silence`,
      ]),
  ...(report.unresolvedPins === 0
    ? []
    : [
        `${plural(report.unresolvedPins, "pin", "pins")} on this hub cannot be tied to ${report.unresolvedPins === 1 ? "its files" : "their files"} (${report.unresolvedPinIds.join(", ")}${report.unresolvedPins > report.unresolvedPinIds.length ? ", …" : ""}), and each keeps every file-bearing session of its repo: \`crosscheck pin --sweep\` clears a pin whose file is only missing, and nothing in 1.0 clears one whose history lost a name`,
      ]),
];

const isUnreadable = (
  report: SkeletonRetentionReport | UnreadableSkeletonReport,
): report is UnreadableSkeletonReport => "unreadable" in report;

export const checkSkeletonRetention = (
  report: SkeletonRetentionReport | UnreadableSkeletonReport | null,
  mode: SessionEventRetentionMode | "unknown" | null,
): Check => {
  if (report === null) {
    return { level: "PASS", name: NAME, detail: "not measured" };
  }
  if (isUnreadable(report)) {
    const warn = report.held || (report.sweepFailures ?? 0) > 0;
    return {
      level: warn ? "WARN" : "PASS",
      name: NAME,
      detail: `the hub reports what it keeps in a form this crosscheck cannot read — upgrade the CLI to see it${
        warn ? "; it does say its sweep is held or has failed" : ""
      }`,
    };
  }
  if (report.heldBy.length > 0) {
    return {
      level: "WARN",
      name: NAME,
      detail: `the sweep is held and deletes nothing: ${report.heldBy.map((root) => ROOT_LABEL[root]).join(", ")} ${report.heldBy.length === 1 ? "is" : "are"} declared as a retention root and not built yet`,
    };
  }
  const cycle =
    report.completedAt === null
      ? [
          `the sweep has not finished a cycle over this hub's sessions since the hub started (${
            report.lastPassAt === null ? "no pass has run yet" : `last pass ${report.lastPassAt}`
          })`,
        ]
      : [`last full cycle ${report.completedAt}: ${cycleParts(report, mode).join("; ")}`];
  const sentence = [...cycle, ...standingParts(report)].join("; ");
  if (report.sweepFailures > 0) {
    return {
      level: "WARN",
      name: NAME,
      detail: `${plural(report.sweepFailures, "sweep pass", "sweep passes")} failed since the hub started, and a failed pass deletes nothing; ${sentence}`,
    };
  }
  return { level: "PASS", name: NAME, detail: sentence };
};
