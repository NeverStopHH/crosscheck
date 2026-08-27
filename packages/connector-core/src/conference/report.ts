/**
 * The conference REPORT (VISION.md §2): one Markdown page a human reads in a
 * minute, written locally by `crosscheck conference`.
 *
 * IT IS A CASE FILE, NEVER A VERDICT, and that is the whole design. VISION §2
 * names this the riskiest of the four capabilities for one reason: a
 * confidently wrong "common root cause" delivered at standup is worse than
 * three separate honest investigations. The multi-agent-debate literature
 * measures the same failure from the other side — agents align on the first
 * confident assertion and lock in a false consensus — so this report never
 * runs a debate, never reconciles positions, and never states a conclusion of
 * its own. Three of its four sections are DETERMINISTIC facts out of the hub
 * (contradiction candidates, duplicated work, unanswered questions); the
 * fourth carries at most CONFERENCE_MAX_FINDINGS sentences from ONE bounded
 * model pass, each printed above the claims it was derived from, with author,
 * kind, status, confidence, provenance and age — the referee shape §4 asks
 * for.
 *
 * WHAT IT MAY QUOTE. Declared claim bodies, which any teammate on this hub can
 * already pull with `get_diagnosis`, and which the reader ASKED for by typing
 * the command — the anchoring asymmetry governs what is injected unasked, and
 * nothing here is injected at all. What it may NOT quote is a QUESTION body:
 * the hub sends none (services/conference.ts), so a question appears as who is
 * waiting on whom and for how long.
 *
 * EVERY SECTION SPEAKS WHEN IT IS EMPTY. "Nothing to synthesize" is a finding
 * — the spec's own requirement — and a section that silently disappears is
 * indistinguishable from a section that failed.
 *
 * A registered §4.4 render surface (conference-report), covered by the hostile
 * corpus with the payload in every untrusted slot: developer names, titles,
 * intents, claim bodies and their labels, shared target values, and the model's
 * own sentence.
 *
 * DESIGN.md §4 states this feature's bounds as figures, and a document that
 * disagrees with the code is worse than one that stays quiet — DESIGN is where
 * a reviewer checks whether the bound they were promised is the bound that
 * runs. verify-claims does not scan Markdown, so the doc is pinned from here
 * instead. Thousands separators are normalised because the prose writes
 * "12 000" where the constant is 12000.
 *
 * VERIFY: bun -e 'const d=(await Bun.file("docs/DESIGN.md").text()).replace(/(\d) (\d)/g,"$1$2");const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/server/src/constants.ts");console.log(["`CONFERENCE_MAX_FINDINGS` = "+c.CONFERENCE_MAX_FINDINGS,"`CONFERENCE_MAX_CONTEXTS` = "+s.CONFERENCE_MAX_CONTEXTS,"`CONFERENCE_MAX_CLAIMS_PER_CONTEXT` = "+s.CONFERENCE_MAX_CLAIMS_PER_CONTEXT,"`CONFERENCE_MAX_INPUT_CHARS` = "+c.CONFERENCE_MAX_INPUT_CHARS,"`CONFERENCE_MAX_WALL_MS` = "+c.CONFERENCE_MAX_WALL_MS/1000+" s","`CONFERENCE_DERIVED_CONFIDENCE` = "+c.CONFERENCE_DERIVED_CONFIDENCE,"last "+s.CONFERENCE_ACTIVE_WINDOW_DAYS+" days"].every((x)=>d.includes(x)))'
 * PRINTS: true
 */
import {
  CONFERENCE_BODY_MAX_CHARS,
  CONFERENCE_MAX_EVIDENCE_PER_CONTEXT,
  CONFERENCE_MAX_FINDINGS,
  CONFERENCE_SENTENCE_MAX_CHARS,
  GHOST_SHARED_VALUE_MAX_CHARS,
  MAX_HUB_MESSAGE_CHARS,
  MAX_TITLE_CHARS,
} from "../constants.ts";
import { QUOTED_DATA_NOTICE, formatAge } from "../briefing/render.ts";
import { bareUntrusted, safeId, sanitizeUntrusted } from "../briefing/sanitize.ts";
import type {
  ConferenceClaim,
  ConferenceContext,
  ConferenceCorpus,
} from "../http/hub.ts";

