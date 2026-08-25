/**
 * Hint rendering — teammate-authored text landing UNASKED in a healthy
 * session, which makes this the highest-risk injection surface in the product
 * (DESIGN.md §10 risk 2). It therefore builds from the SAME three classes the
 * briefing and the MCP tools use, imported rather than re-typed:
 *
 *   PROSE  — `quoted` (mcp/render.ts): sanitize + « » frame. One definition,
 *            already covered by the frame mutation in scripts/mutation-check.ts.
 *   BARE   — `bareUntrusted` (briefing/sanitize.ts) for short fields outside
 *            the frame: author names, kinds, statuses, branches.
 *   ID     — `safeId` (mcp/render.ts): allowlisted, an agent passes it back.
 *
 * There is no fourth path. Every line carries at most one « » pair — the
 * notice, which contains its own pair, gets a line to itself, the same lesson
 * the MCP search header learned (mcp/render.ts `searchHeader`).
 *
 * Everything here is FACTUAL statement, never imperative: "X recorded", "is
 * readable with get_diagnosis" — imperatives in injected context are what §4
 * forbids and what prompt-injection defences trip on.
 */
import { MAX_CLAIM_BODY_LENGTH, MAX_HINT_TEXT_LENGTH } from "@crosscheck/schema";

import { MAX_WORK_CONTEXT_TITLE_CHARS } from "../constants.ts";
import {
  QUOTED_DATA_NOTICE,
  UNKNOWN_AUTHOR,
  formatAge,
  formatSolvedAge,
} from "../briefing/render.ts";
import { bareUntrusted as bare } from "../briefing/sanitize.ts";
import { quoted, safeId } from "../mcp/render.ts";
import type { CommitDrift } from "../git/commit-drift.ts";
import type {
  HintClaimCandidate,
  HintContextCandidate,
  TripwireSession,
} from "../http/hub.ts";

const CONFIDENCE_DECIMALS = 2;

const CLAIM_HEADER = `crosscheck hint: a teammate's recorded finding may relate to this prompt. ${QUOTED_DATA_NOTICE}`;
const POINTER_HEADER = `crosscheck pointer: a teammate has notes that may relate to this prompt. ${QUOTED_DATA_NOTICE}`;

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
  return ` · from a diagnosis marked solved ${age} ago`;
};

const ageLabel = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms)
    ? "an unknown time"
    : `${formatAge(Math.max(0, now.getTime() - ms))} ago`;
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
  const factsLine = `${facts.join(" · ")}${driftLabel(drift)}${solvedLabel(context, now)}: ${quoted(claim.body, MAX_CLAIM_BODY_LENGTH)}`;
  const contextLine =
    `Recorded on work context ${safeId(context.id)} ${quoted(context.title, MAX_WORK_CONTEXT_TITLE_CHARS)} — ` +
    "the full tree is readable with get_diagnosis.";
  return fitHint([CLAIM_HEADER, factsLine, contextLine]);
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
    matchedTarget === undefined
      ? `It carries ${String(claimCount)} claim${claimCount === 1 ? "" : "s"} crosscheck does not ` +
        "inject unasked (substance is pushed only for evidence-backed findings); the tree is " +
        `readable with get_diagnosis ${safeId(context.id)}.`
      : targetsPointerTail(context, matchedTarget, now);
  return fitHint([POINTER_HEADER, factsLine, tailLine]);
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
  return [overlapLine, contextLine, QUOTED_DATA_NOTICE].join("\n");
};
