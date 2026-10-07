/**
 * THE RELEVANCE HALF OF THE SUBSTANCE GATE, one predicate for the hub's
 * withholding and the connector's selector (hold-out review round 3, H3 +
 * M6). Its counts are TOPICAL words — closed-class words excluded from the
 * strong-match count — so "token" and "minute" beside "key" never make a
 * rate-limit decision a strong match for a JWT prompt.
 *
 * STRICT SINCE ROUND 4 (C2): the round-4 hold-out still showed 9 of 182 task
 * prompts a finding from another tree. A finding is shown only when its
 * claim shares two topical words, at least one of which no other candidate
 * tree says, and its tree's own statement shares one — or the match is
 * content identity. Whether its tree is the one strongest is the selector's
 * and the hub's to judge across candidates.
 */
import { describe, expect, test } from "bun:test";

import {
  SUBSTANCE_MIN_DISTINCT_TERMS,
  SUBSTANCE_MIN_MATCHED_TERMS,
  SUBSTANCE_MIN_TREE_TERMS,
  compareTreeStrength,
  isAtLeastAsStrongTree,
  isStrongSubstanceMatch,
  strongestTreeIndex,
} from "../src/substance-trust.ts";
import type { TreeStrength } from "../src/substance-trust.ts";

describe("a strong match for substance", () => {
  test.each([
    [{ claimTerms: 2, distinctTerms: 1, treeTerms: 1, isContentIdentity: false }, true, "two words, one no other tree says, in a tree about the prompt"],
    [{ claimTerms: 2, distinctTerms: 0, treeTerms: 3, isContentIdentity: false }, false, "every word it shares, another candidate tree says too"],
    [{ claimTerms: 3, distinctTerms: 3, treeTerms: 0, isContentIdentity: false }, false, "its tree's own statement says nothing of the prompt"],
    [{ claimTerms: 1, distinctTerms: 1, treeTerms: 2, isContentIdentity: false }, false, "one word is no finding about the prompt, however strong its tree"],
    [{ claimTerms: 0, distinctTerms: 0, treeTerms: 0, isContentIdentity: true }, true, "an error fingerprint is content identity"],
    [{ claimTerms: 0, distinctTerms: 0, treeTerms: 5, isContentIdentity: false }, false, "never the tree alone"],
  ] as const)("%o is %p — %s", (match, strong) => {
    expect(isStrongSubstanceMatch(match)).toBe(strong);
  });

  test("the thresholds: two words, one of them the claim's own, and one on the tree's statement", () => {
    expect(SUBSTANCE_MIN_MATCHED_TERMS).toBe(2);
    expect(SUBSTANCE_MIN_DISTINCT_TERMS).toBe(1);
    expect(SUBSTANCE_MIN_TREE_TERMS).toBe(1);
  });
});

describe("the one strongest tree (C2)", () => {
  const words = (topical: number, own = 0, shared = topical): TreeStrength => ({ isExact: false, topical, own, shared });
  const exact = (topical: number): TreeStrength => ({ isExact: true, topical, own: 0, shared: topical });

  test.each([
    [[words(2, 1), words(2, 2), words(2, 1)], 1, "on equal counts, the tree whose own statement shares more (M1)"],
    [[words(2, 2, 2), words(2, 2, 2)], null, "equal on every count: a tie"],
    [[words(3, 0), words(2, 2)], 0, "the count first, the own statement second"],
    [[words(2, 2, 2), words(2, 2, 3)], 1, "then the shared words a weak one among them (decision 3)"],
    [[words(2, 2, 2), words(2, 1, 4)], 1, "the shared words before the own statement (round 5, M2)"],
  ] as const)("%o: %p — %s", (strengths, index) => {
    expect(strongestTreeIndex(strengths)).toBe(index);
  });

  test("stronger first: the comparison sorts the bound's candidates (M1)", () => {
    const sorted = [words(1, 1), exact(0), words(3, 1), words(3, 2), words(3, 2, 4)].toSorted(compareTreeStrength);
    expect(sorted).toEqual([exact(0), words(3, 2, 4), words(3, 2), words(3, 1), words(1, 1)]);
  });

  test.each([
    [[words(2), words(4), words(3)], 1, "the most topical words, wherever the hub ranked it"],
    [[words(4)], 0, "a lone tree is the strongest"],
    [[words(5), exact(0)], 1, "an exact target before any count of words"],
    [[words(3), words(3)], null, "a tie at the top"],
    [[words(4), words(2), words(4)], null, "a tie at the top, apart in the hub's order"],
    [[exact(1), exact(1), words(9)], null, "two exact targets with the same words"],
    [[words(2), words(2), words(3)], 2, "a tie below the top is no tie"],
    [[], null, "no trees"],
  ] as const)("%o: %p — %s", (strengths, index) => {
    expect(strongestTreeIndex(strengths)).toBe(index);
  });

  test("at least as strong: exact first, then the count, an equal count both ways", () => {
    expect(isAtLeastAsStrongTree(exact(0), words(9))).toBe(true);
    expect(isAtLeastAsStrongTree(words(9), exact(0))).toBe(false);
    expect(isAtLeastAsStrongTree(words(3), words(3))).toBe(true);
    expect(isAtLeastAsStrongTree(words(2), words(3))).toBe(false);
  });
});
