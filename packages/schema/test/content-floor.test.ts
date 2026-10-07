/**
 * THE CONTENT FLOOR, ONE RULE (hold-out review round 3, follow-up): the hub
 * and a connector recounting an old hub call these functions, so the two can
 * no longer disagree about "does this prompt clear the floor against this
 * text". Words match on their english lexemes, a closed-class word's
 * inflection is no topic (L1), and a long prompt needs three topical words on
 * one statement (M7).
 */
import { describe, expect, test } from "bun:test";

import {
  HINT_LONG_PROMPT_KNOWN_TERMS,
  HINT_LONG_PROMPT_MIN_TOPICAL,
  HINT_MAX_COUNTED_TERMS,
  HINT_MAX_EXAMINED_TERMS,
  clearsFloorOn,
  floorTermsOf,
  isClosedInflection,
  knownTermsIn,
  statementMatch,
  textLexemes,
} from "../src/content-floor.ts";
import { promptTerms } from "../src/prompt-terms.ts";

/** The floor of a prompt whose every ranked term the team's text says. */
const floorOf = (prompt: string) => {
  const terms = promptTerms(prompt);
  return floorTermsOf(terms, terms.ranked);
};

describe("words match on their english lexemes, as the hub's database matches them", () => {
  test("an inflection matches its word", () => {
    expect(clearsFloorOn(floorOf("the upload timeouts again"), "Upload timeout on the gateway")).toBe(true);
  });

  test("a text says its lexemes, without the database's English stop words", () => {
    expect([...textLexemes("The workers were evicting cached entries")].sort()).toEqual(["cach", "entri", "evict", "worker"]);
  });

  test("a word with a digit is matched as written, as the database's simple dictionary keeps it", () => {
    expect(textLexemes("HTTP 429 on e2e runs").has("429")).toBe(true);
    expect(textLexemes("HTTP 429 on e2e runs").has("e2e")).toBe(true);
    // and never stemmed, though the stem would take its s
    expect(textLexemes("the e2es pass").has("e2es")).toBe(true);
  });
});

describe("a closed-class word's inflection is no topic (L1) — only an INFLECTED prompt word (round 4, M1)", () => {
  test.each([["shows"], ["stopped"], ["runs"], ["deploys"], ["updated"]])("%p is the inflection of a closed-class word", (word) => {
    expect(isClosedInflection(word)).toBe(true);
  });

  test.each([
    ["dashboard", "no closed word's"],
    ["wrong", "no closed word's"],
    ["cache", "no closed word's"],
    ["refresh", "its own lexeme, though \"refreshed\" is a meta word"],
    ["limits", "a closed word as written"],
    ["usage", "a closed word as written, however the stemmer cuts it"],
  ])("%p is not — %s", (word) => {
    expect(isClosedInflection(word)).toBe(false);
  });

  test("so two inflections of closed words clear nothing on a statement they share", () => {
    // Arrange — "shows" is the conversation word "show", "stopped" the conversation word "stop"
    const floor = floorOf("the counter shows it and then stopped");

    // Act
    const match = statementMatch(floor, "The importer shows progress and then stopped");

    // Assert
    expect(floor.topical).toEqual(["counter"]);
    expect(match.floor).toBe(0);
  });
});

describe("in a task, a meta word is topical (round 4, M1)", () => {
  test("\"token refresh broken\" shares token and refresh with the JWT tree's title", () => {
    expect(statementMatch(floorOf("token refresh broken"), "JWT token refresh fails after signing key rotation")).toEqual({ floor: 2, topical: 2 });
  });

  test("\"rate limit not enforced\" shares rate and limit with the rate-limit tree's title", () => {
    expect(clearsFloorOn(floorOf("rate limit not enforced"), "Rate limit for the public API")).toBe(true);
  });
});

