/**
 * A prompt's CONTENT terms (DESIGN.md §4): the words left after
 * PostgreSQL's own stop lists (stop-words.ts), which the hub ranks its search
 * pool on and counts against every candidate — never the raw tokens, so a
 * German prompt's "das ist nicht die" cannot crowd the one tree it is about
 * out of the pool (review 1006b, M8) — and the VERDICT whether those words
 * name a task at all (hold-out review, H1).
 *
 * HERE, IN THE SHARED SCHEMA, so the connector and the hub reach the same
 * terms and the same verdict from the same text without asking the database.
 *
 * THE ENGLISH LIST ALWAYS APPLIES; THE GERMAN ONE ONLY TO A GERMAN PROMPT
 * (L1): "die", "will", "man" are German function words and English task
 * words, so "why does the worker die" keeps "die". The signal is the stop
 * words themselves: a prompt reads as German when it holds more words only
 * the German list knows than words only the English list knows.
 *
 * EVERY TOKEN IS JUDGED. The hub bounds what it sends to SQL; what a prompt
 * carries is decided on all of it, so a task word past the sixteenth token
 * still counts.
 */
import { isContinuationTrigger, isRestartVerb, isSteeringWord, wordClassOf } from "./session-control.ts";
import type { WordClass } from "./session-control.ts";
import { commandArguments } from "./slash-command.ts";
import { ENGLISH_FUNCTION_WORDS, ENGLISH_STOP_WORDS, GERMAN_FUNCTION_WORDS } from "./stop-words.ts";

/** Shorter tokens are not words to search on — the hub's and the connector's floor. */
export const PROMPT_MIN_TOKEN_CHARS = 3;

/**
 * Two capitals are a word however short (hold-out review, M6): "CI rot", "DB
 * down", "PR #74" name their topic in two letters, and the length floor read
 * them as nothing. Only in capitals as written — "ci" or "db" in running
 * lower-case text stays below the floor, where "an", "to" and "is" live.
 */
const isCapitalPair = (token: string): boolean => /^\p{Lu}{2}$/u.test(token);

/** Lower-cased letter/digit runs of at least PROMPT_MIN_TOKEN_CHARS, or two capitals, in order. */
export const promptTokens = (text: string): readonly string[] =>
  text
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= PROMPT_MIN_TOKEN_CHARS || isCapitalPair(token))
    .map((token) => token.toLowerCase());

const countWhere = (tokens: readonly string[], predicate: (token: string) => boolean): number =>
  tokens.filter(predicate).length;

/** More German-only stop words than English-only ones. */
export const isGermanPrompt = (tokens: readonly string[]): boolean =>
  countWhere(tokens, (token) => GERMAN_FUNCTION_WORDS.has(token) && !ENGLISH_STOP_WORDS.has(token)) >
  countWhere(tokens, (token) => ENGLISH_STOP_WORDS.has(token) && !GERMAN_FUNCTION_WORDS.has(token));

export interface PromptTerms {
  /** Distinct content words, in order of first appearance. */
  readonly content: readonly string[];
  /**
   * The content words of NO closed class (hold-out review round 3, C1): the
   * words that can name a topic. A candidate tree must share one of them on
   * the statement that clears the content floor — two meta words agreeing
   * ("session", "limit") are the session's machinery, never a topic.
   */
  readonly topical: readonly string[];
  /**
   * THE TERMS A SEARCH SPENDS ITS BOUND ON (hold-out review round 3, M7): the
   * content words of every CLAUSE that is not itself a command to the session
   * — "keep it short please", "carry on after that, thanks" lend nothing —
   * topical words first, the closed-class ones after, each in order of first
   * appearance. A long prompt's chatter used to fill the hub's sixteen terms
   * before the task in its third sentence was reached.
   */
  readonly ranked: readonly string[];
  readonly isGerman: boolean;
  /** No task: what is left is a command to the session (`isSessionCommand`). */
  readonly isContentFree: boolean;
}

/** Clause boundaries (M7): sentence ends, commas, semicolons, colons, dashes and line breaks. */
const CLAUSE_BOUNDARY = /[.!?;:,\n\r–—]+/u;

