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
import { wholeFormsOf } from "./content-floor.ts";
import { hasContinuationSignal } from "./continuation.ts";
import { humanPromptText } from "./harness-turn.ts";
import { WEAK_WORDS } from "./prompt-vocabulary.ts";
import { foldWord, isContinuationTrigger, isRestartVerb, isSteeringWord, wordClassOf } from "./session-control.ts";
import type { WordClass } from "./session-control.ts";
import { isBareShellCommand } from "./shell-command.ts";
import { commandArguments } from "./slash-command.ts";
import {
  ENGLISH_FUNCTION_WORDS,
  ENGLISH_STOP_WORDS,
  FRENCH_FUNCTION_WORDS,
  GERMAN_FUNCTION_WORDS,
  SPANISH_FUNCTION_WORDS,
} from "./stop-words.ts";

/** Shorter tokens are not words to search on — the hub's and the connector's floor. */
export const PROMPT_MIN_TOKEN_CHARS = 3;

/**
 * Two capitals are a word however short (hold-out review, M6): "CI rot", "DB
 * down", "PR #74" name their topic in two letters, and the length floor read
 * them as nothing. Only in capitals as written — "ci" or "db" in running
 * lower-case text stays below the floor, where "an", "to" and "is" live.
 */
const isCapitalPair = (token: string): boolean => /^\p{Lu}{2}$/u.test(token);

/**
 * A letter and a digit are a word in two characters (round 4, L2): "s3",
 * "k8", "v2" name their topic, and the database keeps them whole. A
 * two-digit number stays below the floor — a date's or a count's part.
 */
const isLetterDigitPair = (token: string): boolean => /^(?:\p{L}\p{N}|\p{N}\p{L})$/u.test(token);

/** Lower-cased letter/digit runs of at least PROMPT_MIN_TOKEN_CHARS, two capitals or a letter and a digit, in order. */
const partsOf = (word: string): readonly string[] =>
  word
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= PROMPT_MIN_TOKEN_CHARS || isCapitalPair(token) || isLetterDigitPair(token))
    .map((token) => token.toLowerCase());

