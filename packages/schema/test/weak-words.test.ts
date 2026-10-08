/**
 * GENERIC DEVELOPMENT WORDS ARE NO TOPIC ON THEIR OWN (hold-out review round
 * 4, decision 3). "add pagination to the users admin table" was shown the SSO
 * tree's decision on "add" and "users"; "upgrade react to 19" was pointed at
 * the Gradle tree on "upgrade"; a log paste reached the date-picker tree on
 * "2026" and "new". A WEAK word still counts as a shared word beside a topical
 * one, but never as the topical one: a prompt matching only on weak words and
 * words that are never terms gets nothing.
 */
import { describe, expect, test } from "bun:test";

import { clearsFloorOn, floorTermsOf } from "../src/content-floor.ts";
import { WEAK_WORDS } from "../src/prompt-vocabulary.ts";
import { isWeakWord, promptTerms } from "../src/prompt-terms.ts";
import { isSteeringWord } from "../src/session-control.ts";

const floorOf = (prompt: string) => {
  const terms = promptTerms(prompt);
  return floorTermsOf(terms, terms.ranked);
};

describe("a weak word is no topic", () => {
  test.each([
    ["add pagination to the users admin table", ["pagination", "admin", "table"]],
    ["upgrade react to 19", ["react"]],
    ["write a migration that adds a nullable phone column to users", ["migration", "nullable", "phone", "column"]],
    ["ws-gateway new connections spike since 2026", ["gateway", "connections", "spike"]],
  ])("the topical terms of %p leave the weak words out", (prompt, topical) => {
    expect(promptTerms(prompt).topical).toEqual(topical);
  });

  test("but it is still a term: the second shared word beside a topical one", () => {
    expect(promptTerms("add pagination to the users admin table").content).toEqual(["add", "pagination", "users", "admin", "table"]);
    expect(clearsFloorOn(floorOf("add pagination to the users admin table"), "Pagination for users")).toBe(true);
  });

  test("a statement sharing only weak words clears nothing", () => {
    expect(clearsFloorOn(floorOf("add pagination to the users admin table"), "Add users to enterprise tenants")).toBe(false);
  });

  test("a weak word ranks after the topical ones, beside the class words", () => {
    expect(promptTerms("add pagination to the users admin table").ranked).toEqual(["pagination", "admin", "table", "add", "users"]);
  });
});

describe("the weak class", () => {
  test.each([["add"], ["Update"], ["new"], ["users"], ["2026"], ["Seite"], ["hinzufügen"]])("%p is weak", (word) => {
    expect(isWeakWord(word)).toBe(true);
  });

  test.each([
    ["token", "a meta word a task is about (M1)"],
    ["limit", "a meta word a task is about (M1)"],
    ["deploy", "an operation a task is about (M1)"],
    ["logs", "an operation a task is about (M1)"],
    ["pagination", "a topic"],
    ["429", "a status code is a fact, not a year"],
    ["3000", "a port, not a year"],
  ])("%p is not — %s", (word) => {
    expect(isWeakWord(word)).toBe(false);
  });

  test("holds no steering word, which is never a term at all, and no duplicate", () => {
    expect(WEAK_WORDS.filter(isSteeringWord)).toEqual([]);
    expect(new Set(WEAK_WORDS).size).toBe(WEAK_WORDS.length);
  });
});
