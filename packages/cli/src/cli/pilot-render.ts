/**
 * `crosscheck pilot` — the five proofs, as a person reads them (1.0 spec 07 §5).
 *
 * EVERY FIGURE IS MEASURED OR SAYS WHY NOT, and this is the last place that
 * rule can be lost. The hub keeps it as a type; a renderer that prints
 * `value ?? 0`, skips an empty channel, or cuts the list away from the count
 * it explains would print a tidier report that says something nobody
 * measured. So: an unavailable figure prints its reason and never a digit, a
 * surface nobody counted prints `not instrumented` and never a zero, and
 * an opened count that cannot name the prior work it pointed at is withheld.
 *
 * ONE WORD NEVER APPEARS, AND ONE APPEARS IN ONE PLACE ONLY (§8.1, §12).
 * "Prevented" is a counterfactual nobody observed — the report says
 * surfaced, opened, converged. "Helpful" is a human verdict: since §12 a
 * person can give it (`crosscheck pilot label`), so it names that label and
 * nothing else — never the line about the MODEL pulling a pointer through
 * `get_diagnosis`, whose column is "opened".
 *
 * NO PERSON APPEARS (§8.4). The hub sends no developer id, no name and no
 * per-person grouping, so there is nothing here to leak. Two pieces of
 * author-written text reach this page: a work-context TITLE — the prior work
 * an opened pointer named — and, since §12, the optional REASON a person
 * typed beside a label. Both are framed as quoted data, which is why this
 * surface is registered in the framed class with the notice on its own line.
 */
import {
  MAX_HUB_MESSAGE_CHARS,
  MAX_WORK_CONTEXT_TITLE_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import { MAX_PILOT_LABEL_REASON_CHARS } from "@crosscheck/schema";
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
  PilotCohortFigures,
  PilotFigure,
  PilotLabelFigures,
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

/** A ratio prints as a whole percentage, for RATE_DECIMALS' reason: the count beside it carries the rest. */
const PERCENT = 100;

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
  no_asking_host: "no session in this window ran on a host that can ask before an edit",
  no_labels: "nobody has labelled an intervention helpful or noise yet",
  no_interventions: "nothing arrived unasked, so there was nothing to label",
};

const isKnownReason = (reason: string): reason is PilotUnavailableReason =>
  Object.hasOwn(REASON_SENTENCE, reason);

const count = (value: number): string => value.toLocaleString("en-US");

/**
 * `unavailable — <why>`, or `unavailable (<word>)` for a reason this client
 * has no sentence for. Exported because `doctor` prints the same absences and
 * must use the same words — two phrasings of one absence would read as two
 * different facts.
 */
export const unavailableClause = (reason: string): string =>
  isKnownReason(reason)
    ? `unavailable — ${REASON_SENTENCE[reason]}`
    : `unavailable (${bareUntrusted(reason)})`;

/** `<label> <value>`, or `<label> unavailable — <why>`. Never a digit for "not measured". */
const figure = (
  label: string,
  value: PilotFigure,
  decimals: number = 0,
): string =>
  value.kind === "measured"
    ? `${label} ${decimals === 0 ? count(value.value) : value.value.toFixed(decimals)}`
    : `${label} ${unavailableClause(value.reason)}`;

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
    `${INDENT}not scored: the fix touched only pinned files ${count(tally(view.fixes, "not_discriminating"))} · empty range ${count(tally(view.fixes, "empty"))} · too broad ${count(tally(view.fixes, "too_broad"))} · not resolvable on this clone ${count(unresolvable)}`,
    `${INDENT}one verdict per fix: ${count(proof.supersededAnswers)} earlier answer(s) replaced · ${count(proof.answersAfterRepair)} given after the repair, not scored`,
    ...(proof.repairedWithoutBreakCommit > 0
      ? [`${INDENT}${count(proof.repairedWithoutBreakCommit)} repaired break(s) recorded no commit at the break, so there is no fix range to score`]
      : []),
    ...(proof.repairedBeyondBound > 0
      ? [`${INDENT}(+${count(proof.repairedBeyondBound)} repaired past the diff bound, not scored)`]
      : []),
    ...(unresolvable > 0
      ? [`${INDENT}${count(unresolvable)} fix range(s) are not in this clone — run git fetch, then this command again`]
      : []),
  ];
};

