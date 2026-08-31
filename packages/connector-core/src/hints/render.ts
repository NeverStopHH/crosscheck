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
  MAX_WORK_CONTEXT_TITLE_CHARS,
  UNSOLICITED_CLAIM_BODY_MAX_CHARS,
} from "../constants.ts";
import { renderIntent } from "../briefing/intent.ts";
import {
  QUOTED_DATA_NOTICE,
  SUBSTANCE_MATCH_KIND,
  UNKNOWN_AUTHOR,
  formatAge,
  formatSolvedAge,
  formatSolvedLine,
} from "../briefing/render.ts";
import { bareUntrusted as bare } from "../briefing/sanitize.ts";
import { quoted, quotedBody, safeId } from "../mcp/render.ts";
import type { CommitDrift } from "../git/commit-drift.ts";
import type {
  AnsweredQuestion,
  HintClaimCandidate,
  HintContextCandidate,
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

export interface ClaimHintInput {
  readonly claim: HintClaimCandidate;
  readonly context: HintContext;
  readonly drift: CommitDrift | null;
  readonly now: Date;
}

/** Substance: one evidence-backed claim, under every trust label §4 names. */
export const renderClaimHint = (input: ClaimHintInput): string => {
  const { claim, context, drift, now } = input;
  const facts = [
    `- ${authorLabel(claim.authorDeveloperName)}`,
    bare(claim.kind),
    `status ${bare(claim.status)}`,
    `confidence ${claim.confidence.toFixed(CONFIDENCE_DECIMALS)}`,
    `provenance ${bare(claim.provenance)}`,
    ageLabel(claim.createdAt, now),
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

/**
 * The PreToolUse ask-reason: three factual lines, no imperative, and the
 * escalation ladder stops at "ask" — nothing in this module or its caller can
 * emit a different permission decision (hooks/pre-tool-use.ts pins that).
 */
export const renderTripwireReason = (
  session: TripwireSession,
  repoRelativeFile: string,
  now: Date,
): string => {
  const who = authorLabel(session.developerName);
  const overlapLine =
    `crosscheck: ${who} has an active session on branch ${bare(session.branch)} ` +
    `(status ${bare(session.status)}, heartbeat ${ageLabel(session.lastHeartbeatAt, now)}) ` +
    `whose work context targeted ${bare(repoRelativeFile, MAX_WORK_CONTEXT_TITLE_CHARS)}.`;
  const contextLine = `Their work context ${quoted(session.workContextTitle, MAX_WORK_CONTEXT_TITLE_CHARS)} is readable with get_diagnosis ${safeId(session.workContextId)}.`;
  return [
    overlapLine,
    contextLine,
    ...intentLines(session.workContextIntent),
    QUOTED_DATA_NOTICE,
  ].join("\n");
};
