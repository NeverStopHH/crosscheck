/**
 * A prompt's CONTENT terms (DESIGN.md §4): its words after PostgreSQL's own
 * stop lists (mirrored in stop-words.ts, pinned against the database in
 * server/test/hint-content-terms.test.ts). The English list always applies;
 * the German one only to a prompt that reads as German, so "why does the
 * worker die" keeps "die" (review 1006b, L1). Every token is judged, not the
 * first sixteen.
 */
import { describe, expect, test } from "bun:test";

import { isGermanPrompt, promptTerms, promptTokens } from "../src/prompt-terms.ts";

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
    expect(promptTerms("warum wird das Upload-Limit nicht erhöht").content).toEqual(["warum", "upload", "limit", "erhöht"]);
  });

  test("words repeat once, in order, lower-cased; words under three letters are not words", () => {
    expect(promptTerms("Cache cache KEY on a db").content).toEqual(["cache", "key"]);
  });

  test("every token is judged — a task word past the sixteenth is kept", () => {
    const filler = Array.from({ length: 40 }, (_, index) => `the and of to with ${String(index)}xx`).join(" ");
    expect(promptTerms(`${filler} checkout`).content).toContain("checkout");
  });
});