/** A teammate the hub named nothing for — the briefing's own fallback. */
const UNKNOWN_TEAMMATE = "a teammate";

/**
 * The kind whose identity is CONTENT. Named as a fact on the line rather than
 * printed, exactly as briefing/ghost.ts does with the same value.
 */
const FINGERPRINT_KIND = "error_fingerprint";

/** What the model said, and WHICH sessions it said it about. */
export interface ConferenceFinding {
  /** One sentence, already bounded, echo-checked and secret-scanned. */
  readonly sentence: string;
  /**
   * The contexts the finding is about, resolved DETERMINISTICALLY from the
   * label the model was shown. The model never sees a person's name — it is
   * given "SESSION A", the ghost check's rule — so it cannot invent an
   * attribution, and this is where the real one is attached.
   */
  readonly contexts: readonly ConferenceContext[];
}

/**
 * Why the shared-cause section says what it says. There is no fifth state and
 * no silent one: a run that spent nothing has to explain itself as loudly as a
 * run that found something.
 */
export type ConferenceModelOutcome =
  | { readonly kind: "answered" }
  | { readonly kind: "none" }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface ConferenceReportInput {
  readonly repoId: string;
  readonly corpus: ConferenceCorpus;
  readonly findings: readonly ConferenceFinding[];
  readonly modelOutcome: ConferenceModelOutcome;
  readonly now: Date;
}

/** "1 open question" / "2 open questions" — a tired reader notices. */
const plural = (count: number, singular: string): string =>
  `${String(count)} ${singular}${count === 1 ? "" : "s"}`;

const ageMsFrom = (iso: string, now: Date): number | null => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : now.getTime() - ms;
};

const ageOf = (iso: string, now: Date): string | null => {
  const ageMs = ageMsFrom(iso, now);
  return ageMs === null ? null : formatAge(ageMs);
};

const nameOf = (raw: string | undefined | null): string => {
  const name = raw === undefined || raw === null ? "" : bareUntrusted(raw);
  return name.length === 0 ? UNKNOWN_TEAMMATE : name;
};

/** A title as the one framed value of its line, or null when nothing survives. */
const titleFragment = (raw: string): string | null => {
  const title = sanitizeUntrusted(raw, MAX_TITLE_CHARS);
  return title.length === 0 ? null : `«${title}»`;
};

/**
 * One work context as the line that names its owner, its plan and the call
 * that reads it. Null when the id is not one this renderer will print: a
 * pointer whose id the allowlist rejects has no next action, and a line with
 * no next action is what §8 of the spec calls a bare id.
 */
const contextLine = (
  context: ConferenceContext,
  indent: string,
): string | null => {
  const id = safeId(context.id);
  if (id.length === 0) {
    return null;
  }
  const title = titleFragment(context.title);
  return `${indent}- ${nameOf(context.developerName)}: ${
    title === null ? "an untitled piece of work" : title
  } — get_diagnosis ${id}`;
};

/**
 * A claim as EVIDENCE: every trust label an injected claim carries
 * (DESIGN.md §4), then the body inside the one frame the line is allowed.
 */
const evidenceLine = (
  claim: ConferenceClaim,
  now: Date,
  indent: string,
): string | null => {
  const body = sanitizeUntrusted(claim.body, CONFERENCE_BODY_MAX_CHARS);
  if (body.length === 0) {
    return null;
  }
  const age = ageOf(claim.createdAt, now);
  const labels = [
    `${nameOf(claim.authorDeveloperName)} recorded ${bareUntrusted(claim.kind)} (${bareUntrusted(claim.status)})`,
    `confidence ${String(claim.confidence)}`,
    `provenance ${bareUntrusted(claim.provenance)}`,
    ...(age === null ? [] : [`${age} ago`]),
  ];
  return `${indent}- ${labels.join(" · ")}: «${body}»`;
};

const findingLines = (
  finding: ConferenceFinding,
  now: Date,
): readonly string[] => {
  const sentence = sanitizeUntrusted(finding.sentence, CONFERENCE_SENTENCE_MAX_CHARS);
  if (sentence.length === 0) {
    return [];
  }
  const sides = finding.contexts.flatMap((context) => {
    const line = contextLine(context, "  ");
    if (line === null) {
      return [];
    }
    const evidence = context.claims
      .slice(0, CONFERENCE_MAX_EVIDENCE_PER_CONTEXT)
      .flatMap((claim) => {
        const rendered = evidenceLine(claim, now, "    ");
        return rendered === null ? [] : [rendered];
      });
    return [line, ...evidence];
  });
  // A sentence with no side left to open is a claim about nobody: dropped
  // whole, like every other pointer here that lost its next action.
  return sides.length === 0 ? [] : [`- «${sentence}»`, ...sides];
};

