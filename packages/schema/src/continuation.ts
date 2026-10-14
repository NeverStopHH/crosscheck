/**
 * A PROMPT THAT CARRIES THE SESSION ON (DESIGN.md §4; hold-out review round
 * 4, C1; round 5, C1). Status beside "continue" is not a new topic: "cool,
 * cache fix is merged, next" and "die e2e tests laufen lokal, mach weiter"
 * report on work the session is doing and hand it back, and their report
 * words reached a teammate's tree.
 *
 * SCOPED TO ITS CLAUSE (round 5): a continuation used to silence the whole
 * prompt, whatever else it said, and the round-5 hold-out floored 25 of 214
 * tasks that way — "next: add rate limiting to the upload endpoint" among
 * them. A continuation is now a property of a CLAUSE — prose's own clauses,
 * and those a sequencing word opens ("and then", "then", "und dann",
 * "danach", "dann"); what a prompt with one asks the hub about is decided in
 * prompt-task.ts, by where its continuation clauses stand.
 *
 * A CLAUSE CARRIES THE SESSION ON when it holds a signal word or phrase
 * (prompt-vocabulary.ts) that names no thing — one not followed directly by a
 * word that says something: "continue the migration", "keep going until it
 * is green" and "mach weiter mit dem CSV-Export" do; "continue button in
 * checkout does nothing" names a button and does not. A clause word — "next",
 * "los", "passt" — signals only in a clause that says nothing else: every
 * other word of three letters or more in a closed class or a function word
 * (`isSilentWord`).
 *
 * Words are read with punctuation trimmed from their ends only, so
 * "next.js" is never "next", and folded like every class word.
 */
import {
  CONTINUATION_CLAUSE_WORDS,
  CONTINUATION_PHRASES,
  CONTINUATION_SIGNAL_WORDS,
  NEAR_MISS_WORDS,
} from "./prompt-vocabulary.ts";
import { foldWord, wordClassOf } from "./session-control.ts";
import { ENGLISH_FUNCTION_WORDS, FRENCH_FUNCTION_WORDS, GERMAN_FUNCTION_WORDS, SPANISH_FUNCTION_WORDS } from "./stop-words.ts";
import { isShortSwapSlipOf, isSwapSlipOf, isTypingSlipOf } from "./typing-slip.ts";

/**
 * Clause boundaries as prose writes them: punctuation before a space or the
 * end, a line break or a dash — never the dot inside "next.js".
 */
const CLAUSE_BOUNDARY = /[.!?;:,]+(?=\s|$)|[\n\r–—]+/u;

/**
 * THE WORDS THAT SEQUENCE A REQUEST open a clause of their own (round 5):
 * "go ahead and then also add an audit log entry", "keep going, and then the
 * HEIC thumbnails", "weiter so. Danach bitte die Websocket-Reconnects …".
 * Longer first, whole words only.
 */
const SEQUENCE_WORDS = "and then|und dann|then|danach|dann";

/** Where a continuation's clause ends: prose's boundary or a sequencing word, which the boundary consumes. */
const CONTINUATION_BOUNDARY = new RegExp(`${CLAUSE_BOUNDARY.source}|(?<![\\p{L}\\p{N}])(?:${SEQUENCE_WORDS})(?![\\p{L}\\p{N}])`, "iu");

/** Shorter words say nothing a clause could be about (prompt-terms.ts's floor). */
const MIN_SAYING_CHARS = 3;

const SIGNALS: ReadonlySet<string> = new Set(CONTINUATION_SIGNAL_WORDS);
const CLAUSE_SIGNALS: ReadonlySet<string> = new Set(CONTINUATION_CLAUSE_WORDS);
const NEAR_MISSES: ReadonlySet<string> = new Set(NEAR_MISS_WORDS);

