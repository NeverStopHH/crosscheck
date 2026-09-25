/**
 * Hint rendering — teammate-authored text landing UNASKED in a healthy
 * session, which makes this the highest-risk injection surface in the product
 * (DESIGN.md §10 risk 2). It therefore builds from the SAME three classes the
 * briefing and the MCP tools use, imported rather than re-typed:
 *
 *   LABEL  — `quoted` (mcp/render.ts): sanitize + « » frame, blanked whole if
 *            the phrase filter matches. Titles. One definition, already covered
 *            by the frame mutation in scripts/mutation-check.ts.
 *   BODY   — `quotedBody` (mcp/render.ts): the same frame and the same cap,
 *            with the phrase filter narrowed to the SPAN it matched (audit row
 *            M14). Claim bodies, answers, the question an answer replies to —
 *            everything whose text IS the answer rather than a name for one.
 *   BARE   — `bareUntrusted` (briefing/sanitize.ts) for short fields outside
 *            the frame: author names, kinds, statuses, branches.
 *   ID     — `safeId` (mcp/render.ts): allowlisted, an agent passes it back.
 *
 * There is no fifth path, and LABEL/BODY differ in exactly one branch — both
 * still NFKC-normalize, strip the invisibles, strip the characters the renderer
 * owns and cap the length. Every line carries at most one « » pair — the
 * notice, which contains its own pair, gets a line to itself, the same lesson
 * the MCP search header learned (mcp/render.ts `searchHeader`).
 *
 * Everything here is FACTUAL statement, never imperative: "X recorded", "is
 * readable with get_diagnosis" — imperatives in injected context are what §4
 * forbids and what prompt-injection defences trip on.
 */
import {
  MAX_HINT_TEXT_LENGTH,
  MAX_QUESTION_BODY_LENGTH,
} from "@crosscheck/schema";

import {
  LANDED_RECENT_WORKING_DAYS,
  MAX_LANDED_COMMITS_SHOWN,
  MAX_LANDED_WHY_SHOWN,
  MAX_WORK_CONTEXT_TITLE_CHARS,
  UNSOLICITED_CLAIM_BODY_MAX_CHARS,
} from "../constants.ts";
import type { LandedChanges, LandedCommit } from "../landed-changes/probe.ts";
import { namedLandedCommits } from "../landed-changes/named-commits.ts";
import { renderIntent } from "../briefing/intent.ts";

import type { EvidenceAxes } from "@crosscheck/schema";
import {
  NO_AXES_FROM_HUB,
  NO_AXES_READABLE,
  axesLabel,
} from "@crosscheck/schema";

import { coverageNote } from "../coverage/render.ts";
import { UNKNOWN_COVERAGE } from "../http/coverage.ts";
import type { CoverageRecord } from "../http/coverage.ts";
import {
  QUOTED_DATA_NOTICE,
  SUBSTANCE_MATCH_KIND,
  UNKNOWN_AUTHOR,
  formatAge,
  formatSolvedAge,
  formatSolvedLine,
} from "../briefing/render.ts";
import { bareUntrusted as bare } from "../briefing/sanitize.ts";
import { claimValidityWord } from "../briefing/render.ts";
import { quoted, quotedBody, safeId } from "../mcp/render.ts";
import type { CommitDrift } from "../git/commit-drift.ts";
import type {
  AnsweredQuestion,
  HintClaimCandidate,
  HintContextCandidate,
  LandedContextMatch,
  SolvedMatchEntry,
  TripwireSession,
} from "../http/hub.ts";

const CONFIDENCE_DECIMALS = 2;

const CLAIM_HEADER = `crosscheck hint: a teammate's recorded finding may relate to this prompt. ${QUOTED_DATA_NOTICE}`;
const POINTER_HEADER = `crosscheck pointer: a teammate has notes that may relate to this prompt. ${QUOTED_DATA_NOTICE}`;
/**
 * The ANSWER header, and the one word in it that matters is "asked": this is
 * the §4 solicited exception, so the sentence states out loud that the
 * substance below was requested by this session. A reader who cannot tell an
 * answer from an unsolicited teammate claim has lost the distinction the
 * exception rests on.
 */
const ANSWER_HEADER = `crosscheck answer: a teammate answered a question you asked. ${QUOTED_DATA_NOTICE}`;

