/**
 * `crosscheck pilot` — the five proofs, as a person reads them (1.0 spec 07 §5).
 *
 * EVERY FIGURE IS MEASURED OR SAYS WHY NOT, and this is the last place that
 * rule can be lost. The hub keeps it as a type; a renderer that prints
 * `value ?? 0`, skips an empty channel, or cuts the list away from the count
 * it explains would print a tidier report that says something nobody
 * measured. So: an unavailable figure prints its reason and never a digit, a
 * surface nobody counted prints `not instrumented` and never `missed 0`, and
 * an opened count that cannot name the prior work it pointed at is withheld.
 *
 * TWO WORDS NEVER APPEAR (§8.1). "Prevented" is a counterfactual nobody
 * observed — the report says surfaced, opened, converged. "Helpful" is a human
 * verdict, and what was measured is the MODEL pulling a pointer through
 * `get_diagnosis`; the column is "opened".
 *
 * NO PERSON APPEARS (§8.4). The hub sends no developer id, no name and no
 * per-person grouping, so there is nothing here to leak. The one piece of
 * author-written text is a work-context TITLE — the prior work an opened
 * pointer named — and it is framed as quoted data, which is why this surface
 * is registered in the framed class with the notice on its own line.
 */
import {
  MAX_HUB_MESSAGE_CHARS,
  MAX_WORK_CONTEXT_TITLE_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import { QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";
import {
  bareUntrusted,
  sanitizeUntrusted,
} from "@crosscheck/connector-core/briefing/sanitize.ts";
import {
  COVERAGE_SOURCES,
  COVERAGE_STATES,
} from "@crosscheck/connector-core/http/coverage.ts";
import { quoted, safeId } from "@crosscheck/connector-core/mcp/render.ts";
import { DELIVERY_CHANNELS, MAX_PIN_PATH_CHARS } from "@crosscheck/schema";
import type { PilotUnavailableReason } from "@crosscheck/schema";
import type { FixDiffOutcome } from "@crosscheck/connector-core/git/fix-diff.ts";
import type {
  PilotFigure,
  PilotRepair,
  PilotReport,
} from "@crosscheck/connector-core/http/pilot.ts";

export interface ScoredFix {
  readonly repair: PilotRepair;
  readonly outcome: FixDiffOutcome;
}

/** The hub's report, plus what this clone's git said about each repair. */
export interface PilotView {
  readonly report: PilotReport;
  readonly fixes: readonly ScoredFix[];
}

/** One decimal: a per-100 rate with more reads as a precision it does not have. */
const RATE_DECIMALS = 1;

const INDENT = "   ";

/**
 * ONE SENTENCE PER REASON. A reason this client has no sentence for is
 * printed as the word — a newer hub knowing an absence this client does not
 * is no reason to hide that the figure is absent.
 */
const REASON_SENTENCE: Readonly<Record<PilotUnavailableReason, string>> = {
  not_instrumented: "not instrumented",
  ghost_lines_not_recorded: "a ghost line is never recorded as a delivery",
  no_ci_reporter: "no CI reporter writes to this hub",
  no_sessions: "no sessions in this window",
  nothing_flagged: "nothing was flagged",
};

const isKnownReason = (reason: string): reason is PilotUnavailableReason =>
  Object.hasOwn(REASON_SENTENCE, reason);

const count = (value: number): string => value.toLocaleString("en-US");

/** `<label> <value>`, or `<label> unavailable — <why>`. Never a digit for "not measured". */
const figure = (
  label: string,
  value: PilotFigure,
  decimals: number = 0,
): string => {
  if (value.kind === "measured") {
    return `${label} ${decimals === 0 ? count(value.value) : value.value.toFixed(decimals)}`;
  }
  return isKnownReason(value.reason)
    ? `${label} unavailable — ${REASON_SENTENCE[value.reason]}`
    : `${label} unavailable (${bareUntrusted(value.reason)})`;
};

/** A wire instant as a UTC day, or "unknown" — never the raw string. */
const isoDay = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "unknown" : new Date(ms).toISOString().slice(0, 10);
};

const headerLine = (report: PilotReport): string =>
  `crosscheck pilot: ${bareUntrusted(report.repo)} · ${isoDay(report.sinceIso)}..${isoDay(report.untilIso)}`;

const notEnrolledLines = (report: PilotReport): readonly string[] => [
  headerLine(report),
  "not enrolled — nothing is measured on this repo, and nothing will be until the team decides it should be.",
  `${INDENT}whoever runs the hub enrols it with the admin token: PUT /api/team-settings {"repo":"${bareUntrusted(report.repo)}","pilotEnrolled":true}`,
];

/**
 * PIL-1: every channel, in the enum's order with `unknown` last, the empty
 * ones included — a bucket that reads zero really had none, because the
 * delivery table IS instrumented. A known channel the hub did not send says
 * so; a channel this client never heard of is printed after the rest.
 */
const channelLine = (byChannel: Readonly<Record<string, number>>): string => {
  const known = [
    ...DELIVERY_CHANNELS.filter((channel) => channel !== "unknown"),
    "unknown",
  ];
  const extra = Object.keys(byChannel)
    .filter((channel) => !(known as readonly string[]).includes(channel))
    .sort();
  const cell = (channel: string): string => {
    const value = byChannel[channel];
    return value === undefined
      ? `${bareUntrusted(channel)} not reported`
      : `${bareUntrusted(channel)} ${count(value)}`;
  };
  return `${INDENT}by channel: ${[...known, ...extra].map(cell).join(" · ")}`;
};

const duplicateWorkLines = (report: PilotReport): readonly string[] => {
  const work = report.duplicateWork;
  // PIL-2: a bare opened count is the counterfactual claim without the
  // counterfactual. If the hub could not name what the pointers pointed at,
  // the count — and the convergence derived from it — is withheld.
  const unnamed = work.opened > 0 && work.priorWork.length === 0;
  const opened = unnamed
    ? "opened and converged withheld — the prior work those pointers named could not be listed"
    : `opened ${count(work.opened)} · converged ${count(work.converged)}`;
  return [
    "1. duplicate work surfaced — what a pointer stopped cannot be observed, so it is never claimed",
    `${INDENT}surfaced ${count(work.surfaced)} · ${opened}`,
    channelLine(work.byChannel),
    ...(work.priorWork.length === 0
      ? []
      : [
          `${INDENT}the prior work each opened pointer named:`,
          ...work.priorWork.map(
            (prior) =>
              `${INDENT}  ${quoted(prior.title, MAX_WORK_CONTEXT_TITLE_CHARS)} ${safeId(prior.workContextId)} · opened by ${count(prior.openedBySessions)} session${prior.openedBySessions === 1 ? "" : "s"}`,
          ),
          ...(work.priorWorkBeyondList > 0
            ? [`${INDENT}  (+${count(work.priorWorkBeyondList)} more opened, not listed)`]
            : []),
        ]),
    `${INDENT}opened anyway: ${count(work.openedAnyway)} context${work.openedAnyway === 1 ? "" : "s"} did the work of a pointer they were shown and did not open`,
  ];
};

const collisionLines = (report: PilotReport): readonly string[] => {
  const flagged = report.collisions;
  return [
    "2. collisions flagged before merge — the sensor is file overlap only",
    `${INDENT}flagged: ${figure("tripwire", flagged.tripwireFlagged)} · ${figure("ghost", flagged.ghostFlagged)}`,
    `${INDENT}${figure("both landed", flagged.bothLanded)} — "did not both land" is not "was a false alarm"`,
    `${INDENT}${figure("ci regressed", flagged.ciRegressed)}`,
  ];
};

const tally = (fixes: readonly ScoredFix[], outcome: FixDiffOutcome): number =>
  fixes.filter((fix) => fix.outcome === outcome).length;

const attributionLines = (view: PilotView): readonly string[] => {
  const proof = view.report.attribution;
  const unresolvable = tally(view.fixes, "unresolvable");
  return [
    "3. attribution accuracy — each repair's fix diff, scored on this clone",
    `${INDENT}ranked answers on recorded-break pins ${count(proof.answers)} · attributions ${count(proof.attributions)} · repaired ${count(proof.repaired.length + proof.repairedBeyondBound)}`,
    `${INDENT}hit ${count(tally(view.fixes, "hit"))} · miss ${count(tally(view.fixes, "miss"))} · excluded (coverage gap at answer time) ${count(proof.excluded)} · no repair pin yet ${count(proof.noRepairYet)}`,
    `${INDENT}not scored: empty range ${count(tally(view.fixes, "empty"))} · too broad ${count(tally(view.fixes, "too_broad"))} · not resolvable on this clone ${count(unresolvable)}`,
    ...(proof.repairedBeyondBound > 0
      ? [`${INDENT}(+${count(proof.repairedBeyondBound)} repaired past the diff bound, not scored)`]
      : []),
    ...(unresolvable > 0
      ? [`${INDENT}${count(unresolvable)} fix range(s) are not in this clone — run git fetch, then this command again`]
      : []),
  ];
};

const precisionLines = (report: PilotReport): readonly string[] => {
  const proof = report.precision;
  return [
    "4. proactive precision",
    `${INDENT}${figure("opened per 100 sessions", proof.openedPer100, RATE_DECIMALS)} (target ${count(proof.openedTargetPer100)}, declared before measuring) — the agent pulled it; no person judged it`,
    `${INDENT}${figure("off-target marks per 100 sessions", proof.offTargetPer100, RATE_DECIMALS)} (ceiling ${count(proof.offTargetCeilingPer100)}) — a FLOOR: marks are voluntary`,
    `${INDENT}surface-ok marks ${count(proof.surfaceOkMarks)}`,
  ];
};

/**
 * WITHIN AN INSTRUMENTED SURFACE an absent counter is a measured zero: every
 * answer increments `answers_emitted`, one of the judgeability pair and one
 * state per source, so a counter that never moved had nothing to count. A
 * surface with NO counters at all is the other case, and prints as itself.
 */
const surfaceLines = (
  surface: string,
  counters: Readonly<Record<string, number>> | null,
): readonly string[] => {
  const name = bareUntrusted(surface);
  if (counters === null) {
    return [`${INDENT}${name}: not instrumented — it counted nothing in this window`];
  }
  const at = (key: string): number => counters[key] ?? 0;
  const required = at("qualifier_required");
  const emitted = at("qualifier_emitted");
  return [
    `${INDENT}${name}: answers ${count(at("answers_emitted"))} · qualifier required ${count(required)} · emitted ${count(emitted)} · missed ${count(Math.max(0, required - emitted))}`,
    `${INDENT}  judgeable ${count(at("judgeable"))} · not judgeable ${count(at("not_judgeable"))}`,
    ...COVERAGE_SOURCES.map(
      (source) =>
        `${INDENT}  ${source} ${COVERAGE_STATES.map((state) => `${state} ${count(at(`coverage_${source}_${state}`))}`).join(" · ")}`,
    ),
  ];
};

const integrityLines = (report: PilotReport): readonly string[] => [
  "5. coverage integrity in the wild — one line per source, never one number",
  ...report.integrity.flatMap((row) => surfaceLines(row.surface, row.counters)),
];

const sessionSetLines = (report: PilotReport): readonly string[] => {
  const set = report.sessionSet;
  return [
    `sequence: ${count(set.spanned)} spanned · ${count(set.restarted)} restarted (no span: the counter started over) · ${count(set.notRecorded)} not recorded`,
  ];
};

/**
 * `--json`: the same object, EVERY STRING CLEANED — keys included.
 *
 * Not the raw wire, and deliberately. An agent asked "how is the pilot
 * going" runs `crosscheck pilot --json` through Bash exactly as it runs the
 * text form, and a teammate's title reaching its context raw — no notice, no
 * clean — is the injection path the corpus exists to close, reopened by a
 * flag. So each string passes the same primitive every other surface uses,
 * and this output is registered as its own corpus surface in the `sanitized`
 * class: character invariants, and no frame at all, because JSON has none.
 *
 * AND NOTHING JSON WOULD HAVE TO ESCAPE. A `"` inside a title serializes as
 * `\"`, and a backslash is one of the characters no renderer here ever emits
 * — an escape sequence is exactly how text smuggles what the clean removed.
 * So the one printable character JSON escapes becomes `'` before it gets the
 * chance, and the output never needs a backslash at all.
 */
const jsonSafe = (raw: string): string =>
  sanitizeUntrusted(raw, MAX_PIN_PATH_CHARS)
    .replaceAll('"', "'")
    .replaceAll("\\", "");

const cleanDeep =(value: unknown): unknown => {
  if (typeof value === "string") {
    return jsonSafe(value);
  }
  if (Array.isArray(value)) {
    return value.map(cleanDeep);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        jsonSafe(key),
        cleanDeep(inner),
      ]),
    );
  }
  return value;
};

