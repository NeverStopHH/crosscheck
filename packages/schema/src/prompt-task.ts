/**
 * WHAT A PROMPT ASKS THE HUB ABOUT (DESIGN.md §4; hold-out review round 5,
 * C1) — one rule, called by the connector before it asks and by the hub for
 * every connector already installed, so the two cannot disagree.
 *
 *   - A content-free prompt asks about nothing.
 *   - A prompt with no continuation clause (continuation.ts) asks about
 *     itself.
 *   - A continuation that stands only in LEADING quiet clauses — clauses
 *     that carry the session on or are content-free — hands the session back
 *     and then names a task, and THE REST is asked about: "next: add rate
 *     limiting to the upload endpoint" asks about "add rate limiting to the
 *     upload endpoint", "go ahead and then also add an audit log entry for
 *     role changes" about "also add an audit log entry for role changes".
 *     Round 5's rule silenced every such prompt: 25 of the 214 hold-out
 *     tasks.
 *   - SILENCE for a continuation that TRAILS a clause with content — "cool,
 *     cache fix is merged, next" reports and hands back; for one clause that
 *     carries the session on — "continue the orders partition migration" is
 *     the session's own work; for a rest that carries it on again; and for a
 *     rest that is only a STATUS REPORT — "continue: the refresh token fix is
 *     deployed".
 */
import { continuationClausesOf, isContinuationClause, signalWordsOf } from "./continuation.ts";
import type { PromptClause } from "./continuation.ts";
import { isContentFreePrompt, promptTerms } from "./prompt-terms.ts";
import type { PromptTerms } from "./prompt-terms.ts";
import { NEGATION_WORDS, STATUS_REPORT_PHRASES, STATUS_REPORT_WORDS } from "./prompt-vocabulary.ts";

export interface PromptTask {
  /** The text the hub is asked about: the whole prompt, or what follows its leading continuation. */
  readonly text: string;
  readonly terms: PromptTerms;
}

/** A clause that names no task: it carries the session on, or it is content-free. */
const isQuietClause = (clause: PromptClause): boolean => isContinuationClause(clause.text) || isContentFreePrompt(clause.text);

/**
 * What follows the LEADING QUIET CLAUSES, or null when every clause is quiet.
 * A continuation that does not lead is in what follows — and that rest
 * carries the session on, so it asks about nothing (`promptTaskOf`).
 */
const afterLeadingQuiet = (text: string): string | null => {
  const rest = continuationClausesOf(text).find((clause) => !isQuietClause(clause));
  return rest === undefined ? null : text.slice(rest.start).trim();
};

const STATUS_WORDS: ReadonlySet<string> = new Set(STATUS_REPORT_WORDS);
const NEGATIONS: ReadonlySet<string> = new Set(NEGATION_WORDS);

/** An English negation's contracted form: "doesn't", "isn't", "won’t". */
const CONTRACTED_NEGATION = /n['’]t$/u;

const hasStatusPhrase = (words: readonly string[]): boolean =>
  STATUS_REPORT_PHRASES.some((phrase) => words.some((_, index) => phrase.every((word, offset) => words[index + offset] === word)));

/** A clause that reports a state: a status word or phrase, and no negation that makes it a problem. */
const isStatusClause = (clause: string): boolean => {
  const words = signalWordsOf(clause);
  const reports = words.some((word) => STATUS_WORDS.has(word)) || hasStatusPhrase(words);
  return reports && !words.some((word) => NEGATIONS.has(word) || CONTRACTED_NEGATION.test(word));
};

/** Only a status report: every clause of it that says something reports a state. */
const isStatusReport = (text: string): boolean => {
  const saying = continuationClausesOf(text).filter((clause) => !isContentFreePrompt(clause.text));
  return saying.length > 0 && saying.every((clause) => isStatusClause(clause.text));
};

/** What this prompt asks the hub about, or null for nothing (see the header). Pass the terms when they are already read. */
export const promptTaskOf = (human: string, terms: PromptTerms = promptTerms(human)): PromptTask | null => {
  if (terms.isContentFree) {
    return null;
  }
  if (!terms.hasContinuation) {
    return { text: human, terms };
  }
  const rest = afterLeadingQuiet(human);
  if (rest === null || isStatusReport(rest)) {
    return null;
  }
  const restTerms = promptTerms(rest);
  return restTerms.isContentFree || restTerms.hasContinuation ? null : { text: rest, terms: restTerms };
};