type HintContext = HintContextCandidate["workContext"];

/**
 * DESIGN.md §4's exact phrasing: drift is stated against the READER's HEAD.
 * `behind` = commits the reader has that the teammate's base does not.
 */
const driftLabel = (drift: CommitDrift | null): string => {
  if (drift === null || (drift.ahead === 0 && drift.behind === 0)) {
    return "";
  }
  if (drift.behind > 0) {
    return ` · based on a commit ${String(drift.behind)} behind yours`;
  }
  return ` · based on a commit ${String(drift.ahead)} ahead of yours`;
};

const authorLabel = (name: string | undefined): string => {
  const sanitized = name === undefined ? "" : bare(name);
  return sanitized.length === 0 ? UNKNOWN_AUTHOR : sanitized;
};

/**
 * The solved fact, with its plain age (VISION.md §1 honest presentation).
 * Strict equality on the wire value and a renderer-built sentence — the kind
 * string itself is never printed, so no fourth untrusted path opens here.
 * Empty for open contexts, unknown kinds, and unparseable timestamps: an
 * undecorated hint, never a wrong label.
 *
 * WHAT THE SENTENCE MAY SAY (audit row A2-6). It used to read "from a
 * diagnosis marked solved 5mo ago", and nothing on this hub is ever MARKED
 * solved: solvedness is derived fresh on every read from the tree itself — a
 * standing `likely_root_cause` that is declared, evidence-backed, not
 * superseded and not deadlocked (packages/server/src/services/solved.ts) — so
 * there is no flag, nobody who set it, and no way to unset it. The timestamp
 * is not a marking either: `solvedAt` is the newest qualifying claim's own
 * createdAt, which is exactly why the briefing spells the identical value
 * "diagnosed 5mo ago" (briefing/render.ts formatSolvedLine). The label now
 * states what actually happened — somebody recorded a root cause, and this is
 * how long ago — which is both true and the reason a reader should weigh this
 * body differently from an open theory.
 */
const solvedLabel = (context: HintContext, now: Date): string => {
  if (context.resultKind !== "solved") {
    return "";
  }
  const solvedMs =
    context.solvedAt === null || context.solvedAt === undefined
      ? Number.NaN
      : Date.parse(context.solvedAt);
  if (Number.isNaN(solvedMs)) {
    return "";
  }
  const age = formatSolvedAge(Math.max(0, now.getTime() - solvedMs));
  return ` · from a diagnosis whose root cause was recorded ${age} ago`;
};

/**
 * An age, or "an unknown time" — and a FUTURE instant counts as unknown.
 *
 * The clamp at zero printed a confident "0s ago" for any timestamp ahead of
 * the reader's clock, which is a guess dressed as a measurement. These
 * instants are client-supplied and unrange-checked, so a skewed machine — or
 * a publisher that wants its row to look like the freshest thing on the page
 * — produces exactly that. Moved in step with mcp/render.ts's `ageFragment`
 * so the two surfaces cannot disagree about the same instant.
 */
const ageLabel = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) || ms > now.getTime()
    ? "an unknown time"
    : `${formatAge(now.getTime() - ms)} ago`;
};

/**
 * The teammate's intent as its own line — `Their intent (derived): «…»` —
 * or no line at all (trial finding #16). One framed value, its own line, the
 * same fragment every surface spells (briefing/intent.ts); "Their" is the
 * factual, third-person framing every hint sentence keeps.
 */
const intentLines = (
  intent: Parameters<typeof renderIntent>[0],
): readonly string[] => {
  const fragment = renderIntent(intent);
  return fragment === null ? [] : [`Their ${fragment}`];
};

/**
 * Joins lines under the wire cap for a rendered hint. Dropping from the END,
 * never truncating a line: a cut mid-frame would leave « unclosed, and the
 * trailing lines are the droppable context, not the substance. Empty when not
 * even the first two lines fit — silence beats a broken frame.
 */
const fitHint = (lines: readonly string[]): string => {
  const kept = lines.reduce<readonly string[]>((accumulated, line) => {
    const candidate = [...accumulated, line];
    return candidate.join("\n").length <= MAX_HINT_TEXT_LENGTH
      ? candidate
      : accumulated;
  }, []);
  return kept.length < 2 ? "" : kept.join("\n");
};

