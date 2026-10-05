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

import { safeId } from "../mcp/render.ts";

/** The sentence, naming the ref the hint delivered — the id the tool takes. */
export const outcomeClause = (refId: string): string =>
  `mark_hint_outcome ${safeId(refId)} records whether you followed it or deliberately went another way.`;

export const withOutcomeClause = (hint: string, refId: string): string => {
  if (hint.length === 0) {
    return hint;
  }
  const joined = `${hint}\n${outcomeClause(refId)}`;
  return joined.length <= MAX_HINT_TEXT_LENGTH ? joined : hint;
};
