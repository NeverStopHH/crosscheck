/**
 * THE RELEVANCE HALF OF THE SUBSTANCE GATE, one predicate for the hub's
 * withholding and the connector's selector (hold-out review round 3, H3 +
 * M6). Its counts are TOPICAL words — closed-class words excluded from the
 * strong-match count — so "token" and "minute" beside "key" never make a
 * rate-limit decision a strong match for a JWT prompt.
 */
import { describe, expect, test } from "bun:test";

import { SUBSTANCE_MIN_MATCHED_TERMS, isStrongSubstanceMatch } from "../src/substance-trust.ts";

describe("a strong match for substance", () => {
  test.each([
    [{ claimTerms: 2, treeTerms: 0, isContentIdentity: false }, true, "the claim itself shares two topical words"],
    [{ claimTerms: 1, treeTerms: 2, isContentIdentity: false }, true, "the tree is about the prompt and the claim touches it"],
    [{ claimTerms: 0, treeTerms: 0, isContentIdentity: true }, true, "an error fingerprint is content identity"],
    [{ claimTerms: 1, treeTerms: 1, isContentIdentity: false }, false, "one word each is two weak statements"],
    [{ claimTerms: 0, treeTerms: 5, isContentIdentity: false }, false, "never the tree alone"],
  ] as const)("%o is %p — %s", (match, strong) => {
    expect(isStrongSubstanceMatch(match)).toBe(strong);
  });

  test("the threshold is two words, the content floor's own number", () => {
    expect(SUBSTANCE_MIN_MATCHED_TERMS).toBe(2);
  });
});