/**
 * §5.1's SOFT rule on a hint, with one priority that is not negotiable: THE
 * CLAUSE NEVER COSTS THE HINT.
 *
 * `fitHint` above drops from the TAIL and returns "" below two kept lines, so
 * a clause appended blindly is either the first casualty (harmless) or pushes
 * the hint itself under the floor — a silence nobody asked for, on the one
 * surface whose whole job is to say something. So it is appended only when
 * the whole thing still fits, and dropped otherwise. `crosscheck status` and
 * `doctor` carry the state every time, so nothing is invisible.
 *
 * A SILENT PATH STAYS SILENT. §5.1 forbids EMITTING an empty-result phrasing
 * over a gap; it does not compel speech where there was none. Turning the
 * hint flow's eight silent branches into a coverage line would put an
 * unsolicited sentence on every prompt of every repo with a gap, inside an
 * 800 ms budget, which is the noise §5.1 itself argues against.
 */
export const withCoverageNote = (
  hint: string,
  coverage: CoverageRecord,
  now: Date,
): string => {
  if (hint.length === 0) {
    return hint;
  }
  const note = coverageNote(coverage, now);
  if (note === null) {
    return hint;
  }
  const joined = `${hint}\n${note}`;
  return joined.length <= MAX_HINT_TEXT_LENGTH ? joined : hint;
};

export interface ClaimHintInput {
  readonly claim: HintClaimCandidate;
  readonly context: HintContext;
  readonly drift: CommitDrift | null;
  readonly now: Date;
}

const validityWordFact = (
  claim: HintClaimCandidate,
): readonly string[] => {
  const word = claimValidityWord(claim.validity);
  return word === null ? [] : [word];
};

/**
 * The evidence labels for a hint, or a sentence saying there are none.
 *
 * THE SHORT FORM, WITHOUT THE COMMIT HASH — 02's rule for an unsolicited
 * surface, applied to 08's clause. A sha spends characters a hint does not
 * have and anchors a session on a commit nobody asked about; the full clause,
 * with its age and its hash, stays on the pulled surfaces.
 *
 * NEVER SILENCE. A missing label leaves the confidence standing alone, which
 * 08 §3.6 names as the failure mode. The two absences are told apart because
 * the remedies differ — a hub that does not report one, against a label this
 * build cannot read.
 */
const axesFact = (axes: EvidenceAxes | undefined): readonly string[] => {
  if (axes === undefined) {
    return [NO_AXES_FROM_HUB];
  }
  const label = axesLabel(axes);
  return label.length === 0 ? [NO_AXES_READABLE] : [label];
};

/** Substance: one evidence-backed claim, under every trust label §4 names. */
export const renderClaimHint = (input: ClaimHintInput): string => {
  const { claim, context, drift, now } = input;
  const facts = [
    `- ${authorLabel(claim.authorDeveloperName)}`,
    bare(claim.kind),
    `status ${bare(claim.status)}`,
    `confidence ${claim.confidence.toFixed(CONFIDENCE_DECIMALS)}`,
    // THE LABELS TRAVEL WITH THE NUMBER (08 §3.6, EV-5), and on this surface
    // more than any other: a hint is UNSOLICITED. Nobody asked for it, it
    // lands in an agent's context, and a bare `confidence 0.80` there reads as
    // a measurement of something. The clause is what lets the reader discount
    // it, so it goes beside the number rather than anywhere else.
    ...axesFact(claim.axes),
    `provenance ${bare(claim.provenance)}`,
    ageLabel(claim.createdAt, now),
    // THE STATE WORD GOES HERE, NOT ON A LINE OF ITS OWN, and that placement
    // is the whole point. `fitHint` below drops lines from the END and
    // returns "" when fewer than two survive, so only CLAIM_HEADER and this
    // line are guaranteed to reach the reader — an appended validity line is
    // the first thing dropped, and a downgrade nobody sees is not a
    // downgrade. The hashes stay off this surface entirely (spec 02 §5a): a
    // hint is unsolicited, and three commit hashes anchor a session on a file
    // history nobody asked about. They are one get_diagnosis away.
    ...validityWordFact(claim),
  ];
  const factsLine = `${facts.join(" · ")}${driftLabel(drift)}${solvedLabel(context, now)}: ${quotedBody(claim.body, UNSOLICITED_CLAIM_BODY_MAX_CHARS)}`;
  const contextLine =
    `Recorded on work context ${safeId(context.id)} ${quoted(context.title, MAX_WORK_CONTEXT_TITLE_CHARS)} — ` +
    "the full tree is readable with get_diagnosis.";
  return fitHint([CLAIM_HEADER, factsLine, contextLine, ...intentLines(context.intent)]);
};