/** A whole form is a word when it holds PROMPT_MIN_TOKEN_CHARS letters or digits: "e.g" is none. */
const isLongEnoughForm = (form: string): boolean => (form.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= PROMPT_MIN_TOKEN_CHARS;

/** A token holding a separator: a word's whole form, never one of its parts (L1). */
const isWholeForm = (token: string): boolean => /[^\p{L}\p{N}]/u.test(token);

/**
 * A prompt's tokens, in order: each word's parts, and after them the word
 * WHOLE when it is a path, a host or a dotted name (round 4, L1) — as the
 * database's parser keeps it, through the one reading the text's side uses
 * (content-floor.ts wholeFormsOf). A statement's "/health" is the lexeme
 * "/health" to the hub, never "health"; a prompt that names it now says it.
 */
export const promptTokens = (text: string): readonly string[] =>
  text.split(/\s+/u).flatMap((word) => [...partsOf(word), ...wholeFormsOf(word).filter(isLongEnoughForm)]);

/**
 * THE PARTS DECIDE, A WHOLE FORM FOLLOWS (L1): the verdict, the language and
 * the classes are read on a word's parts, as before; its whole form joins
 * the terms when one of its parts is a term of no closed class — so
 * "commit/push" stays a command to the session, and "src/auth/refresh.ts" is
 * a topic whole and in parts.
 */
const wordsOf = (
  written: readonly string[],
  termsOf: (words: readonly string[]) => readonly string[],
  classOf: (term: string) => WordClass | null,
): { readonly tokens: readonly string[]; readonly content: readonly string[]; readonly terms: readonly string[] } => {
  const tokens = [...new Set(written.filter((token) => !isWholeForm(token)))];
  const content = termsOf(tokens);
  const unclassedParts = new Set(content.filter((term) => classOf(term) === null));
  const contentParts = new Set(content);
  const terms = [...new Set(written)].filter((token) =>
    isWholeForm(token) ? partsOf(token).some((part) => unclassedParts.has(part)) : contentParts.has(token),
  );
  return { tokens, content, terms };
};

const countWhere = (tokens: readonly string[], predicate: (token: string) => boolean): number =>
  tokens.filter(predicate).length;

/** More of a language's own function words than English-only stop words. */
const readsAs = (tokens: readonly string[], words: ReadonlySet<string>): boolean =>
  countWhere(tokens, (token) => words.has(token) && !ENGLISH_STOP_WORDS.has(token)) >
  countWhere(tokens, (token) => ENGLISH_STOP_WORDS.has(token) && !words.has(token));

/** More German-only stop words than English-only ones. */
export const isGermanPrompt = (tokens: readonly string[]): boolean => readsAs(tokens, GERMAN_FUNCTION_WORDS);

/**
 * THE FUNCTION WORDS A PROMPT DROPS: English's always, and German's,
 * Spanish's and French's when it reads as that language (round 4, M4).
 */
const functionWordsOf = (written: readonly string[]): ((token: string) => boolean) => {
  const lists = [
    ENGLISH_FUNCTION_WORDS,
    ...[GERMAN_FUNCTION_WORDS, SPANISH_FUNCTION_WORDS, FRENCH_FUNCTION_WORDS].filter((words) => readsAs(written, words)),
  ];
  return (token: string): boolean => lists.some((words) => words.has(token));
};

export interface PromptTerms {
  /** Distinct content words, in order of first appearance. */
  readonly content: readonly string[];
  /**
   * The content words of NO closed class (hold-out review round 3, C1): what
   * the session's intent fire needs before it spends itself — a turn made of
   * the session's machinery parks no intent (connector derive/intent/gate.ts).
   */
  readonly unclassed: readonly string[];
  /**
   * The words that can name a topic: the content words of every class but
   * the steering ones — triggers, steering and filler, also as slips — since
   * the CLOSED CLASSES DECIDE CONTENT-FREENESS ONLY (round 4, M1). In a
   * prompt that is a task, "token refresh broken" and "rate limit not
   * enforced" are about tokens and rate limits; round 3 made a meta word no
   * topic anywhere, and those prompts could reach no tree. A candidate tree
   * must share one of them on the statement that clears the content floor.
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
  /**
   * The prompt carries the session on — "next", "mach weiter", "carry on" —
   * and gets no hint, whatever else it says (round 4, C1; continuation.ts).
   */
  readonly hasContinuation: boolean;
}

/**
 * Clause boundaries (M7): sentence ends, commas, semicolons and colons before
 * a space or the end, dashes and line breaks. A mark INSIDE a word is no
 * boundary (round 4, L1): "src/auth/refresh.ts" and "node.js" stay whole.
 */
const CLAUSE_BOUNDARY = /[.!?;:,]+(?=\s|$)|[\n\r–—]+/u;

/**
 * HOW MUCH OF A PROMPT IS CLASSIFIED (hold-out review round 3, L4): its head
 * and its tail, cut between words. Every word costs a class lookup, and a
 * word near a class word a typing-slip check; a hundred kilobytes of
 * distinct near-words took 390 ms to classify, several times per hook,
 * against an 800 ms budget. The hub only ever sees a 2000-character window
 * of a prompt; a verdict read on the first 8000 characters and the last
 * 1000 decides every prompt a person types, and a task written last still
 * counts.
 */
export const PROMPT_CLASSIFY_HEAD_CHARS = 8_000;
export const PROMPT_CLASSIFY_TAIL_CHARS = 1_000;

/** The head and the tail a classifier reads, each cut between words. */
const classifiedWindow = (text: string): string => {
  if (text.length <= PROMPT_CLASSIFY_HEAD_CHARS + PROMPT_CLASSIFY_TAIL_CHARS) {
    return text;
  }
  const head = text.slice(0, PROMPT_CLASSIFY_HEAD_CHARS).replace(/\S*$/u, "");
  const tail = text.slice(text.length - PROMPT_CLASSIFY_TAIL_CHARS).replace(/^\S*/u, "");
  return `${head}\n${tail}`;
};

const WEAK: ReadonlySet<string> = new Set(WEAK_WORDS);
/** A year of the last century or this one: a date's part, never a topic ("3000" is a port, "429" a status). */
const YEAR = /^(?:19|20)\d\d$/u;

/** A generic development word or a year: a term, never a TOPICAL one (round 4, decision 3). */
export const isWeakWord = (term: string): boolean => WEAK.has(foldWord(term)) || YEAR.test(term);

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
  // scored (slash-command.ts) — and of a long prompt, its head and its tail (L4).
  const scored = classifiedWindow(commandArguments(text));
  const written = promptTokens(scored);
  const parts = written.filter((token) => !isWholeForm(token));
  const isGerman = isGermanPrompt(parts);
  const isFunctionWord = functionWordsOf(parts);
  // STEERING WORDS ARE NEVER TERMS (review 1006b, H1): not as a shared word
  // beside a real one. As written: a slip moves the verdict, never the terms.
  const termsOf = (words: readonly string[]): readonly string[] =>
    words.filter((token) => !isFunctionWord(token) && !isSteeringWord(token));
  // Every word looked up once: a clause's words are the prompt's words.
  const classByWord: ReadonlyMap<string, WordClass | null> = new Map(
    termsOf([...new Set(parts)]).map((term) => [term, wordClassOf(term)]),
  );
  // A whole form is a term only beside a part of no class (wordsOf): it has none.
  const classOf = (term: string): WordClass | null =>
    isWholeForm(term) ? null : classByWord.has(term) ? (classByWord.get(term) ?? null) : wordClassOf(term);
  const words = wordsOf(written, termsOf, classOf);
  const classes = words.terms.map(classOf);
  return {
    content: words.terms,
    unclassed: words.terms.filter((_, index) => classes[index] === null),
    topical: words.terms.filter((term, index) => !isSteeringClass(classes[index] ?? null) && !isWeakWord(term)),
    ranked: rankedTerms(scored, termsOf, classOf),
    isGerman,
    // A bare shell command is the session's tool too (round 5, M3; shell-command.ts).
    isContentFree: isBareShellCommand(scored) || isSessionCommand(words.tokens, words.content, words.content.map(classOf)),
    hasContinuation: hasContinuationSignal(scored),
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
        const words = wordsOf(promptTokens(clause), termsOf, classOf);
        return isSessionCommand(words.tokens, words.content, words.content.map(classOf)) ? [] : words.terms;
      }),
    ),
  ];
  // Unclassed words first, then class and WEAK words (round 4, decision 3).
  const isFirst = (term: string): boolean => classOf(term) === null && !isWeakWord(term);
  return [...kept.filter(isFirst), ...kept.filter((term) => !isFirst(term))];
};

