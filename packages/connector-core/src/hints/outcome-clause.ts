/**
 * The one clause a delivered hint ends with on a repo that records outcomes
 * (1.0 spec 07 §13): how the reader's agent says what the hint led to.
 *
 * A MODULE OF ITS OWN, not a line in hints/render.ts, so the hint's content
 * and this clause can change on different branches without touching the same
 * text: the renderer decides what a hint says, this only appends one sentence
 * after it, in the flow, the way the coverage note is appended.
 *
 * FACTUAL, NEVER IMPERATIVE — the rule every hint sentence keeps (render.ts
 * header): it states what the tool records, with the argument the call needs,
 * and asks for nothing.
 *
 * THE CLAUSE NEVER COSTS THE HINT. It is appended only when the whole text
 * still fits the wire cap, and dropped otherwise; a hint cut to make room for
 * a request to talk about the hint would be the wrong trade.
 */
import { MAX_HINT_TEXT_LENGTH } from "@crosscheck/schema";

import { MAX_BRIEFING_CHARS } from "../constants.ts";
import { safeId } from "../mcp/render.ts";

/** The sentence, naming the ref the hint delivered — the id the tool takes. */
export const outcomeClause = (refId: string): string =>
  `mark_hint_outcome ${safeId(refId)} records whether you followed it or deliberately went another way.`;

/** Appended when the whole text still fits its channel's cap; otherwise the text as it was. */
const appendWithin = (text: string, clause: string, cap: number): string => {
  if (text.length === 0) {
    return text;
  }
  const joined = `${text}\n${clause}`;
  return joined.length <= cap ? joined : text;
};

export const withOutcomeClause = (hint: string, refId: string): string =>
  appendWithin(hint, outcomeClause(refId), MAX_HINT_TEXT_LENGTH);

/**
 * THE TRIPWIRE ASK HAS NO CAP — a handful of short lines on a PreToolUse ask
 * (render.ts `EditWarningInput`), the coverage note appended outright for the
 * same reason — so its clause is too. Silence still stays silence.
 */
export const appendOutcomeClause = (ask: string, refId: string): string =>
  appendWithin(ask, outcomeClause(refId), Number.POSITIVE_INFINITY);

/**
 * THE BRIEFING'S ONE CLAUSE, for its solved pointers: several may show, each
 * line already carrying its `get_diagnosis <id>`, so the sentence names the
 * id the line names rather than one of them. Appended last, and only while
 * the whole briefing still fits MAX_BRIEFING_CHARS — the section budget is
 * the briefing's, and this sentence never takes a teammate's line from it.
 */
export const BRIEFING_OUTCOME_CLAUSE =
  "mark_hint_outcome with the work context id a solved line names records whether you followed it or deliberately went another way.";

export const withBriefingOutcomeClause = (briefing: string): string =>
  appendWithin(briefing, BRIEFING_OUTCOME_CLAUSE, MAX_BRIEFING_CHARS);