export interface PointerHintInput {
  readonly context: HintContext;
  /** What the pointer withholds — a count; this input carries no body. */
  readonly claimCount: number;
  /**
   * Trial finding #19: a file the prompt named that the context touched. When
   * present the pointer is TARGETS-ONLY (claimCount 0) and its tail states the
   * touched-file fact instead of a claim count. `value` is teammate-controlled
   * (a path they edited), so it goes through `bare()` + the title cap — no new
   * untrusted path opens. `createdAt` null renders "age unknown", never a
   * fabricated age.
   */
  readonly matchedTarget?: {
    readonly value: string;
    readonly createdAt: string | null;
  };
  readonly drift: CommitDrift | null;
  readonly now: Date;
}

/**
 * The targets-only tail (#19): the touched-file fact, no body. `bare()` + the
 * title cap because the path is teammate-controlled; the age is "recorded
 * <age> ago" only when the target carries a timestamp, else the honest
 * "age unknown".
 */
const targetsPointerTail = (
  context: HintContext,
  matchedTarget: NonNullable<PointerHintInput["matchedTarget"]>,
  now: Date,
): string => {
  const age =
    matchedTarget.createdAt === null
      ? "age unknown"
      : `recorded ${ageLabel(matchedTarget.createdAt, now)}`;
  return (
    `It touched ${bare(matchedTarget.value, MAX_WORK_CONTEXT_TITLE_CHARS)} ` +
    `(${age}) and carries no claims crosscheck injects unasked; the tree is ` +
    `readable with get_diagnosis ${safeId(context.id)}.`
  );
};

/**
 * A pointer: id + title only (§4 anchoring asymmetry — unconfirmed substance
 * is pulled deliberately, never pushed). The input type has no body field, so
 * no wording change here can leak one — a targets-only pointer (#19) adds a
 * touched-file fact, still no body.
 *
 * The stated intent rides on its own line whenever the context carries one,
 * and an intent-only context — the "same topic, different files" case, no
 * claims and no named file — earns the same pointer with a tail that says so
 * (trial finding #16).
 */
export const renderPointerHint = (input: PointerHintInput): string => {
  const { context, claimCount, matchedTarget, drift, now } = input;
  const facts = [
    `- ${authorLabel(context.developerName)}`,
    `work context ${safeId(context.id)}`,
    `status ${bare(context.status)}`,
    ageLabel(context.updatedAt ?? context.createdAt, now),
  ];
  const factsLine = `${facts.join(" · ")}${driftLabel(drift)}${solvedLabel(context, now)}: ${quoted(context.title, MAX_WORK_CONTEXT_TITLE_CHARS)}`;
  const tailLine =
    matchedTarget !== undefined
      ? targetsPointerTail(context, matchedTarget, now)
      : claimCount === 0
        ? "It carries no claims yet (substance is pushed only for evidence-backed findings); " +
          `the tree is readable with get_diagnosis ${safeId(context.id)}.`
        : `It carries ${String(claimCount)} claim${claimCount === 1 ? "" : "s"} crosscheck does not ` +
          "inject unasked (substance is pushed only for evidence-backed findings); the tree is " +
          `readable with get_diagnosis ${safeId(context.id)}.`;
  // The intent BEFORE the tail: fitHint drops from the end, and of the two
  // the tail is the droppable one — the intent is what says WHAT they do.
  return fitHint([POINTER_HEADER, factsLine, ...intentLines(context.intent), tailLine]);
};