/**
 * Nothing task-bearing: what is left is a command to the session.
 *
 * THE VERDICT ALONE SHORT-CIRCUITS (round 3, L4): the first word of no class
 * makes a task, so the classes of the words after it are never looked up —
 * `promptTerms` needs every class for its topical and ranked terms, a caller
 * asking only this question does not.
 */
export const isContentFreePrompt = (text: string): boolean => {
  const windowed = classifiedWindow(commandArguments(text));
  if (isBareShellCommand(windowed)) {
    return true;
  }
  // The parts decide (L1): a word's whole form adds no verdict.
  const written = promptTokens(windowed).filter((token) => !isWholeForm(token));
  const isFunctionWord = functionWordsOf(written);
  const tokens = [...new Set(written)];
  const content = tokens.filter((token) => !isFunctionWord(token) && !isSteeringWord(token));
  return !content.some((term) => wordClassOf(term) === null) && isSessionCommand(tokens, content, content.map(wordClassOf));
};

/** A prompt as the hooks read it: the human text, classified ONCE per hook (round 3, L4). */
export interface ClassifiedPrompt {
  /** The text outside the harness's wrappers (harness-turn.ts). */
  readonly human: string;
  readonly terms: PromptTerms;
}

export const classifyPrompt = (prompt: string): ClassifiedPrompt => {
  const human = humanPromptText(prompt);
  return { human, terms: promptTerms(human) };
};