/** A ratio as a whole percentage, or `unavailable — <why>`. Never "0%" for "not measured". */
const percent = (value: PilotFigure): string =>
  value.kind === "measured"
    ? `${String(Math.round(value.value * PERCENT))}%`
    : unavailableClause(value.reason);

/** `<label> <rate> <unit> per 100 sessions`, or `<label> unavailable — <why>` — `figure`'s rule. */
const perHundred = (label: string, value: PilotFigure, unit: string): string =>
  value.kind === "measured"
    ? `${figure(label, value, RATE_DECIMALS)} ${unit} per 100 sessions`
    : figure(label, value);

/**
 * THE LABELLED FIGURES (07 §12), and PRECISION NEVER PRINTS ALONE: its
 * verdict count and the label coverage share its line, so a precision from
 * three labels out of forty interventions cannot be read as a result.
 * `unclear` abstained from the denominator and is printed beside it, so it
 * can be neither hidden nor scored.
 */
const labelledLines = (proof: PilotReport["precision"]): readonly string[] => {
  const verdicts = proof.helpful + proof.noise;
  const precision =
    proof.precision.kind === "measured"
      ? `precision ${percent(proof.precision)} (${count(proof.helpful)} helpful of ${count(verdicts)} verdicts; target ${percent({ kind: "measured", value: proof.precisionTarget })}, declared before measuring)`
      : `precision ${percent(proof.precision)}`;
  const coverage =
    proof.labelCoverage.kind === "measured"
      ? `label coverage ${percent(proof.labelCoverage)} (${count(proof.labelled)} of ${count(proof.interventions)} interventions labelled)`
      : `label coverage ${percent(proof.labelCoverage)}`;
  return [
    `${INDENT}${perHundred("benefit", proof.benefitPer100, "helpful")} · ${perHundred("burden", proof.burdenPer100, "interventions")}`,
    `${INDENT}${precision} · ${coverage} · unclear ${count(proof.unclear)} (abstained, not in the denominator)`,
  ];
};

/**
 * THE SENTENCES PEOPLE TYPED, quoted as data. The label word comes off the
 * wire as an open string and prints bare; the reason is a person's prose and
 * is framed and bounded exactly like a title. No list, no lines.
 */
const reasonLines = (proof: PilotReport["precision"]): readonly string[] =>
  proof.reasons.length === 0 && proof.reasonsBeyondList === 0
    ? []
    : [
        `${INDENT}reasons people gave, newest first:`,
        ...proof.reasons.map(
          (said) =>
            `${INDENT}  ${bareUntrusted(said.label)}: ${quoted(said.reason, MAX_PILOT_LABEL_REASON_CHARS)}`,
        ),
        ...(proof.reasonsBeyondList > 0
          ? [`${INDENT}  (+${count(proof.reasonsBeyondList)} more, not listed)`]
          : []),
      ];

/** One cohort on one line, its own population; an empty one says so and nothing else. */
const cohortLine = (cohort: PilotCohortFigures): string => {
  const full = cohort.sessions >= cohort.cap ? " (full — membership frozen)" : "";
  const head = `${INDENT}  ${bareUntrusted(cohort.cohort)} ${count(cohort.sessions)}/${count(cohort.cap)} sessions${full}`;
  if (cohort.sessions === 0) {
    return `${head} — empty`;
  }
  const rate = (value: PilotFigure): string =>
    value.kind === "measured" ? value.value.toFixed(RATE_DECIMALS) : unavailableClause(value.reason);
  const verdicts =
    cohort.precision.kind === "measured"
      ? ` (${count(cohort.helpful)} of ${count(cohort.helpful + cohort.noise)})`
      : "";
  return `${head} · interventions ${count(cohort.interventions)} · benefit ${rate(cohort.benefitPer100)} · burden ${rate(cohort.burdenPer100)} · precision ${percent(cohort.precision)}${verdicts} · coverage ${percent(cohort.labelCoverage)} · unclear ${count(cohort.unclear)}`;
};