/**
 * An ANSWER to a question this developer asked (roadmap R2) — the one
 * proactive surface in this file that shows a claim body without demanding
 * evidence and a settled status first.
 *
 * THAT IS THE EXCEPTION, NOT A HOLE, and DESIGN.md §4 states it as its own
 * rule: the anchoring asymmetry exists because UNSOLICITED substance can
 * anchor a healthy agent on somebody else's wrong theory. An answer was
 * asked for by this session, about a question this session wrote, so the
 * reader already holds the frame it lands in. The hub is what makes that
 * true rather than the wording: a row only reaches this renderer when the
 * caller is the question's AUTHOR (services/questions.ts).
 *
 * Everything else is unchanged. The answer is still one claim under the full
 * trust labels — author, kind, status, confidence, provenance, age — still
 * PROSE-framed, still bounded, and an unsolicited claim by the same author
 * still renders as a pointer (test/hint-select.test.ts pins that).
 */
export const renderAnswerHint = (
  answer: AnsweredQuestion,
  now: Date,
): string => {
  const facts = [
    `- ${authorLabel(answer.answererDeveloperName)}`,
    bare(answer.claimKind),
    `status ${bare(answer.claimStatus)}`,
    `confidence ${answer.confidence.toFixed(CONFIDENCE_DECIMALS)}`,
    ...axesFact(answer.axes),
    `provenance ${bare(answer.provenance)}`,
    ageLabel(answer.answeredAt, now),
  ];
  const answerLine = `${facts.join(" · ")}: ${quotedBody(answer.claimBody, UNSOLICITED_CLAIM_BODY_MAX_CHARS)}`;
  // The question on its own line, because both are framed values and every
  // line here carries at most one « » pair.
  const questionLine = `You asked ${safeId(answer.questionId)}: ${quotedBody(answer.questionBody, MAX_QUESTION_BODY_LENGTH)}`;
  // THE NEXT ACTION CARRIES ITS ARGUMENT. get_diagnosis takes exactly one — a
  // work-context id — so naming the tool without it sent the reader's agent to
  // invent an id and collect "Ids are not guessable". An older hub that sends
  // no context id loses the clause rather than keeping an unusable one.
  const contextId =
    answer.workContextId === undefined ? "" : safeId(answer.workContextId);
  const tree =
    contextId.length === 0
      ? ""
      : `, and get_diagnosis ${contextId} reads the tree it sits in`;
  const tailLine =
    `It is recorded as claim ${safeId(answer.claimId)} — name that claim id as evidence ` +
    `when you record what it supports${tree}.`;
  return fitHint([ANSWER_HEADER, answerLine, questionLine, tailLine]);
};

/**
 * The failure-time solved hint (VISION.md §1): the tool this session just
 * ran failed, the failure's fingerprint is one a diagnosis on this hub
 * already settled, and this is the sentence that says so — at the moment
 * the symptom appeared rather than at the next SessionStart, which on a
 * long agent turn can be an hour of re-deriving an answer the team owns.
 *
 * The BODY of the line is `formatSolvedLine`, imported rather than re-typed:
 * the briefing renders the same fact, and the day one of them learns to name
 * the repo or to quote the cause, both must. Only the header is local, and
 * it states WHY this arrived — a factual sentence, never an imperative.
 *
 * "" when the row is one `formatSolvedLine` will not vouch for (an id that
 * survives nothing, an unknown match kind, a foreign repo it cannot print)
 * — or one whose kind does not support the header, below.
 *
 * THE HEADER IS ITSELF A CLAIM, and the kind check is what makes it true.
 * It asserts CONTENT IDENTITY: the failure just recorded is byte-identical,
 * after normalization, to one somebody already settled. Only
 * SUBSTANCE_MATCH_KIND says that. Every other kind `formatSolvedLine` can
 * render — a shared file, an overlap with the reader's session intent —
 * would put "same error fingerprint" above a line reading "shared file with
 * current work", two sentences contradicting each other in one block.
 *
 * It is reachable, not hypothetical: a hub that predates `?fingerprint=`
 * ignores the parameter and answers the ordinary shared-target listing on
 * the same route (http/hub.ts), which is precisely a page of file- and
 * intent-matched rows. The connector ships ahead of the hub often enough
 * that this is the ordinary upgrade order, not a hostile case.
 */
const SOLVED_HINT_HEADER = `crosscheck: the failure just recorded carries the same error fingerprint as a diagnosis that was solved. ${QUOTED_DATA_NOTICE}`;

