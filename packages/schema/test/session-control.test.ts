/**
 * Words that steer the SESSION rather than name a task (DESIGN.md §4,
 * review 1006b decision 2).
 *
 * STEERING WORDS — continue, weiter, mache, resume, please, bitte, next
 * step, nochmal … — are never a task word, anywhere: not in the verdict,
 * and not as a shared term beside a real one (H1). SESSION-META WORDS —
 * limit, reset, usage, retry, restart, session — are steering only when a
 * continuation verb AND a reset report stand beside them ("limit was
 * reset, continue"); in a task prompt they are the task (M3: "why does the
 * usage limit reset").
 *
 * TYPO TOLERANCE NEVER MAPS A REAL WORD: swapped neighbours only, two of
 * them in long words, and only in a continuation trigger — the one word
 * whose slip changes the verdict. A test runs the whole system dictionary
 * (when present) plus a German sample through the matcher, failing on any
 * word that maps to a steering word other than itself.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import {
  isContinuationTrigger,
  isResetReport,
  isSessionMetaWord,
  steeringWordOf,
} from "../src/session-control.ts";

const DICTIONARY = "/usr/share/dict/words";

/** German words near a steering word that are words of their own (synthetic sample). */
const GERMAN_NEAR_MISSES = [
  "bitter", "bitten", "bittet", "Fortsetzung", "Fortschritt", "fortan", "Resümee", "Matte", "Macher",
  "Mächte", "Wetter", "weitere", "weiteren", "weiterer", "Weiterbildung", "weitermacht", "Wiederaufnahme",
  "wiederaufgenommen", "einverstandene", "umgesetzt", "umsetzbar", "Versuchung", "versucht", "probiert",
  "Probe", "schrittweise", "Superlativ", "Perfektion", "passte", "Klarheit", "Danksagung",
  "erneuert", "Erneuerung", "nochmals", "einfache", "schonen", "Mahl", "Lose", "losen", "nächstens",
  "Zurückhaltung", "zurückgesetzte", "Limitierung", "Sitzungen", "Neustarts", "Nutzungen", "fortsetzt",
];

describe("steering words are recognised, folded and with a typist's swaps", () => {
  test.each([
    ["continue", "continue"],
    ["Weiter", "weiter"],
    ["mache", "mache"],
    ["BITTE", "bitte"],
    ["nächsten", "nachsten"],
    ["contineu", "continue"],
    ["wieter", "weiter"],
    ["wiederuafnhemen", "wiederaufnehmen"],
    ["fortstezen", "fortsetzen"],
  ])("%p is the steering word %p", (word, steering) => {
    expect(steeringWordOf(word)).toBe(steering);
  });

  test.each([["cache"], ["process"], ["result"], ["preset"], ["lease"], ["bitter"], ["continued"], ["Fortsetzung"], ["Resümee"], ["potion"], ["plaese"], ["weitermachn"]])(
    "%p is a word of its own",
    (word) => {
      expect(steeringWordOf(word)).toBeNull();
    },
  );

  test.each([
    ["ocntineu", "two swaps in an eight-letter trigger"],
    ["fhar", "one swap in a four-letter trigger"],
  ])("%p is not a typo of a trigger — %s is more than its length allows (review 1006b, M5)", (word) => {
    expect(steeringWordOf(word)).toBeNull();
  });
});

describe("session-meta words are steering only beside a continuation verb and a reset report", () => {
  test.each([["limit"], ["Limits"], ["usage"], ["retry"], ["restart"], ["session"], ["Sitzung"], ["zurücksetzen"]])(
    "%p is a session-meta word",
    (word) => {
      expect(isSessionMetaWord(word)).toBe(true);
    },
  );

  test.each([["reset"], ["zurückgesetzt"], ["zurueckgesetzt"], ["frei"], ["back"]])("%p reports a reset", (word) => {
    expect(isResetReport(word)).toBe(true);
    expect(isSessionMetaWord(word)).toBe(true);
  });

  test.each([["continue"], ["weiter"], ["resume"], ["weitermachen"], ["contineu"]])("%p continues", (word) => {
    expect(isContinuationTrigger(word)).toBe(true);
  });

  test.each([["please"], ["bitte"], ["proceed"], ["nochmal"], ["mache"]])("%p steers but does not continue", (word) => {
    expect(steeringWordOf(word)).not.toBeNull();
    expect(isContinuationTrigger(word)).toBe(false);
  });
});

describe("typo tolerance never maps a real word to a steering word", () => {
  test.skipIf(!existsSync(DICTIONARY))("the system dictionary, every word", () => {
    const words = readFileSync(DICTIONARY, "utf8").split("\n").filter((word) => word.length > 0);
    const collisions = words
      .map((word) => [word, steeringWordOf(word)] as const)
      .filter(([word, steering]) => steering !== null && steering !== word.toLowerCase());
    expect(collisions).toEqual([]);
  });

  test("a German sample of near misses", () => {
    expect(GERMAN_NEAR_MISSES.filter((word) => steeringWordOf(word) !== null)).toEqual([]);
  });
});