/** A text's words, folded, punctuation trimmed from their ends only — exported for the status rule (prompt-task.ts). */
export const signalWordsOf = (text: string): readonly string[] =>
  text
    .split(/\s+/u)
    .map((word) => foldWord(word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")))
    .filter((word) => word.length > 0);

/**
 * A slip a hand makes of a signal word — before the near misses are set
 * aside. Exported for the near-miss list's own test: every entry there must
 * still be a slip of some class or signal word (session-control.test.ts).
 */
export const isSignalSlip = (word: string): boolean =>
  CONTINUATION_SIGNAL_WORDS.some((signal) => isTypingSlipOf(word, signal) || isShortSwapSlipOf(word, signal));

/** A word that signals, as written or as a slip a hand makes. */
const isSignalWord = (word: string): boolean => SIGNALS.has(word) || (!NEAR_MISSES.has(word) && isSignalSlip(word));

/** A clause word as written, or its swapped pair. */
const isClauseWord = (word: string): boolean =>
  CLAUSE_SIGNALS.has(word) ||
  (!NEAR_MISSES.has(word) && CONTINUATION_CLAUSE_WORDS.some((signal) => isSwapSlipOf(word, signal) || isShortSwapSlipOf(word, signal)));

/** A word that says nothing a clause could be about: short, a function word, or in a closed class. */
const isSilentWord = (word: string): boolean =>
  word.length < MIN_SAYING_CHARS || ENGLISH_FUNCTION_WORDS.has(word) || GERMAN_FUNCTION_WORDS.has(word) || wordClassOf(word) !== null;

/** The phrase that starts at this word, if one does: "carry on", "go ahead", "where you left off". */
const phraseAt = (words: readonly string[], index: number): readonly string[] | undefined =>
  CONTINUATION_PHRASES.find((phrase) => phrase.every((word, offset) => words[index + offset] === word));

/** How many words the signal at this word spans: its phrase's, one for a signal word, or none. */
const signalLengthAt = (words: readonly string[], index: number): number =>
  phraseAt(words, index)?.length ?? (isSignalWord(words[index] ?? "") ? 1 : 0);

/** An English verb's -ing form after a signal: the activity carried on — "continue debugging", "keep going investigating". */
const CARRIED_ACTIVITY = /\p{L}{2}ing$/u;

/**
 * A word after a signal that names no thing: a silent word, a function word
 * of the Spanish and French signal words' own languages — "sigue con lo
 * siguiente", "continuez avec la suite" — or the activity the session
 * carries on, "continue debugging".
 */
const isNamelessWord = (word: string): boolean =>
  isSilentWord(word) || SPANISH_FUNCTION_WORDS.has(word) || FRENCH_FUNCTION_WORDS.has(word) || CARRIED_ACTIVITY.test(word);

/**
 * A signal here that carries the session on (round 5): one the clause ends
 * on, or one followed by a word that says nothing of its own — "continue
 * the …", "keep going until …". A signal followed directly by a word that
 * says something names a thing: "continue button", "proceed button".
 */
const carriesOnAt = (words: readonly string[], index: number): boolean => {
  const length = signalLengthAt(words, index);
  const next = words[index + length];
  return length > 0 && (next === undefined || isNamelessWord(next));
};

/** A clause of nothing but a clause word and silent words: "…, next", "passt so". */
const isClauseSignal = (clause: readonly string[]): boolean =>
  clause.some(isClauseWord) && clause.every((word) => isClauseWord(word) || isSilentWord(word));

/** Does this clause carry the session on? */
export const isContinuationClause = (clause: string): boolean => {
  const words = signalWordsOf(clause);
  return isClauseSignal(words) || words.some((_, index) => carriesOnAt(words, index));
};

/** One clause of a prompt, and where in the text it starts. */
export interface PromptClause {
  readonly text: string;
  readonly start: number;
}

/** A text's clauses, in order, as a continuation is scoped by them — the blank ones left out. */
export const continuationClausesOf = (text: string): readonly PromptClause[] => {
  const boundary = new RegExp(CONTINUATION_BOUNDARY.source, "giu");
  const clauses: PromptClause[] = [];
  let start = 0;
  for (let match = boundary.exec(text); match !== null; match = boundary.exec(text)) {
    clauses.push({ text: text.slice(start, match.index), start });
    start = match.index + match[0].length;
    boundary.lastIndex = Math.max(boundary.lastIndex, match.index + 1);
  }
  clauses.push({ text: text.slice(start), start });
  return clauses.filter((clause) => clause.text.trim().length > 0);
};

/** Does any clause of this prompt carry the session on? */
export const hasContinuationSignal = (text: string): boolean =>
  continuationClausesOf(text).some((clause) => isContinuationClause(clause.text));
