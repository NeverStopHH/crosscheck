/**
 * The oldest Claude Code the nested summarizer may run on (core constants
 * SUMMARIZER_CLAUDE_MIN_VERSION, 2.1.101). The lean flags themselves are
 * accepted well before it; the floor exists because `--setting-sources ""`
 * — no `user` source — let Claude Code's background cleanup ignore
 * cleanupPeriodDays and delete conversation history older than 30 days
 * until 2.1.101 fixed it (Claude Code CHANGELOG.md, 2.1.101). A developer
 * with a longer retention on an older CLI would lose transcripts on every
 * fire, so doctor's probe reads `claude --version` and WARNs below the floor
 * (cli/test/doctor-summarizer-runner.test.ts pins the line).
 */
import { describe, expect, test } from "bun:test";

import { SUMMARIZER_CLAUDE_MIN_VERSION } from "@crosscheck/connector-core/constants.ts";
import { isBelowSummarizerVersionFloor } from "../src/summarizer/probe.ts";

describe("isBelowSummarizerVersionFloor (the 2.1.101 transcript-cleanup floor)", () => {
  test("the floor is 2.1.101 — the changelog entry that fixed the cleanup", () => {
    expect(SUMMARIZER_CLAUDE_MIN_VERSION).toBe("2.1.101");
  });

  test("versions below the floor are below: the buggy range and anything older", () => {
    expect(isBelowSummarizerVersionFloor("2.1.100")).toBe(true);
    expect(isBelowSummarizerVersionFloor("2.1.99")).toBe(true);
    expect(isBelowSummarizerVersionFloor("2.0.24")).toBe(true);
    expect(isBelowSummarizerVersionFloor("1.0.73")).toBe(true);
    // numeric, not lexicographic: 2.1.9 < 2.1.101 even though "9" > "1"
    expect(isBelowSummarizerVersionFloor("2.1.9")).toBe(true);
  });

  test("the floor itself and everything newer are not below", () => {
    expect(isBelowSummarizerVersionFloor("2.1.101")).toBe(false);
    expect(isBelowSummarizerVersionFloor("2.1.102")).toBe(false);
    expect(isBelowSummarizerVersionFloor("2.1.237")).toBe(false);
    expect(isBelowSummarizerVersionFloor("2.2.0")).toBe(false);
    expect(isBelowSummarizerVersionFloor("3.0.0")).toBe(false);
  });

  test("a missing or unreadable version never warns — doctor says what it knows, not what it guesses", () => {
    expect(isBelowSummarizerVersionFloor(null)).toBe(false);
    expect(isBelowSummarizerVersionFloor("")).toBe(false);
    expect(isBelowSummarizerVersionFloor("NONE")).toBe(false);
    expect(isBelowSummarizerVersionFloor("unknown")).toBe(false);
    expect(isBelowSummarizerVersionFloor("2.1.x")).toBe(false);
  });

  test("a pre-release or build suffix on the last part is read by its number", () => {
    expect(isBelowSummarizerVersionFloor("2.1.100-beta.1")).toBe(true);
    expect(isBelowSummarizerVersionFloor("2.1.237-rc1")).toBe(false);
  });
});
