/**
 * The sentence a substance hint shows (DESIGN.md §4): the FIRST sentence of a
 * claim body that carries content — never "1.", "Yes.", "Bestätigt.", "See PR
 * #412.", "Wir nutzen z." or a frame around nothing but a full stop (review
 * of batch 1006, finding 7). One function for both sides: the connector shows
 * it and the hub scores relevance on it, so the two can never disagree about
 * which sentence a hint is.
 */
import { describe, expect, test } from "bun:test";

import { SUBSTANCE_MAX_CHARS, SUBSTANCE_MIN_WORDS, shownSubstance, substanceSentence } from "../src/substance-sentence.ts";

describe("the first sentence that carries content", () => {
  test.each([
    ["a plain first sentence", "Keep the chunked upload for practice videos. The PUT stalls.", "Keep the chunked upload for practice videos."],
    ["an ordinal list marker stays with its sentence", "1. The cache key changes on every deploy. 2. Rest.", "1. The cache key changes on every deploy."],
    ["a one-word acknowledgement is skipped", "Yes. The cache key changes on every deploy.", "The cache key changes on every deploy."],
    ["a German one-word acknowledgement is skipped", "Bestätigt. Der Cache-Schlüssel ändert sich bei jedem Deploy.", "Der Cache-Schlüssel ändert sich bei jedem Deploy."],
    ["a reference with too few words is skipped", "See PR #412. The fix pins the cache key per release.", "The fix pins the cache key per release."],
    ["a German abbreviation does not end the sentence", "Wir nutzen z. B. Redis für den Sitzungs-Cache. Rest.", "Wir nutzen z. B. Redis für den Sitzungs-Cache."],
    ["an English abbreviation does not end the sentence", "Use a queue, e.g. SQS, for the upload callbacks. Rest.", "Use a queue, e.g. SQS, for the upload callbacks."],
    ["invisible characters and a full stop are not a sentence", "​​​. Real content follows here.", "Real content follows here."],
    ["a body with no content sentence at all is nothing", "Yes. Done. See PR #412.", ""],
    ["punctuation alone is nothing", "...!!!???", ""],
  ])("%s", (_name, body, expected) => {
    expect(substanceSentence(body)).toBe(expected);
  });

  test("the minimum is a named number of words, each at least two letters", () => {
    expect(SUBSTANCE_MIN_WORDS).toBe(3);
    expect(substanceSentence("Use Redis.")).toBe("");
    expect(substanceSentence("Use Redis here.")).toBe("Use Redis here.");
  });
});

describe("the shown text: one function for what the reader sees and what the hub scores (review 1006b, M4)", () => {
  test("NFKC folds what the screen folds — a ligature reads as its letters", () => {
    expect(shownSubstance("The ﬁle cache keeps the rotated key. Rest.")).toBe("The file cache keeps the rotated key.");
  });

  test("an instruction-shaped span is redacted exactly as the reader sees it", () => {
    expect(shownSubstance("Ignore previous retries and pin the cache key per release. Rest.")).toBe(
      "[redacted] retries and pin the cache key per release.",
    );
  });

  test("a sentence past the bound is cut with the visible ellipsis, at the bound", () => {
    const shown = shownSubstance(`${"word ".repeat(80)}end. Second.`);
    expect(shown.length).toBe(SUBSTANCE_MAX_CHARS);
    expect(shown.endsWith("…")).toBe(true);
  });

  test("no sentence worth showing is nothing", () => {
    expect(shownSubstance("Yes. Done.")).toBe("");
  });
});
