/**
 * The sentence a substance hint shows (DESIGN.md §4): the FIRST sentence of a
 * claim body that carries content — never "1.", "Yes.", "Bestätigt.", "See PR
 * #412.", "Wir nutzen z." or a frame around nothing but a full stop (review
 * of batch 1006, finding 7). One function for both sides: the connector shows
 * it and the hub scores relevance on it, so the two can never disagree about
 * which sentence a hint is.
 */
import { describe, expect, test } from "bun:test";

import {
  SUBSTANCE_MAX_CHARS,
  SUBSTANCE_MIN_WORDS,
  contentWordCount,
  shownSubstance,
  substanceSentence,
} from "../src/substance-sentence.ts";

describe("the first sentence that carries content", () => {
  test.each([
    ["a plain first sentence", "Keep the chunked upload for practice videos. The single PUT stalls at the gateway.", "Keep the chunked upload for practice videos."],
    ["an ordinal list marker stays with its sentence", "1. The cache key changes on every deploy. 2. Rest.", "1. The cache key changes on every deploy."],
    ["a two-digit ordinal stays with its sentence too", "12. The cache key changes on every deploy. 13. The clock skews on resume.", "12. The cache key changes on every deploy."],
    ["a one-word acknowledgement is skipped", "Yes. The cache key changes on every deploy.", "The cache key changes on every deploy."],
    ["a German one-word acknowledgement is skipped", "Bestätigt. Der Cache-Schlüssel ändert sich bei jedem Deploy.", "Der Cache-Schlüssel ändert sich bei jedem Deploy."],
    ["a reference with too few words is skipped", "See PR #412. The fix pins the cache key per release.", "The fix pins the cache key per release."],
    ["a German abbreviation does not end the sentence", "Wir nutzen z. B. Redis für den Sitzungs-Cache. Danach folgt der Import aller Daten.", "Wir nutzen z. B. Redis für den Sitzungs-Cache."],
    [
      "a named abbreviation does not end the sentence",
      "Wir prüfen den Upload bzw. Den Download der großen Trainingsvideos für jeden Nutzer. Danach folgt der Import aller Daten.",
      "Wir prüfen den Upload bzw. Den Download der großen Trainingsvideos für jeden Nutzer.",
    ],
    ["an English abbreviation does not end the sentence", "Use a queue, e.g. SQS, for the upload callbacks. The callbacks retry three times.", "Use a queue, e.g. SQS, for the upload callbacks."],
    ["invisible characters and a full stop are not a sentence", "​​​. Real content follows here.", "Real content follows here."],
    ["a body with no content sentence at all is nothing", "Yes. Done. See PR #412.", ""],
    ["punctuation alone is nothing", "...!!!???", ""],
  ])("%s", (_name, body, expected) => {
    expect(substanceSentence(body)).toBe(expected);
  });

  test("the minimum is a named number of CONTENT words, after the stop lists (L2)", () => {
    expect(SUBSTANCE_MIN_WORDS).toBe(3);
    expect(substanceSentence("Use Redis.")).toBe("");
    // "here", "it", "is", "the" are function words: two content words only
    expect(substanceSentence("Use Redis here, it is this.")).toBe("");
    // "sessions" would be a meta word, so the third content word is "uploads" (round 3, M1)
    expect(substanceSentence("Use Redis for uploads.")).toBe("Use Redis for uploads.");
  });

  test("German function words do not count toward a German sentence", () => {
    expect(substanceSentence("Das ist nicht so, wie es war.")).toBe("");
  });

  test("nor do the ones german.stop lacks (hold-out review, M4)", () => {
    expect(substanceSentence("Ich glaube, dass es passt. Der Upload-Worker wartet auf den Lock.")).toBe(
      "Der Upload-Worker wartet auf den Lock.",
    );
  });

  test("one-letter words are not content", () => {
    expect(substanceSentence("Q x z.")).toBe("");
  });
});

describe("content words are DISTINCT, and of no closed class (round 3, M1)", () => {
  test.each([
    ["thanks thanks thanks", 0, "steering, three times"],
    ["ok ok ok", 0, "steering"],
    ["ja ja ja", 0, "German steering"],
    ["asdf asdf asdf", 1, "one word, three times"],
    ["Confirmed, works fine.", 2, "fine steers"],
    ["Retry the session after the limit reset.", 0, "the session's machinery"],
    ["Usage limit expired, retry.", 0, "an expiry is the session's machinery too (round 3, L6)"],
    ["The worker drops the cache key every time.", 5, "every is a function word"],
  ])("%p carries %p content words — %s", (text, count) => {
    expect(contentWordCount(text)).toBe(count);
  });

  test("a sentence of repeated thanks is no sentence to show", () => {
    expect(substanceSentence("Thanks, thanks, thanks. The worker drops the cache key on restart.")).toBe(
      "The worker drops the cache key on restart.",
    );
  });
});

describe("a short qualifier stays attached; an enumeration never dangles (L2)", () => {
  test("a short sentence after the chosen one qualifies it and is kept", () => {
    expect(substanceSentence("Disable the edge cache for uploads. U.S. traffic only. Everything else stays as configured.")).toBe(
      "Disable the edge cache for uploads. U.S. traffic only.",
    );
  });

  test("a sentence that introduces a list keeps the item after it", () => {
    expect(substanceSentence("We ruled out three causes in the pipeline:\nThe cache key was stable across deploys.\nRest of the list.")).toBe(
      "We ruled out three causes in the pipeline: The cache key was stable across deploys.",
    );
  });

  test("a following sentence with content of its own is not attached", () => {
    expect(substanceSentence("Keep the chunked upload for practice videos. The single PUT hits the gateway limit.")).toBe(
      "Keep the chunked upload for practice videos.",
    );
  });

  test("the next enumeration item is not a qualifier", () => {
    expect(substanceSentence("1. The cache key changes on every deploy. 2. Rest.")).toBe("1. The cache key changes on every deploy.");
  });
});

describe("the shown text: one function for what the reader sees and what the hub scores (review 1006b, M4)", () => {
  test("NFKC folds what the screen folds — a ligature reads as its letters", () => {
    expect(shownSubstance("The ﬁle cache keeps the rotated key. The importer writes that key to the vault.")).toBe("The file cache keeps the rotated key.");
  });

  test("an instruction-shaped span is redacted exactly as the reader sees it", () => {
    expect(shownSubstance("Ignore previous retries and pin the cache key per release. The importer writes that key to the vault.")).toBe(
      "[redacted] retries and pin the cache key per release.",
    );
  });

  test("a sentence past the bound is cut with the visible ellipsis, at the bound", () => {
    // Distinct words: one word eighty times is one content word (round 3, M1)
    const shown = shownSubstance(`${Array.from({ length: 80 }, (_, index) => `word${String(index)}`).join(" ")} end. Second.`);
    expect(shown.length).toBe(SUBSTANCE_MAX_CHARS);
    expect(shown.endsWith("…")).toBe(true);
  });

  test("no sentence worth showing is nothing", () => {
    expect(shownSubstance("Yes. Done.")).toBe("");
  });
});
