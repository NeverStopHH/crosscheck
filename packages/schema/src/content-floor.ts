/**
 * THE CONTENT FLOOR — ONE RULE, CALLED BY THE HUB AND BY THE CONNECTOR
 * (DESIGN.md §4; hold-out review round 3, follow-up). "Does this prompt clear
 * the floor against this text?" used to be answered twice: by the hub in SQL
 * on PostgreSQL's english lexemes, and by a connector recounting an old hub's
 * candidates as written. They drifted: against a 0.10.0 hub the recount knew
 * neither the long-prompt floor nor that "shows" is the conversation word
 * "show", and a 120-word status report was pointed at the usage dashboard on
 * "usage", "shows" and "wrong". Both sides now call these functions.
 *
 *   - WORDS MATCH ON THEIR ENGLISH LEXEMES (english-stem.ts, the database's
 *     own algorithm, pinned word for word against it): "timeouts" is
 *     "timeout", and English stop words say nothing, as in the database.
 *   - THE FLOOR TERMS of a prompt are its ranked terms that the team's text
 *     says at all (the KNOWN terms), the first HINT_MAX_COUNTED_TERMS of them
 *     counted; the TOPICAL ones are those of no closed class, less a closed
 *     word's inflection (L1); and a prompt of more than
 *     HINT_LONG_PROMPT_KNOWN_TERMS known words needs
 *     HINT_LONG_PROMPT_MIN_TOPICAL topical words on one statement (M7).
 *   - ONE STATEMENT clears the floor with HINT_MIN_SHARED_TERMS shared words
 *     when enough of them are topical (C1).
 *
 * Which statements and which known terms are the caller's: the hub reads its
 * database, a connector the candidates an old hub put on the wire.
 */
import { englishStem } from "./english-stem.ts";
import type { PromptTerms } from "./prompt-terms.ts";
import { CLOSED_CLASS_WORDS, exactClassOf, foldWord } from "./session-control.ts";
import { ENGLISH_STOP_WORDS } from "./stop-words.ts";

/** Shared words one statement needs: two agreeing on the same statement are a topic, one is a stray word. */
export const HINT_MIN_SHARED_TERMS = 2;

/** How many ranked terms are looked at for being known (M7): each costs the hub one indexed probe. */
export const HINT_MAX_EXAMINED_TERMS = 256;

/** How many known terms are counted (M7): twice the search's sixteen-token bound. */
export const HINT_MAX_COUNTED_TERMS = 32;

/** More known words than this make a long prompt (M7). */
export const HINT_LONG_PROMPT_KNOWN_TERMS = 16;

/** Topical words a long prompt's floor statement must share (M7); a short one needs one. */
export const HINT_LONG_PROMPT_MIN_TOPICAL = 3;

/** A word holding a digit: the database's simple dictionary keeps it as written. */
const HAS_DIGIT = /\p{N}/u;

/** A word's lexeme as the hub's database matches it. */
export const termLexeme = (word: string): string => {
  const lower = word.toLowerCase();
  return HAS_DIGIT.test(lower) ? lower : englishStem(lower);
};

/**
 * The lexemes of the closed-class words — those the database keeps: a closed
 * word that is an English stop word has none, so nothing is its inflection.
 */
const CLOSED_LEXEMES: ReadonlySet<string> = new Set(
  CLOSED_CLASS_WORDS.filter((word) => !ENGLISH_STOP_WORDS.has(word)).map(termLexeme),
);

/**
 * A CLOSED-CLASS WORD'S INFLECTION IS NO TOPIC (round 3, L1): the schema
 * classes a word as written, and the match is on lexemes, so "stopped" — no
 * class word as written — matched "stops" as the conversation word "stop".
 * Compared folded, the form the class words are kept in.
 *
 * ONLY AN INFLECTED PROMPT WORD (round 4, M1): one whose lexeme is not the
 * word itself, and that is no class word as written — those are topical in a
 * task now. "refresh" is its own lexeme, so it is a topic though the meta
 * word "refreshed" shares it; "shows", "stopped" and "deploys" stay none.
 */
export const isClosedInflection = (term: string): boolean => {
  const folded = foldWord(term);
  const lexeme = termLexeme(folded);
  return lexeme !== folded && exactClassOf(folded) === null && CLOSED_LEXEMES.has(lexeme);
};

/** The lexemes a text says: its words, lower-cased, less the database's English stop words. */
export const textLexemes = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 0 && !ENGLISH_STOP_WORDS.has(word))
      .map(termLexeme),
  );

/** Of the ranked terms, those some text says — in order, at most HINT_MAX_EXAMINED_TERMS of them looked at. */
export const knownTermsIn = (ranked: readonly string[], texts: readonly string[]): readonly string[] => {
  const said = new Set(texts.flatMap((text) => [...textLexemes(text)]));
  return ranked.slice(0, HINT_MAX_EXAMINED_TERMS).filter((term) => said.has(termLexeme(term)));
};

/** The words the floor is counted on. */
export interface FloorTerms {
  /** The known terms counted, in ranked order. */
  readonly all: readonly string[];
  /** Those of them of no closed class, a closed word's inflection excluded (C1, L1). */
  readonly topical: readonly string[];
  /** Topical words a floor statement must share: one, or more for a long prompt (M7). */
  readonly minTopical: number;
}

/**
 * A prompt's floor terms, given its KNOWN terms: the ranked ones some
 * statement of the team says. A caller that sees only part of the team's text
 * — a connector reading an old hub's wire — passes `knownCount`, how many
 * words MAY be known, so a prompt is never taken for short because its reader
 * saw little: the long test fails closed. The hub sees its whole repo and
 * passes nothing.
 */
export const floorTermsOf = (
  terms: Pick<PromptTerms, "topical">,
  known: readonly string[],
  knownCount: number = known.length,
): FloorTerms => {
  const all = known.slice(0, HINT_MAX_COUNTED_TERMS);
  const topicalWords = new Set(terms.topical);
  return {
    all,
    topical: all.filter((term) => topicalWords.has(term) && !isClosedInflection(term)),
    minTopical: knownCount > HINT_LONG_PROMPT_KNOWN_TERMS ? HINT_LONG_PROMPT_MIN_TOPICAL : 1,
  };
};

/** The distinct lexemes of the terms that are among those a text says. */
export const sharedLexemes = (terms: readonly string[], said: ReadonlySet<string>): ReadonlySet<string> =>
  new Set(terms.map(termLexeme).filter((lexeme) => said.has(lexeme)));

/** How many distinct lexemes of the terms are among those a text says. */
export const sharedTermCount = (terms: readonly string[], said: ReadonlySet<string>): number => sharedLexemes(terms, said).size;

/** What one statement shares with a prompt. */
export interface StatementMatch {
  /** Its shared words when enough of them are topical (C1, M7), and 0 otherwise. */
  readonly floor: number;
  /** Its shared topical words: the strength of the tree it belongs to (H3 + M6). */
  readonly topical: number;
}

/** THE FLOOR OF ONE STATEMENT, the one count the hub and the connector both make. */
export const statementMatch = (floor: FloorTerms, text: string): StatementMatch => {
  const said = textLexemes(text);
  const topical = sharedTermCount(floor.topical, said);
  return { floor: topical >= floor.minTopical ? sharedTermCount(floor.all, said) : 0, topical };
};

/** Does this prompt clear the content floor against this text? */
export const clearsFloorOn = (floor: FloorTerms, text: string): boolean =>
  statementMatch(floor, text).floor >= HINT_MIN_SHARED_TERMS;