export const renderSolvedHint = (
  entry: SolvedMatchEntry,
  repoId: string,
  now: Date,
): string => {
  if (entry.matchedTargetKind !== SUBSTANCE_MATCH_KIND) {
    return "";
  }
  const line = formatSolvedLine(entry, now, repoId);
  return line === null ? "" : fitHint([SOLVED_HINT_HEADER, line]);
};

/** A live teammate session on the file: three factual lines, no imperative. */
const liveTripwireLines = (
  session: TripwireSession,
  repoRelativeFile: string,
  now: Date,
  coverage: CoverageRecord,
): readonly string[] => {
  const who = authorLabel(session.developerName);
  const overlapLine =
    `crosscheck: ${who} has an active session on branch ${bare(session.branch)} ` +
    `(status ${bare(session.status)}, heartbeat ${ageLabel(session.lastHeartbeatAt, now)}) ` +
    `whose work context targeted ${bare(repoRelativeFile, MAX_WORK_CONTEXT_TITLE_CHARS)}.`;
  const contextLine = `Their work context ${quoted(session.workContextTitle, MAX_WORK_CONTEXT_TITLE_CHARS)} is readable with get_diagnosis ${safeId(session.workContextId)}.`;
  const note = coverageNote(coverage, now);
  return [
    overlapLine,
    contextLine,
    ...intentLines(session.workContextIntent),
    ...(note === null ? [] : [note]),
  ];
};

const branchList = (branches: readonly string[]): string =>
  branches.map((branch) => bare(branch)).join(" and ");

/** `- 0dcfc4e «subject» by Mike, <trailer>` — subject and author are theirs. */
const landedCommitLine = (commit: LandedCommit, trailer: string): string =>
  `- ${safeId(commit.shortSha)} ${quoted(commit.subject, MAX_WORK_CONTEXT_TITLE_CHARS)} ` +
  `by ${authorLabel(commit.authorName)}, ${trailer}`;

/**
 * The first MAX_LANDED_COMMITS_SHOWN commits, then a count of the rest — "or
 * more" when the probe stopped reading before it ran out — then the one
 * command that shows exactly the commits named, so the stop is one command
 * away from its evidence (written bare: no renderer here emits a backtick).
 */
const commitBlock = (
  commits: readonly LandedCommit[],
  line: (commit: LandedCommit) => string,
  options: { readonly isPartial: boolean; readonly seeLabel: string },
): readonly string[] => {
  const shown = commits.slice(0, MAX_LANDED_COMMITS_SHOWN);
  const rest = commits.length - shown.length;
  const more = options.isPartial ? "or more" : "more";
  const restLine =
    rest > 0 ? [`(+${String(rest)} ${more})`] : options.isPartial ? ["(and possibly more)"] : [];
  return [
    ...shown.map(line),
    ...restLine,
    `${options.seeLabel}: git show ${shown.map((commit) => safeId(commit.shortSha)).join(" ")}`,
  ];
};

/**
 * The teammate work behind the named commits (docs/1.0/landed-changes.md,
 * step 3): the live half's shape — a pointer, then the intent — once per
 * work context, at most MAX_LANDED_WHY_SHOWN. A probable match said as one:
 * "work on this file before it landed", never "the reason for this commit"
 * (decision 6). Decisions and rejected approaches stay one get_diagnosis away
 * (pointers proactive, substance pulled). A match for a commit the stop did
 * not name is not printed, whatever the hub sent.
 */
const whyLines = (
  why: readonly LandedContextMatch[],
  input: { readonly landed: LandedChanges; readonly file: string; readonly now: Date; readonly liveContextId: string | null },
): readonly string[] => {
  const named = new Set(namedLandedCommits(input.landed).map((commit) => commit.sha));
  const byContext = new Map<string, LandedContextMatch>();
  for (const match of why) {
    // The live half already named this work context, with its intent.
    const isLive = match.workContextId === input.liveContextId;
    if (named.has(match.sha) && !isLive && !byContext.has(match.workContextId)) {
      byContext.set(match.workContextId, match);
    }
  }
  const path = bare(input.file, MAX_WORK_CONTEXT_TITLE_CHARS);
  return [...byContext.values()].slice(0, MAX_LANDED_WHY_SHOWN).flatMap((match) => [
    `${authorLabel(match.developerName)}'s work on ${path} before it landed ` +
      `(started ${match.workStartedAt === undefined ? "at an unknown time" : ageLabel(match.workStartedAt, input.now)}): ` +
      `work context ${quoted(match.title, MAX_WORK_CONTEXT_TITLE_CHARS)}, readable with get_diagnosis ${safeId(match.workContextId)}.`,
    ...intentLines(match.intent),
  ]);
};

