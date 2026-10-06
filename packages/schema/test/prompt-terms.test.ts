/**
 * A prompt's CONTENT terms (DESIGN.md §4): its words after PostgreSQL's own
 * stop lists (mirrored in stop-words.ts, pinned against the database in
 * server/test/hint-content-terms.test.ts). The English list always applies;
 * the German one only to a prompt that reads as German, so "why does the
 * worker die" keeps "die" (review 1006b, L1). Every token is judged, not the
 * first sixteen.
 */
import { describe, expect, test } from "bun:test";

import { isContentFreePrompt, isGermanPrompt, promptTerms, promptTokens } from "../src/prompt-terms.ts";

describe("the language signal: more German-only stop words than English-only ones", () => {
  test.each([
    ["warum wird das Upload-Limit nicht erhöht", true],
    ["mache weiter, limit zurückgesetzt", true],
    ["das ist nicht die Lösung", true],
    ["why does the worker die", false],
    ["fix the OAuth refresh race", false],
    ["Limit zurücksetzen", false],
    ["", false],
  ])("%p reads as German: %p", (prompt, german) => {
    expect(isGermanPrompt(promptTokens(prompt))).toBe(german);
  });
});

describe("content terms are the words left after the stop lists", () => {
  test("an English prompt keeps a word only the German list holds", () => {
    expect(promptTerms("why does the worker die").content).toEqual(["worker", "die"]);
  });

  test("a German prompt loses its German function words", () => {
    expect(promptTerms("warum wird das Upload-Limit nicht erhöht").content).toEqual(["upload", "limit", "erhöht"]);
  });

  test.each([
    ["ok, ich glaube dass es passt, weiter", []],
    ["ja, das wurde so gemacht, passt", []],
    ["hast du das gesehen?", []],
    ["wieso geht der Upload nicht", ["upload"]],
  ])("German function words german.stop lacks are function words too: %p (hold-out review, M4)", (prompt, terms) => {
    expect(promptTerms(prompt).content).toEqual(terms);
  });

  test("the supplement is German: an English prompt keeps the word", () => {
    expect(promptTerms("the gibt parser fails").content).toEqual(["gibt", "parser", "fails"]);
  });

  test("words repeat once, in order, lower-cased; words under three letters are not words", () => {
    expect(promptTerms("Cache cache KEY on a db").content).toEqual(["cache", "key"]);
  });

  test.each([
    ["CI rot", ["ci", "rot"]],
    ["DB down", ["db"]],
    ["CI?", ["ci"]],
    ["UI kaputt", ["ui", "kaputt"]],
  ])("two capitals are a word however short: %p (hold-out review, M6)", (prompt, terms) => {
    expect(promptTerms(prompt).content).toEqual(terms);
    expect(isContentFreePrompt(prompt)).toBe(false);
  });

  test("two lower-case letters stay too short to be a word", () => {
    expect(promptTokens("npm ci kaputt, db leer")).toEqual(["npm", "kaputt", "leer"]);
  });

  test("a filler word is never a term either (round 3, H1)", () => {
    expect(promptTerms("ähm der Upload Komma bricht ab Punkt").content).toEqual(["upload", "bricht"]);
  });

  test("a steering word is never a term, even beside a task word (H1)", () => {
    expect(promptTerms("mache weiter mit den Tests für den Upload, bitte").content).toEqual(["tests", "upload"]);
    expect(promptTerms("please continue with the checkout tests").content).toEqual(["checkout", "tests"]);
  });

  test.each([
    ["token refresh fails after key rotation", ["refresh", "fails", "key", "rotation"]],
    ["run the checkout e2e tests", ["checkout", "e2e"]],
    ["the usage limit banner shows wrong numbers", ["banner", "shows", "wrong", "numbers"]],
    ["why does the usage limit reset", []],
  ])("the TOPICAL terms of %p are its content terms of no closed class (C1)", (prompt, topical) => {
    expect(promptTerms(prompt).topical).toEqual(topical);
  });

  test("meta, conversation and operation words stay terms in a task prompt", () => {
    expect(promptTerms("continue the StatsBomb rate limit work").content).toEqual(["statsbomb", "rate", "limit", "work"]);
    expect(promptTerms("run the checkout e2e tests").content).toEqual(["run", "checkout", "e2e", "tests"]);
  });

  test.each([
    ["mache weiter", "nothing but steering"],
    ["passt scho", "nothing but steering"],
    ["mach weiter bitet", "steering with a swapped pair"],
    ["please continue", "a trigger alone"],
    ["mach weiter, usage limit ist wieder da", "a trigger beside meta words (a)"],
    ["macxhe weiter, usage limit ist zurukgsetz", "a trigger beside meta words, slipped (a, b)"],
    ["Kontingent wieder voll, weiter", "a trigger beside meta words, whatever they report (a)"],
    ["weekly usage limit expired, keep going", "a trigger beside meta words and their clock (a)"],
    ["okay so the usage limit was reset a few minutes ago, please just continue with whatever you were doing", "a trigger beside meta and conversation words"],
    ["continue with the reset", "a trigger beside a meta word (a)"],
    ["think again, shorter", "conversation words (c)"],
    ["Option 2 bitte", "picking an option (c)"],
    ["wait, stop", "an interrupt (c)"],
    ["commit and push", "agent operations (c)"],
    ["run the tests again", "agent operations and a conversation word (c)"],
    ["ok, commit and push, then open the PR and run the tests again please", "agent operations (c)"],
    ["retry please", "one meta word and a steering word"],
    ["rate limit is gone, retry", "a restart verb beside meta words only (C1)"],
    ["retry limit", "a restart verb beside a meta word (C1)"],
    ["restart the session", "a restart verb beside a meta word (C1)"],
    ["rerun", "a restart verb alone (C1)"],
    ["retry", "a restart verb alone (C1)"],
    ["mach mal, bitte", "a trigger and two steering words"],
    ["okay Komma mach weiter Punkt", "dictated punctuation (round 3, H1)"],
    ["äh weiter Fragezeichen", "dictated punctuation and a filler (H1)"],
    ["okay neue Zeile mach weiter", "a dictated new line (H1)"],
    ["jaja weiter weiter", "a filler assent (H1)"],
    ["ja nee passt schon mach weiter", "a filler no (H1)"],
    ["sure thing", "a filler noun (H1)"],
    ["gut, dann weiter im text", "a filler noun (H1)"],
    ["sorry war limit, weiter", "an apology beside a trigger and a meta word (H1)"],
    ["mahc weiter", "a swapped four-letter trigger (H1)"],
    ["mcah weiter bitte", "a swapped four-letter trigger (H1)"],
    ["kepe going", "a swapped four-letter trigger (H1)"],
    ["it keeps going, continue", "a trigger's inflection (H1)"],
    ["ok continued, thanks", "a trigger's inflection (H1)"],
    ["tried again, retrying", "a trigger's inflections (H1)"],
    ["sorry, limit", "a filler beside one meta word (H1)"],
    ["session limit hit earlier, it's back now, continue", "the clock and a limit report (H1)"],
    ["token limit war erreicht, jetzt weiter", "a German limit report (H1)"],
    ["limit zurückgesetzt um 14 uhr, weiter gehts", "the clock in German (H1)"],
    ["erklär nochmal einfacher", "a German conversation word (H1)"],
    ["committe und pushe bitte", "German forms of operations (H1)"],
    ["tests laufen lassen", "German forms of operations (H1)"],
    ["/code-review", "a bare slash command (d)"],
    ["", "nothing at all"],
  ])("%p is content-free — %s", (prompt) => {
    expect(isContentFreePrompt(prompt)).toBe(true);
  });

  test.each([
    ["why does the usage limit reset", "meta words alone ask about the machinery"],
    ["reset the limits please", "two meta words and a steering word"],
    ["retry limit for failed imports is too low", "a restart verb beside a topic"],
    ["session expires after 15 minutes", "meta words and their clock, no trigger"],
    ["run the checkout e2e tests", "one word of no class"],
    ["continue the database migration", "a trigger beside a topic"],
    ["the limit was reset but StatsBomb still returns 429, continue debugging", "a topic among meta words"],
    ["Stop the worker before migration?", "an interrupt word beside a topic"],
    ["who reviews my PR before merge?", "an inflection is no operation word"],
    ["CI?", "two capitals are a topic"],
    ["test runner keeps rerunning failed tests", "an inflected trigger beside a topic (H1)"],
    ["the text field overflows the dialog", "a filler noun beside a topic (H1)"],
  ])("%p names a task — %s", (prompt) => {
    expect(isContentFreePrompt(prompt)).toBe(false);
  });

  test("the verdict stays fast on a window of distinct near-words", () => {
    // Arrange — 4,000 distinct tokens, each starting like a class word
    const prompt = Array.from({ length: 4000 }, (_, index) => `contin${String(index)}`).join(" ");
    const VERDICT_BUDGET_MS = 500;

    // Act
    const started = performance.now();
    const verdict = isContentFreePrompt(prompt);
    const elapsed = performance.now() - started;

    // Assert
    expect(verdict).toBe(false);
    expect(elapsed).toBeLessThan(VERDICT_BUDGET_MS);
  });

  test("every token is judged — a task word past the sixteenth is kept", () => {
    const filler = Array.from({ length: 40 }, (_, index) => `the and of to with ${String(index)}xx`).join(" ");
    expect(promptTerms(`${filler} checkout`).content).toContain("checkout");
  });
});