/** Words that never name a task: steering, triggers and filler (round 3, H1). */
const isSteeringClass = (wordClass: WordClass | null): boolean =>
  wordClass === "trigger" || wordClass === "steering" || wordClass === "filler";

const isCommandClass = (wordClass: WordClass | null): boolean =>
  wordClass === "conversation" || wordClass === "operation";

/**
 * THE VERDICT (hold-out review, H1): a prompt carries no task when every
 * word left in it belongs to a closed class (prompt-vocabulary.ts) and the
 * classes make a command to the session rather than a question about it —
 *   nothing but steering: "passt scho", "mach weiter bitet";
 *   a continuation trigger beside meta words only, whatever they report:
 *     "mach weiter, usage limit ist wieder da" (a);
 *   a conversation or operation word beside meta words only: "think again,
 *     shorter", "commit and push", "run the tests again" (c);
 *   one meta word and a steering word: "retry please";
 *   a RESTART VERB beside meta words only: "rate limit is gone, retry",
 *     "retry limit" (round 3, C1).
 * Meta words alone ask about the machinery — "why does the usage limit
 * reset", "session expires after 15 minutes" — and ONE word of no class
 * makes a task: "run the checkout e2e tests".
 */
const isSessionCommand = (
  tokens: readonly string[],
  content: readonly string[],
  classes: readonly (WordClass | null)[],
): boolean => {
  if (classes.includes(null)) {
    return false;
  }
  const topical = classes.filter((wordClass) => !isSteeringClass(wordClass));
  return (
    topical.length === 0 ||
    tokens.some(isContinuationTrigger) ||
    topical.some(isCommandClass) ||
    content.some(isRestartVerb) ||
    (topical.length === 1 && tokens.some((token) => isSteeringClass(wordClassOf(token))))
  );
};

export const promptTerms = (text: string): PromptTerms => {
  // A slash command's name is never a task word: only its arguments are
  // scored (slash-command.ts).
  const scored = commandArguments(text);
  const written = promptTokens(scored);
  const tokens = [...new Set(written)];
  const isGerman = isGermanPrompt(written);
  const isFunctionWord = (token: string): boolean =>
    ENGLISH_FUNCTION_WORDS.has(token) || (isGerman && GERMAN_FUNCTION_WORDS.has(token));
  // STEERING WORDS ARE NEVER TERMS (review 1006b, H1): not as a shared word
  // beside a real one. As written: a slip moves the verdict, never the terms.
  const termsOf = (words: readonly string[]): readonly string[] =>
    words.filter((token) => !isFunctionWord(token) && !isSteeringWord(token));
  const content = termsOf(tokens);
  // Every word looked up once: a clause's words are the prompt's words.
  const classByWord: ReadonlyMap<string, WordClass | null> = new Map(content.map((term) => [term, wordClassOf(term)]));
  const classOf = (term: string): WordClass | null => (classByWord.has(term) ? (classByWord.get(term) ?? null) : wordClassOf(term));
  const classes = content.map(classOf);
  const topical = content.filter((_, index) => classes[index] === null);
  return {
    content,
    topical,
    ranked: rankedTerms(scored, termsOf, classOf),
    isGerman,
    isContentFree: isSessionCommand(tokens, content, classes),
  };
};

/** The ranked terms (M7): those of every clause that is no command, topical first. */
const rankedTerms = (
  text: string,
  termsOf: (words: readonly string[]) => readonly string[],
  classOf: (term: string) => WordClass | null,
): readonly string[] => {
  const kept = [
    ...new Set(
      text.split(CLAUSE_BOUNDARY).flatMap((clause) => {
        const words = [...new Set(promptTokens(clause))];
        const terms = termsOf(words);
        return isSessionCommand(words, terms, terms.map(classOf)) ? [] : terms;
      }),
    ),
  ];
  return [...kept.filter((term) => classOf(term) === null), ...kept.filter((term) => classOf(term) !== null)];
};

/** Nothing task-bearing: what is left is a command to the session. */
export const isContentFreePrompt = (text: string): boolean => promptTerms(text).isContentFree;