const cohortLines = (cohorts: readonly PilotCohortFigures[]): readonly string[] => [
  `${INDENT}cohorts, side by side — each over its own sessions, whatever the window:`,
  ...cohorts.map(cohortLine),
];

/**
 * PROOF 4, REVISED (07 §12): the human labels carry the figures; the pull
 * and the noisy-session floor stay, each named as what it is.
 */
/**
 * WHERE THE LABELLED FIGURES START, when that is not the window's start
 * (second review, H1, M5): sessions that began before labels were available
 * could not be labelled, so the hub leaves them out, and a reader must not
 * take the figures for the whole window.
 */
const labelledSinceLines = (report: PilotReport): readonly string[] => {
  const from = report.precision.labelledSinceIso;
  return from === null || from === report.sinceIso
    ? []
    : [
        `${INDENT}labelled figures count sessions from ${isoDay(from)}, when labels became available here — earlier ones could not be labelled`,
      ];
};

/** 0.10's one word, counted and kept outside precision — it never had a `helpful` beside it. */
const legacyNoiseLines = (proof: PilotReport["precision"]): readonly string[] =>
  proof.legacyNoise === 0
    ? []
    : [
        `${INDENT}noise marks from before labels (off_target) ${count(proof.legacyNoise)} — outside precision: nobody could label those interventions helpful`,
      ];

const precisionLines = (report: PilotReport): readonly string[] => {
  const proof = report.precision;
  return [
    "4. proactive precision — what arrived unasked, as the person it reached labelled it",
    ...labelledSinceLines(report),
    ...labelledLines(proof),
    `${INDENT}behavioural signal: ${figure("opened per 100 sessions", proof.openedPer100, RATE_DECIMALS)} (target ${count(proof.openedTargetPer100)}, declared before measuring) — the agent pulled it; no person judged it`,
    `${INDENT}${figure("noisy sessions per 100", proof.noisySessionsPer100, RATE_DECIMALS)} (ceiling ${count(proof.noisySessionsCeilingPer100)}) — a FLOOR: labels are voluntary`,
    ...legacyNoiseLines(proof),
    `${INDENT}surface-ok marks ${count(proof.surfaceOkMarks)}`,
    ...reasonLines(proof),
    ...cohortLines(report.cohorts),
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
  return [
    // "Emitted" and "missed" are NOT printed: the hub attaches the record to
    // every answer it builds, so a hub-side count could only equal the number
    // required. Whether a surface printed it is the render registry's fact.
    `${INDENT}${name}: answers ${count(at("answers_emitted"))} · qualifier required ${count(at("qualifier_required"))} (whether each reached its reader is held by the render registry, not counted here)`,
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
/**
 * A lone surrogate is replaced too: `JSON.stringify` writes one as `\ud800`,
 * which is the backslash escape this output promises never to contain
 * (found by adversarial review).
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const jsonSafe = (raw: string): string =>
  sanitizeUntrusted(raw.replace(LONE_SURROGATE, "\uFFFD"), MAX_PIN_PATH_CHARS)
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
    // TWO KEYS THAT CLEAN TO ONE must not overwrite each other: a count that
    // arrived would read as the other key's zero (found by adversarial
    // review). The later one keeps its value under a numbered name.
    const seen = new Set<string>();
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => {
        const base = jsonSafe(key);
        let name = base;
        for (let copy = 2; seen.has(name); copy += 1) {
          name = `${base} #${String(copy)}`;
        }
        seen.add(name);
        return [name, cleanDeep(inner)];
      }),
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
    `${headerLine(report)} · ${count(report.precision.sessions)} sessions · session set ${count(set.used)}/${count(set.cap)} (discovery ${count(set.discovery)}/${count(set.discoveryCap)} · replication ${count(set.replication)}/${count(set.replicationCap)}), ${count(set.refused)} refused at the cap${
      set.legacy > 0 ? ` · ${count(set.legacy)} recorded before labels, in neither cohort` : ""
    }`,
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
