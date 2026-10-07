/**
 * A PROMPT THAT CARRIES THE SESSION ON GETS NO HINT (hold-out review round 4,
 * C1). Status beside "continue" is not a new topic: "cool, cache fix is
 * merged, next", "die e2e tests laufen lokal, mach weiter", "yes the SSO login
 * works on staging now, carry on" all reached a teammate's tree on the words
 * of the report. Whatever else such a prompt says, it is not asked about.
 */
import { describe, expect, test } from "bun:test";

import { hasContinuationSignal } from "../src/continuation.ts";
import { promptTerms } from "../src/prompt-terms.ts";

describe("a continuation signal, anywhere in the prompt", () => {
  test.each([
    ["cool, cache fix is merged, next"],
    ["die e2e tests laufen lokal, mach weiter"],
    ["yes the SSO login works on staging now, carry on"],
    ["push notifications kommen jetzt einmal an, top, weiter"],
    ["ok search ranking passt erstmal, weiter mit dem was du vorhattest"],
    ["continue, but first fix the token refresh after key rotation"],
    ["go ahead with the migration"],
    ["proceed with the plan"],
    ["keep going until it is green"],
    ["na dann mal los"],
    ["passt so"],
    ["fahr fort"],
    ["Weiter."],
    ["go ahead."],
    ["leg los"],
    ["ok thanks, next: the usage dashboard monthly totals are wrong"],
    ["ok limit reset, pick up where you stopped"],
    ["continue where you left off"],
    ["Kontingent ist wieder frei, mach da weiter wo du aufgehört hast"],
    ["Ich weiß nicht mehr genau where we left off"],
    ["rate limited again lol, try again"],
    ["overloaded wieder, nochmal versuchen"],
  ])("%p carries the session on", (prompt) => {
    expect(hasContinuationSignal(prompt)).toBe(true);
  });

  test.each([
    ["wieter bitte", "a swapped pair"],
    ["contiune", "a swapped pair"],
    ["weiterr", "a doubled letter"],
    ["nxet", "a swapped pair in a four-letter word"],
  ])("%p is a slip of one — %s", (prompt) => {
    expect(hasContinuationSignal(prompt)).toBe(true);
  });

  test.each([
    ["next.js build fails on the edge runtime", "a name with a dot is not the word"],
    ["keep the previous signing key for 24 hours", "keep alone is no continuation"],
    ["mach bitte den token refresh fix für die key rotation", "mach alone is no continuation"],
    ["pass options toggle doesn't persist", "one key from passt is a word of its own"],
    ["the uploads keep failing at the gateway", "keep beside a verb other than going"],
    ["go to the settings page and fix the dark theme", "go alone is no continuation"],
    ["we went through the roadmap for next quarter", "next beside a word of the task"],
    ["die pdf rechnungen brauchen ewig wenn viel los ist", "los beside words of the task"],
    ["der support hatte am montag morgen die hölle los", "los beside words of the report"],
    ["arregla el bug del login en Safari, los usuarios pierden la sesión", "Spanish los is an article"],
    ["die Größe passt nicht", "passt beside a word of the task"],
    ["the pdf writer drops the footer", "one slip from weiter is a word of its own"],
    ["pick up the new signing key from the vault", "pick up beside no point the work stopped at"],
    ["the export left off the header row", "left off without where"],
    ["try the retry button with a slow network", "try beside no again"],
  ])("%p does not — %s", (prompt) => {
    expect(hasContinuationSignal(prompt)).toBe(false);
  });
});

describe("the prompt's terms carry the signal", () => {
  test("a task with a continuation is still a task, and still says so", () => {
    // Arrange
    const terms = promptTerms("continue, but first fix the token refresh after key rotation");

    // Assert — not content-free, and marked
    expect(terms.isContentFree).toBe(false);
    expect(terms.hasContinuation).toBe(true);
  });

  test("a plain task carries none", () => {
    expect(promptTerms("token refresh fails after key rotation").hasContinuation).toBe(false);
  });
});
