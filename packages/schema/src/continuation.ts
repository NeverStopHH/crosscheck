/**
 * A PROMPT THAT CARRIES THE SESSION ON (DESIGN.md §4; hold-out review round
 * 4, C1). Status beside "continue" is not a new topic: "cool, cache fix is
 * merged, next" and "die e2e tests laufen lokal, mach weiter" report on work
 * the session is doing and hand it back, and their report words reached a
 * teammate's tree. A prompt that says a continuation signal
 * (prompt-vocabulary.ts) gets no hint at all — no pointer, no substance —
 * whatever else it says. The cost is a task written in the same breath as
 * "carry on"; the gates name every such row.
 *
 * Words are read with punctuation trimmed from their ends only, so
 * "next.js" is never "next", and folded like every class word. A clause word
 * — "next", "los", "passt" — signals only in a clause that says nothing else:
 * every other word of three letters or more in a closed class or a function
 * word (`isSilentWord`).
 */
import {
  CONTINUATION_CLAUSE_WORDS,
  CONTINUATION_PHRASES,
  CONTINUATION_SIGNAL_WORDS,
  NEAR_MISS_WORDS,
} from "./prompt-vocabulary.ts";
import { foldWord, wordClassOf } from "./session-control.ts";
import { ENGLISH_FUNCTION_WORDS, GERMAN_FUNCTION_WORDS } from "./stop-words.ts";
import { isShortSwapSlipOf, isSwapSlipOf, isTypingSlipOf } from "./typing-slip.ts";

/**
 * Clause boundaries as prose writes them: punctuation before a space or the
 * end, a line break or a dash — never the dot inside "next.js".
 */
const CLAUSE_BOUNDARY = /[.!?;:,]+(?=\s|$)|[\n\r–—]+/u;
/** Shorter words say nothing a clause could be about (prompt-terms.ts's floor). */
const MIN_SAYING_CHARS = 3;

const SIGNALS: ReadonlySet<string> = new Set(CONTINUATION_SIGNAL_WORDS);
const CLAUSE_SIGNALS: ReadonlySet<string> = new Set(CONTINUATION_CLAUSE_WORDS);
const NEAR_MISSES: ReadonlySet<string> = new Set(NEAR_MISS_WORDS);

/** A text's words, folded, punctuation trimmed from their ends only. */
const signalWordsOf = (text: string): readonly string[] =>
  text
    .split(/\s+/u)
    .map((word) => foldWord(word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")))
    .filter((word) => word.length > 0);

/** A word that signals anywhere, as written or as a slip a hand makes. */
const isSignalWord = (word: string): boolean =>
  SIGNALS.has(word) ||
  (!NEAR_MISSES.has(word) && CONTINUATION_SIGNAL_WORDS.some((signal) => isTypingSlipOf(word, signal) || isShortSwapSlipOf(word, signal)));

/** A clause word as written, or its swapped pair. */
const isClauseWord = (word: string): boolean =>
  CLAUSE_SIGNALS.has(word) ||
  (!NEAR_MISSES.has(word) && CONTINUATION_CLAUSE_WORDS.some((signal) => isSwapSlipOf(word, signal) || isShortSwapSlipOf(word, signal)));

/** A word that says nothing a clause could be about: short, a function word, or in a closed class. */
const isSilentWord = (word: string): boolean =>
  word.length < MIN_SAYING_CHARS || ENGLISH_FUNCTION_WORDS.has(word) || GERMAN_FUNCTION_WORDS.has(word) || wordClassOf(word) !== null;

/** Words in a row that carry the session on: "carry on", "go ahead", "where you left off". */
const isSignalPhrase = (words: readonly string[], index: number): boolean =>
  CONTINUATION_PHRASES.some((phrase) => phrase.every((word, offset) => words[index + offset] === word));

/** A clause of nothing but a clause word and silent words: "…, next", "passt so". */
const isClauseSignal = (clause: readonly string[]): boolean =>
  clause.some(isClauseWord) && clause.every((word) => isClauseWord(word) || isSilentWord(word));

/** Does this prompt carry the session on? */
export const hasContinuationSignal = (text: string): boolean => {
  const words = signalWordsOf(text);
  return (
    words.some((word, index) => isSignalWord(word) || isSignalPhrase(words, index)) ||
    text.split(CLAUSE_BOUNDARY).some((clause) => isClauseSignal(signalWordsOf(clause)))
  );
};
