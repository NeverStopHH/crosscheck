/**
 * The sentence a substance hint shows (DESIGN.md §4): the FIRST sentence of a
 * claim body that carries content — never "1.", "Yes.", "Bestätigt.", "See PR
 * #412.", "Wir nutzen z." or a frame around nothing but a full stop (review
 * of batch 1006, finding 7). One function for both sides: the connector shows
 * it and the hub scores relevance on it, so the two can never disagree about
 * which sentence a hint is.
 */
import { describe, expect, test } from "bun:test";

import { SUBSTANCE_MIN_WORDS, substanceSentence } from "../src/substance-sentence.ts";

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
