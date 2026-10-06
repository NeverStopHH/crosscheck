/**
 * A typing slip is what a typist's hand does to a word (hold-out review,
 * H1 b): a swapped pair of neighbours, a neighbouring key, a letter left
 * out, a letter doubled or a neighbour's key hit beside it — never the first
 * letter, and within a budget that grows with the word.
 */
import { describe, expect, test } from "bun:test";

import { isShortSwapSlipOf, isTypingSlipOf, slipBudget } from "../src/typing-slip.ts";

describe("the slips a hand makes are recognised", () => {
  test.each([
    ["contiune", "continue", "a swapped pair"],
    ["contnue", "continue", "a letter left out"],
    ["conitnue", "continue", "a swapped pair, earlier"],
    ["weiterr", "weiter", "a letter doubled"],
    ["wieter", "weiter", "a swapped pair at the second letter"],
    ["goin", "going", "the last letter left out"],
    ["mahce", "mache", "a swapped pair"],
    ["macxhe", "mache", "a neighbouring key hit beside the right one"],
    ["bitet", "bitte", "a swapped pair"],
    ["scho", "schon", "the last letter left out"],
    ["contimue", "continue", "a neighbouring key instead of the right one"],
    ["wiederuafnhemen", "wiederaufnehmen", "two swapped pairs in a long word"],
    ["zurukgsetz", "zuruckgesetzt", "three letters left out of a thirteen-letter word"],
    ["kontingnet", "kontingent", "a swapped pair"],
  ])("%p is a slip of %p — %s", (typed, target) => {
    expect(isTypingSlipOf(typed, target)).toBe(true);
  });
});

describe("what a hand does not do is never a slip", () => {
  test.each([
    ["ocntinue", "continue", "the first letter moved"],
    ["dontinue", "continue", "the first letter replaced"],
    ["contixue", "continue", "a key nowhere near the right one"],
    ["bttie", "bitte", "two slips in a five-letter word"],
    ["cntnu", "continue", "three slips in an eight-letter word"],
    ["kepe", "keep", "a four-letter word takes no slip"],
    ["lim", "limit", "a typed word under four letters"],
    ["continue", "continue", "the word itself"],
  ])("%p is not a slip of %p — %s", (typed, target) => {
    expect(isTypingSlipOf(typed, target)).toBe(false);
  });
});

describe("a four-letter trigger takes the swapped pair alone (round 3, H1)", () => {
  test.each([
    ["kepe", "keep"],
    ["mahc", "mach"],
    ["mcah", "mach"],
    ["fhar", "fahr"],
    ["frot", "fort"],
  ])("%p is a swapped %p", (typed, target) => {
    expect(isShortSwapSlipOf(typed, target)).toBe(true);
  });

  test.each([
    ["mavh", "mach", "a neighbouring key"],
    ["mac", "mach", "a letter left out"],
    ["amch", "mach", "the first letter moved"],
    ["mach", "mach", "the word itself"],
    ["contiune", "continue", "a longer word keeps its own budget"],
  ])("%p is not one of %p — %s", (typed, target) => {
    expect(isShortSwapSlipOf(typed, target)).toBe(false);
  });
});

describe("the budget grows with the word", () => {
  test.each([
    ["keep", 0],
    ["mache", 1],
    ["weiter", 1],
    ["continue", 2],
    ["kontingent", 2],
    ["zuruckgesetzt", 3],
  ])("%p may carry %p slips", (word, budget) => {
    expect(slipBudget(word)).toBe(budget);
  });
});

describe("it stays fast on hostile input", () => {
  test("a thousand distinct long near-words against a long target, inside the budget", () => {
    // Arrange — every word starts like the target and differs late, the costliest shape
    const words = Array.from({ length: 1000 }, (_, index) => `wiederaufneh${String(index).padStart(4, "x")}`);
    const SLIP_BUDGET_MS = 250;

    // Act
    const started = performance.now();
    const hits = words.filter((word) => isTypingSlipOf(word, "wiederaufnehmen"));
    const elapsed = performance.now() - started;

    // Assert
    expect(hits).toEqual([]);
    expect(elapsed).toBeLessThan(SLIP_BUDGET_MS);
  });
});
