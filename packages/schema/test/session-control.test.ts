/**
 * Which closed class a word is in (DESIGN.md §4, hold-out review H1): as
 * written, folded, or as a typing slip — every slip a hand makes for a
 * continuation trigger or a meta word, the swapped pair alone for a steering
 * word, and none for a conversation or operation word.
 *
 * A SLIP NEVER MAPS A REAL WORD: the whole system dictionary (when present)
 * and a German sample run through the lookup, and a word that is no class
 * word as written but reads as a slip of one fails the suite — unless
 * NEAR_MISS_WORDS names it, and an entry there that no longer reads as a
 * slip fails it too, so the list stays exactly what the rule needs.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { NEAR_MISS_WORDS } from "../src/prompt-vocabulary.ts";
import {
  exactClassOf,
  foldWord,
  isContinuationTrigger,
  isSteeringWord,
  slipTargetOf,
  wordClassOf,
} from "../src/session-control.ts";

const DICTIONARY = "/usr/share/dict/words";

/** German words near a class word that are words of their own (synthetic sample). */
const GERMAN_SAMPLE = [
  "bitter", "bitten", "bittet", "Fortsetzung", "Fortschritt", "fortan", "Resümee", "Matte", "Macher",
  "Mächte", "Wetter", "weitere", "weiteren", "weiterer", "weitet", "Weiterbildung", "weitermacht",
  "Wiederaufnahme", "wiederaufgenommen", "einverstandene", "umgesetzt", "umsetzbar", "Versuchung",
  "versucht", "probiert", "probierte", "Probe", "Proben", "Schrift", "Schnitt", "Masche", "machbar",
  "Leiter", "Superlativ", "Perfektion", "passte", "Klarheit", "Danksagung", "Erneuerung",
  "nochmals", "einfache", "schonen", "Mahl", "Lose", "losen", "nächstens", "Zurückhaltung",
  "zurückgesetzte", "Limitierung", "Sitzungen", "Neustarts", "Nutzungen", "fortsetzt", "Fahrer",
  "fahren", "gerader", "Kontinent", "Kontingenz", "Kontakt", "verfügbare", "abgelaufene", "heutige",
  "Fenster", "Ratte", "Rasse", "Weide", "Schrott", "schrittweise", "genug", "Klang",
];

describe("as written, folded", () => {
  test.each([
    ["continue", "trigger"],
    ["Weiter", "trigger"],
    ["mache", "trigger"],
    ["BITTE", "steering"],
    ["nächsten", "steering"],
    ["paßt", "steering"],
    ["limit", "meta"],
    ["Zurückgesetzt", "meta"],
    ["Kontingent", "meta"],
    ["shorter", "conversation"],
    ["Option", "conversation"],
    ["commit", "operation"],
    ["tests", "operation"],
    ["ähm", "filler"],
    ["Komma", "filler"],
    ["Fragezeichen", "filler"],
    ["sorry", "filler"],
    ["jaja", "filler"],
    ["thing", "filler"],
    ["keeps", "trigger"],
    ["continued", "trigger"],
    ["tried", "trigger"],
    ["retrying", "trigger"],
  ] as const)("%p is a %p word", (word, wordClass) => {
    expect(wordClassOf(word)).toBe(wordClass);
  });

  test.each([["checkout"], ["cache"], ["worker"], ["upload"], ["CI"]])("%p is in no class", (word) => {
    expect(wordClassOf(word)).toBeNull();
  });
});

describe("a slip of a trigger or a meta word is that word", () => {
  test.each([
    ["contiune", "trigger"],
    ["contnue", "trigger"],
    ["wieter", "trigger"],
    ["weiterr", "trigger"],
    ["wiederuafnhemen", "trigger"],
    ["fortstezen", "trigger"],
    ["mahce", "trigger"],
    ["macxhe", "trigger"],
    ["weitermachn", "trigger"],
    ["zurukgsetz", "meta"],
    ["kontingnet", "meta"],
    ["usgae", "meta"],
    ["mahc", "trigger"],
    ["mcah", "trigger"],
    ["kepe", "trigger"],
    ["fhar", "trigger"],
  ] as const)("%p reads as a %p word", (word, wordClass) => {
    expect(wordClassOf(word)).toBe(wordClass);
  });
});

describe("a steering word takes the swapped pair alone", () => {
  test.each([["bitet"], ["plaese"], ["thnaks"]])("%p, a swap, steers", (word) => {
    expect(wordClassOf(word)).toBe("steering");
  });

  test.each([["bitre"], ["danje"], ["pleese"]])("%p, a neighbouring key, is a word of its own", (word) => {
    expect(wordClassOf(word)).toBeNull();
  });
});

describe("a conversation or operation word matches only as written", () => {
  test.each([["tesr"], ["tesst"], ["posh"], ["comit"], ["shortr"]])("%p is no class word", (word) => {
    expect(wordClassOf(word)).toBeNull();
  });
});

describe("what a hand does not do is never a slip", () => {
  test.each([
    ["ocntineu", "the first letter moved"],
    ["mavh", "a four-letter trigger takes the swapped pair alone"],
    ["bakc", "a four-letter meta word takes no slip"],
    ["cache", "a word of its own"],
    ["process", "two slips from a seven-letter word"],
    ["preset", "another first letter"],
    ["lease", "another first letter"],
    ["potion", "a conversation word takes no slip"],
  ])("%p — %s", (word) => {
    expect(wordClassOf(word)).toBeNull();
  });
});

describe("only triggers and steering words are never terms", () => {
  test.each([["continue"], ["weiter"], ["bitte"], ["please"], ["Komma"], ["ähm"], ["text"]])("%p is steering or filler as written", (word) => {
    expect(isSteeringWord(word)).toBe(true);
  });

  test.each([["contiune"], ["limit"], ["commit"], ["shorter"]])("%p is not — a slip or another class", (word) => {
    expect(isSteeringWord(word)).toBe(false);
  });

  test("a trigger is a trigger, slips included", () => {
    expect(isContinuationTrigger("contnue")).toBe(true);
    expect(isContinuationTrigger("please")).toBe(false);
  });
});

/** A word in no class as written that still reads as a slip of one. */
const isCollision = (word: string): boolean => exactClassOf(word) === null && wordClassOf(word) !== null;

describe("a slip never maps a real word", () => {
  test.skipIf(!existsSync(DICTIONARY))("the system dictionary, every word", () => {
    const words = readFileSync(DICTIONARY, "utf8").split("\n").filter((word) => word.length > 0);
    expect(words.filter(isCollision)).toEqual([]);
  });

  test("the German sample", () => {
    expect(GERMAN_SAMPLE.filter(isCollision)).toEqual([]);
  });

  test("every near-miss entry is still a slip the rule would make, and no class word", () => {
    const dead = NEAR_MISS_WORDS.filter((word) => exactClassOf(word) !== null || slipTargetOf(word) === null);
    expect(dead).toEqual([]);
    expect(NEAR_MISS_WORDS.every((word) => word === foldWord(word))).toBe(true);
  });
});
