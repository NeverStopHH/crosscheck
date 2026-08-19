import { describe, expect, test } from "bun:test";
import { MAX_HINT_TEXT_LENGTH } from "@crosscheck/schema";

import {
  HINT_MIN_EVIDENCE_REFS,
  HTTP_TIMEOUT_MS,
  MAX_HINTS_PER_PROMPT,
  MAX_HINTS_PER_SESSION,
  PRE_TOOL_USE_BUDGET_RATIO,
  USER_PROMPT_SUBMIT_BUDGET_RATIO,
} from "../src/constants.ts";

/**
 * The ARITHMETIC guard for the hint budgets — the same split the hook reserve
 * uses (see HOOK_RESERVE_RATIO in src/constants.ts): this file is the detector
 * that runs identically on every machine, and hint-hook-latency.test.ts is the
 * measured consequence through the real hook. Neither replaces the other.
 */
const USER_PROMPT_SUBMIT_BUDGET_MS = 800;
const CHARS_PER_TOKEN = 4;
const MAX_HINT_TOKENS = 300;

describe("hint budgets are the specified constants (DESIGN.md §4)", () => {
  test("UserPromptSubmit total budget is exactly 800 ms at default timeouts", () => {
    expect(USER_PROMPT_SUBMIT_BUDGET_RATIO * HTTP_TIMEOUT_MS).toBe(
      USER_PROMPT_SUBMIT_BUDGET_MS,
    );
  });

  test("PreToolUse holds the same bound — a blocked tool call is a keystroke too", () => {
    expect(PRE_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS).toBeLessThanOrEqual(
      USER_PROMPT_SUBMIT_BUDGET_MS,
    );
  });

  test("hint text budget is 300 tokens at 4 chars/token", () => {
    expect(MAX_HINT_TEXT_LENGTH).toBe(MAX_HINT_TOKENS * CHARS_PER_TOKEN);
  });

  test("the session noise budget is 5 hints, the prompt budget 1", () => {
    expect(MAX_HINTS_PER_SESSION).toBe(5);
    expect(MAX_HINTS_PER_PROMPT).toBe(1);
  });

  test("substance requires at least one evidence ref", () => {
    expect(HINT_MIN_EVIDENCE_REFS).toBe(1);
  });
});