export const pilotJson = (view: PilotView): string =>
  `${JSON.stringify(
    cleanDeep({
      report: view.report,
      fixes: view.fixes.map((fix) => ({
        pinId: fix.repair.pinId,
        repairPinId: fix.repair.repairPinId,
        outcome: fix.outcome,
      })),
    }),
    null,
    2,
  )}\n`;

/**
 * THREE FAILURES, NEVER A REPORT. Each says the figures are unknown rather
 * than printing any: a hub that could not answer must not look like a hub
 * that answered zeros, and a report this client could not read must not be
 * printed half-read.
 */
export const pilotFailureLine = (
  kind: "network" | "http" | "malformed",
  message: string,
): string => {
  const said = bareUntrusted(message, MAX_HUB_MESSAGE_CHARS);
  switch (kind) {
    case "network":
      return `hub unreachable: ${said} — the pilot's figures are UNKNOWN, not zero\n`;
    case "malformed":
      return `the hub's pilot report could not be read (${said}) — nothing is printed rather than a figure nobody measured; update crosscheck to match the hub\n`;
    case "http":
      return `${said}\n`;
  }
};

export const renderPilot = (view: PilotView): string => {
  const report = view.report;
  if (!report.enrolled) {
    return `${notEnrolledLines(report).join("\n")}\n`;
  }
  const set = report.sessionSet;
  return [
    `${headerLine(report)} · ${count(report.precision.sessions)} sessions · session set ${count(set.used)}/${count(set.cap)}, ${count(set.refused)} refused at the cap`,
    QUOTED_DATA_NOTICE,
    ...duplicateWorkLines(report),
    ...collisionLines(report),
    ...attributionLines(view),
    ...precisionLines(report),
    ...integrityLines(report),
    ...sessionSetLines(report),
    "",
  ].join("\n");
};