const SHARED_CAUSE_HEADER = "## Shared root-cause candidates";

const SHARED_CAUSE_NOTE =
  "One model pass over the intents and declared claims below. Derived and " +
  "unconfirmed: nobody has vouched for these sentences, and each is printed " +
  "above the claims it was drawn from so you can check it in a minute.";

const outcomeLine = (outcome: ConferenceModelOutcome): string => {
  if (outcome.kind === "none") {
    return "The model compared these sessions and found no shared cause.";
  }
  if (outcome.kind === "skipped") {
    return `No model call was made: ${bareUntrusted(outcome.reason, MAX_HUB_MESSAGE_CHARS)}.`;
  }
  if (outcome.kind === "failed") {
    return `The model call did not answer: ${bareUntrusted(outcome.reason, MAX_HUB_MESSAGE_CHARS)}.`;
  }
  return "";
};

const sharedCauseSection = (input: ConferenceReportInput): readonly string[] => {
  const rendered = input.findings
    .slice(0, CONFERENCE_MAX_FINDINGS)
    .flatMap((finding) => findingLines(finding, input.now));
  if (rendered.length === 0) {
    const outcome = outcomeLine(input.modelOutcome);
    return [
      SHARED_CAUSE_HEADER,
      // An "answered" outcome that rendered nothing means every sentence lost
      // its sides or its text — said plainly rather than as an empty section.
      outcome.length === 0
        ? "The model answered, but nothing it said could be attributed to two sessions."
        : outcome,
    ];
  }
  return [SHARED_CAUSE_HEADER, SHARED_CAUSE_NOTE, ...rendered];
};

const contradictionSection = (
  input: ConferenceReportInput,
): readonly string[] => {
  const lines = input.corpus.contradictions.flatMap((entry) => {
    const id = safeId(entry.id);
    if (id.length === 0) {
      return [];
    }
    const left = `${nameOf(entry.claimA.authorDeveloperName)} (${bareUntrusted(entry.claimA.kind)}, ${bareUntrusted(entry.claimA.status)})`;
    const right = `${nameOf(entry.claimB.authorDeveloperName)} (${bareUntrusted(entry.claimB.kind)}, ${bareUntrusted(entry.claimB.status)})`;
    return [
      `- ${left} and ${right} hold opposite positions, found by ${bareUntrusted(entry.reason)} — get_referee_brief ${id}`,
    ];
  });
  return [
    "## Contradictions worth refereeing",
    ...(lines.length === 0
      ? [
          // Scoped, because the hub's answer is: the tier is bounded to the
          // contexts printed above (services/contradictions.ts
          // liveSideWorkContextIds), so "on this repo" would be a wider claim
          // than the read behind it.
          "No claim in the work read above is contradicted by a rejected one.",
        ]
      : lines),
  ];
};

/**
 * WHY the pair is a pair, in the ghost line's own words: a shared failure is
 * reported as a FACT rather than as 39 characters of sha256 nobody can read,
 * and the files are named so the claim is checkable. Empty means the row
 * carries no reason a reader could evaluate, and the pair is dropped —
 * prediction theatre is the failure this whole feature is trying not to be.
 */
const overlapClauses = (
  overlap: ConferenceCorpus["overlaps"][number],
): readonly string[] => {
  const sample = overlap.sharedTargets;
  const failure = sample.some((target) => target.kind === FINGERPRINT_KIND)
    ? ["hit the same failure"]
    : [];
  const named = sample
    .filter((target) => target.kind !== FINGERPRINT_KIND)
    .map((target) => bareUntrusted(target.value, GHOST_SHARED_VALUE_MAX_CHARS))
    .filter((value) => value.length > 0);
  const hidden = Math.max(0, overlap.sharedTargetCount - sample.length);
  const more = hidden === 0 ? "" : ` (+${String(hidden)} more)`;
  const values = named.length === 0 ? [] : [`both changed ${named.join(", ")}${more}`];
  return [...failure, ...values];
};

