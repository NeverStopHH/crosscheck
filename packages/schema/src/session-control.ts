/**
 * Which closed class a word is in (DESIGN.md §4, hold-out review H1). The
 * lists live in prompt-vocabulary.ts; this is how a word is looked up, and
 * prompt-terms.ts turns the classes into a verdict.
 *
 * AS WRITTEN FIRST, THEN A TYPING SLIP (typing-slip.ts), and a slip only of
 * the classes a prompt's typos fall on — continuation triggers, steering
 * words and meta words: "contnue", "mahce weiter bitet", "macxhe weiter,
 * limit ist zurukgsetz". Conversation and operation words match only as
 * written, since one key from "test" is "text" and one from "push" is
 * "posh". A word of its own one slip from a class word (NEAR_MISS_WORDS,
 * pinned against the system dictionary by session-control.test.ts) is never
 * read as that slip.
 *
 * A slip moves the VERDICT only: the terms the hub counts drop a steering
 * word as written, never a guess at one (prompt-terms.ts).
 */
import {
  AGENT_OPERATION,
  CONTINUATION_TRIGGERS,
  CONVERSATION_CONTROL,
  META_WORDS,
  NEAR_MISS_WORDS,
  OTHER_STEERING,
  RESTART_VERBS,
} from "./prompt-vocabulary.ts";
import { isSwapSlipOf, isTypingSlipOf } from "./typing-slip.ts";

export type WordClass = "trigger" | "steering" | "meta" | "conversation" | "operation";

/** Lower case, accents off, ß as ss: "Zurückgesetzt" is "zuruckgesetzt". */
export const foldWord = (word: string): string =>
  word.normalize("NFKD").replace(/\p{M}/gu, "").replace(/ß/g, "ss").toLowerCase();

const classed = (words: readonly string[], wordClass: WordClass): readonly (readonly [string, WordClass])[] =>
  words.map((word) => [word, wordClass] as const);

/**
 * A word two lists share takes the later class — a trigger is a trigger
 * before it steers — and a word that is in a class is never a slip of another.
 */
const EXACT_CLASSES: ReadonlyMap<string, WordClass> = new Map([
  ...classed(CONVERSATION_CONTROL, "conversation"),
  ...classed(AGENT_OPERATION, "operation"),
  ...classed(META_WORDS, "meta"),
  ...classed(OTHER_STEERING, "steering"),
  ...classed(CONTINUATION_TRIGGERS, "trigger"),
]);

interface SlipTarget {
  readonly word: string;
  readonly wordClass: WordClass;
  readonly isSlip: (typed: string, target: string) => boolean;
}

/**
 * The words a slip may reach, keyed by the first letter a slip never
 * touches; triggers first. Triggers and meta words take every slip a hand
 * makes (decision b). A steering word takes the swapped pair alone — "bitet",
 * "plaese" — since one key from "passt", "bitte" and "looks" are "pass",
 * "bite" and "look".
 */
const SLIP_TARGETS: ReadonlyMap<string, readonly SlipTarget[]> = [
  ...CONTINUATION_TRIGGERS.map((word): SlipTarget => ({ word, wordClass: "trigger", isSlip: isTypingSlipOf })),
  ...OTHER_STEERING.map((word): SlipTarget => ({ word, wordClass: "steering", isSlip: isSwapSlipOf })),
  ...META_WORDS.map((word): SlipTarget => ({ word, wordClass: "meta", isSlip: isTypingSlipOf })),
].reduce<ReadonlyMap<string, readonly SlipTarget[]>>(
  (byLetter, target) => new Map([...byLetter, [target.word[0] ?? "", [...(byLetter.get(target.word[0] ?? "") ?? []), target]]]),
  new Map(),
);

const NEAR_MISSES: ReadonlySet<string> = new Set(NEAR_MISS_WORDS);

/**
 * The class word a slip of `word` reaches, and its class, or null — before
 * NEAR_MISS_WORDS is consulted (the dictionary sweep reads this to find them).
 */
export const slipTargetOf = (word: string): { readonly word: string; readonly wordClass: WordClass } | null => {
  const folded = foldWord(word);
  const target = (SLIP_TARGETS.get(folded[0] ?? "") ?? []).find((candidate) => candidate.isSlip(folded, candidate.word));
  return target === undefined ? null : { word: target.word, wordClass: target.wordClass };
};

/** A word in a class as written, before any slip. */
export const exactClassOf = (word: string): WordClass | null => EXACT_CLASSES.get(foldWord(word)) ?? null;

/** The class a word is in — as written, or as a slip of a class word — or null. */
export const wordClassOf = (word: string): WordClass | null => {
  const folded = foldWord(word);
  const exact = EXACT_CLASSES.get(folded);
  if (exact !== undefined) {
    return exact;
  }
  return NEAR_MISSES.has(folded) ? null : (slipTargetOf(folded)?.wordClass ?? null);
};

/** A steering word or trigger AS WRITTEN: the words the hub never counts (review 1006b, H1). */
export const isSteeringWord = (word: string): boolean => {
  const wordClass = EXACT_CLASSES.get(foldWord(word));
  return wordClass === "trigger" || wordClass === "steering";
};

/** A verb or particle that carries the session's work on, a slip included. */
export const isContinuationTrigger = (word: string): boolean => wordClassOf(word) === "trigger";

const RESTARTS: ReadonlySet<string> = new Set(RESTART_VERBS);

/** A verb that sets the session's work going again (C1), a slip included. */
export const isRestartVerb = (word: string): boolean => {
  const folded = foldWord(word);
  return RESTARTS.has(folded) || (!NEAR_MISSES.has(folded) && RESTARTS.has(slipTargetOf(folded)?.word ?? ""));
};
