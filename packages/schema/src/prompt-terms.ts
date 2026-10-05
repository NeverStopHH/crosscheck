/**
 * A prompt's CONTENT terms (DESIGN.md §4): the words left after
 * PostgreSQL's own stop lists (stop-words.ts), which the hub ranks its search
 * pool on and counts against every candidate — never the raw tokens, so a
 * German prompt's "das ist nicht die" cannot crowd the one tree it is about
 * out of the pool (review 1006b, M8).
 *
 * HERE, IN THE SHARED SCHEMA, so the connector and the hub reach the same
 * terms from the same text without asking the database.
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
import { ENGLISH_STOP_WORDS, GERMAN_STOP_WORDS } from "./stop-words.ts";

/** Shorter tokens are not words to search on — the hub's and the connector's floor. */
export const PROMPT_MIN_TOKEN_CHARS = 3;

/** Lower-cased letter/digit runs of at least PROMPT_MIN_TOKEN_CHARS, in order. */
export const promptTokens = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= PROMPT_MIN_TOKEN_CHARS);

const countWhere = (tokens: readonly string[], predicate: (token: string) => boolean): number =>
  tokens.filter(predicate).length;

/** More German-only stop words than English-only ones. */
export const isGermanPrompt = (tokens: readonly string[]): boolean =>
  countWhere(tokens, (token) => GERMAN_STOP_WORDS.has(token) && !ENGLISH_STOP_WORDS.has(token)) >
  countWhere(tokens, (token) => ENGLISH_STOP_WORDS.has(token) && !GERMAN_STOP_WORDS.has(token));

export interface PromptTerms {
  /** Distinct content words, in order of first appearance. */
  readonly content: readonly string[];
  readonly isGerman: boolean;
}

export const promptTerms = (text: string): PromptTerms => {
  const tokens = promptTokens(text);
  const isGerman = isGermanPrompt(tokens);
  const isFunctionWord = (token: string): boolean =>
    ENGLISH_STOP_WORDS.has(token) || (isGerman && GERMAN_STOP_WORDS.has(token));
  return {
    content: [...new Set(tokens.filter((token) => !isFunctionWord(token)))],
    isGerman,
  };
};