describe("a long prompt needs more topical words on one statement (M7)", () => {
  const LONG_KNOWN = Array.from({ length: HINT_LONG_PROMPT_KNOWN_TERMS + 1 }, (_, index) => `officeword${String.fromCharCode(97 + index)}`);

  test(`more than ${String(HINT_LONG_PROMPT_KNOWN_TERMS)} known words make it long: ${String(HINT_LONG_PROMPT_MIN_TOPICAL)} topical words`, () => {
    // Arrange
    const terms = promptTerms(`${LONG_KNOWN.join(" ")} dashboard totals wrong`);

    // Act
    const long = floorTermsOf(terms, [...LONG_KNOWN, "dashboard", "totals", "wrong"]);
    const short = floorTermsOf(terms, ["dashboard", "totals", "wrong"]);

    // Assert
    expect(long.minTopical).toBe(HINT_LONG_PROMPT_MIN_TOPICAL);
    expect(short.minTopical).toBe(1);
  });

  test("two topical words on the statement clear a short prompt and not a long one", () => {
    // Arrange
    const terms = promptTerms(`${LONG_KNOWN.join(" ")} dashboard totals`);
    const statement = "Usage dashboard shows wrong monthly totals";

    // Act / Assert
    expect(clearsFloorOn(floorTermsOf(terms, ["dashboard", "totals"]), statement)).toBe(true);
    expect(clearsFloorOn(floorTermsOf(terms, [...LONG_KNOWN, "dashboard", "totals"]), statement)).toBe(false);
  });

  test("a caller that cannot see the team's whole text says how many words may be known — the long test fails closed", () => {
    // Arrange — a connector sees three trees on an old hub's wire, the hub its whole repo
    const terms = promptTerms(`${LONG_KNOWN.join(" ")} dashboard totals`);
    const seenOnTheWire = ["dashboard", "totals"];

    // Act
    const floor = floorTermsOf(terms, seenOnTheWire, terms.ranked.length);

    // Assert — counted on what the wire says, long by every word the prompt has
    expect(floor.all).toEqual(seenOnTheWire);
    expect(floor.minTopical).toBe(HINT_LONG_PROMPT_MIN_TOPICAL);
  });

  test(`only the first ${String(HINT_MAX_COUNTED_TERMS)} known terms are counted`, () => {
    const known = Array.from({ length: HINT_MAX_COUNTED_TERMS + 5 }, (_, index) => `term${String(index).padStart(3, "0")}x`);
    expect(floorTermsOf(promptTerms(known.join(" ")), known).all).toHaveLength(HINT_MAX_COUNTED_TERMS);
  });
});

describe("the known terms: of the ranked ones, those some text says", () => {
  test("in the ranked order, matched on lexemes", () => {
    expect(knownTermsIn(["timeouts", "printer", "uploads"], ["Upload timeout on the gateway"])).toEqual(["timeouts", "uploads"]);
  });

  test(`at most ${String(HINT_MAX_EXAMINED_TERMS)} ranked terms are looked at`, () => {
    const ranked = Array.from({ length: HINT_MAX_EXAMINED_TERMS + 1 }, (_, index) => `word${String(index).padStart(4, "0")}x`);
    expect(knownTermsIn(ranked, [ranked.join(" ")])).toHaveLength(HINT_MAX_EXAMINED_TERMS);
  });
});

describe("the floor of one statement (C1)", () => {
  test("two shared words, one of them topical, clear it", () => {
    expect(statementMatch(floorOf("why does the checkout cache drop entries"), "The checkout cache drops entries").floor).toBeGreaterThanOrEqual(2);
  });

  test("round 4, M1: two meta words of a task agree on a statement — the task is about them", () => {
    // Round 3 (C1) counted them for nothing; a question about the session's
    // limit is a task, and the tree about that limit is its answer.
    expect(statementMatch(floorOf("session limit"), "Session limit reset").floor).toBe(2);
  });

  test("two spellings of one word are one shared word", () => {
    // Arrange — "zebrafrobnicator" and "zebrafrobnicators" are one lexeme
    const terms = promptTerms("zebrafrobnicator zebrafrobnicators");

    // Act
    const match = statementMatch(floorTermsOf(terms, terms.ranked), "The zebrafrobnicator broke overnight");

    // Assert
    expect(match.floor).toBe(1);
  });

  test("the topical count is reported whatever the floor", () => {
    expect(statementMatch(floorOf("checkout cache"), "The checkout service").topical).toBe(1);
  });
});