/**
 * Landed changes to the file (docs/1.0/landed-changes.md): the ones this
 * checkout is MISSING first — they are what an edit can undo — then the
 * recent ones it already has. The author's email is the probe's matching key
 * and is never printed.
 */
const landedLines = (landed: LandedChanges, repoRelativeFile: string, now: Date): readonly string[] => {
  const path = bare(repoRelativeFile, MAX_WORK_CONTEXT_TITLE_CHARS);
  const missing =
    landed.missing.length === 0
      ? []
      : [
          `crosscheck: ${path} has landed changes your checkout does not contain yet; ` +
            "editing it now can undo or duplicate them:",
          ...commitBlock(
            landed.missing,
            (commit) =>
              landedCommitLine(
                commit,
                `on ${branchList(commit.branches)}, committed ${ageLabel(commit.committedAt.toISOString(), now)}`,
              ),
            { isPartial: landed.moreMissing, seeLabel: "To see them" },
          ),
          ...(landed.unchecked.length === 0
            ? []
            : [`Not checked in time: ${branchList(landed.unchecked)}; changes there may be missing too.`]),
        ];
  const recent =
    landed.recent.length === 0
      ? []
      : [
          `crosscheck: ${path} changed on a landing branch in the last ` +
            `${String(LANDED_RECENT_WORKING_DAYS)} working days; your checkout has it:`,
          ...commitBlock(
            landed.recent,
            (commit) =>
              landedCommitLine(
                commit,
                `landed on ${branchList(commit.branches)} ` +
                  (commit.landedAt === null
                    ? "at an unknown time"
                    : ageLabel(commit.landedAt.toISOString(), now)),
              ),
            { isPartial: false, seeLabel: "To see what changed" },
          ),
        ];
  return [...missing, ...recent];
};

export interface EditWarningInput {
  /** An active teammate session that targeted the file, if any. */
  readonly live: TripwireSession | null;
  /** Landed changes to the file, or null when unknown. */
  readonly landed: LandedChanges | null;
  readonly file: string;
  readonly now: Date;
  /**
   * How far the archive behind the LIVE part reaches (03 §3.5). No cap
   * applies to this surface — a handful of short lines on a PreToolUse ask —
   * so the note is appended outright rather than fitted.
   */
  readonly coverage?: CoverageRecord;
  /** The hub's match of the named commits to teammate work (step 3). */
  readonly why?: readonly LandedContextMatch[];
}

/**
 * The PreToolUse ask-reason: facts, no imperative, and the escalation ladder
 * stops at "ask" — nothing in this module or its caller can emit a different
 * permission decision (hooks/pre-tool-use.ts pins that). The live part comes
 * first, the landed part second, ONE quoted-data notice for both. Empty when
 * there is nothing to say.
 */
export const renderEditWarning = (input: EditWarningInput): string => {
  const live =
    input.live === null
      ? []
      : liveTripwireLines(input.live, input.file, input.now, input.coverage ?? UNKNOWN_COVERAGE);
  const landed =
    input.landed === null
      ? []
      : [
          ...landedLines(input.landed, input.file, input.now),
          ...whyLines(input.why ?? [], {
            landed: input.landed,
            file: input.file,
            now: input.now,
            liveContextId: input.live?.workContextId ?? null,
          }),
        ];
  return live.length === 0 && landed.length === 0
    ? ""
    : [...live, ...landed, QUOTED_DATA_NOTICE].join("\n");
};

/** The live-only ask-reason — byte-identical to what it always was. */
export const renderTripwireReason = (
  session: TripwireSession,
  repoRelativeFile: string,
  now: Date,
  coverage: CoverageRecord = UNKNOWN_COVERAGE,
): string => renderEditWarning({ live: session, landed: null, file: repoRelativeFile, now, coverage });