const overlapSection = (input: ConferenceReportInput): readonly string[] => {
  const byId = new Map(
    input.corpus.contexts.map((context) => [context.id, context]),
  );
  const lines = input.corpus.overlaps.flatMap((overlap) => {
    const left = byId.get(overlap.workContextIdA);
    const right = byId.get(overlap.workContextIdB);
    if (left === undefined || right === undefined) {
      return [];
    }
    const leftLine = contextLine(left, "  ");
    const rightLine = contextLine(right, "  ");
    if (leftLine === null || rightLine === null) {
      return [];
    }
    const clauses = overlapClauses(overlap);
    if (clauses.length === 0) {
      return [];
    }
    return [
      `- ${nameOf(left.developerName)} and ${nameOf(right.developerName)} ${clauses.join(", ")}`,
      leftLine,
      rightLine,
    ];
  });
  return [
    "## Duplicated work",
    ...(lines.length === 0
      ? ["No two people on this repo are working the same files or the same failure."]
      : lines),
  ];
};

const questionLine = (
  question: ConferenceCorpus["questions"][number],
  now: Date,
): string | null => {
  const id = safeId(question.id);
  if (id.length === 0) {
    return null;
  }
  const age = ageOf(question.createdAt, now);
  const waited = age === null ? "" : ` for ${age}`;
  const asker = nameOf(question.authorDeveloperName);
  // The call ONLY when this reader may answer — the hub decides that
  // (isForReader), never the renderer, and a call the reader cannot make
  // would be the "next action" that fails.
  const next = question.isForReader ? ` — answer_question ${id}` : ` — ${id}`;
  const target =
    question.targetDeveloperName === undefined || question.targetDeveloperName === null
      ? null
      : bareUntrusted(question.targetDeveloperName);
  if (target !== null && target.length > 0) {
    return `- ${asker} has been waiting on ${target}${waited}${next}`;
  }
  const title =
    question.workContextTitle === undefined || question.workContextTitle === null
      ? null
      : titleFragment(question.workContextTitle);
  return title === null
    ? `- ${asker} has been waiting${waited}${next}`
    : `- ${asker} has been waiting${waited} for an answer about ${title}${next}`;
};

const questionSection = (input: ConferenceReportInput): readonly string[] => {
  const lines = input.corpus.questions.flatMap((question) => {
    const line = questionLine(question, input.now);
    return line === null ? [] : [line];
  });
  return [
    "## Questions nobody has answered",
    ...(lines.length === 0 ? ["No question on this repo is still open."] : lines),
  ];
};

/**
 * What the run READ, so the reader can tell a quiet team from a short read.
 * The window count is a floor when the hub capped it, and the sentence says
 * so — a number that silently means "or more" is the kind of figure this
 * project's telemetry rules exist to prevent.
 */
const coverageLine = (corpus: ConferenceCorpus): string => {
  const claims = corpus.contexts.reduce(
    (total, context) => total + context.claims.length,
    0,
  );
  const total = corpus.contextsInWindowCapped
    ? `${String(corpus.contextsInWindow)} or more`
    : String(corpus.contextsInWindow);
  return (
    `Read ${String(corpus.contexts.length)} of ${total} work contexts active in the ` +
    `last ${plural(corpus.windowDays, "day")}, ${plural(claims, "declared claim")}, ` +
    `${plural(corpus.questions.length, "open question")} and ` +
    `${plural(corpus.contradictions.length, "contradiction candidate")}.`
  );
};

/** The whole page. Never empty: a conference that found nothing says so. */
export const renderConferenceReport = (input: ConferenceReportInput): string => {
  const repo = sanitizeUntrusted(input.repoId, MAX_TITLE_CHARS);
  const stamp = input.now.toISOString().replace("T", " ").slice(0, 16);
  return [
    `# Team conference — ${repo.length === 0 ? "this repo" : repo} — ${stamp} UTC`,
    "",
    QUOTED_DATA_NOTICE,
    coverageLine(input.corpus),
    "Nothing here blocks anybody and nothing here is a verdict: every line " +
      "names the call that reads the work it came from.",
    "",
    ...sharedCauseSection(input),
    "",
    ...contradictionSection(input),
    "",
    ...overlapSection(input),
    "",
    ...questionSection(input),
    "",
  ].join("\n");
};
