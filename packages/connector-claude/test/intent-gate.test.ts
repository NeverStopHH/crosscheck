/**
 * The derived-intent gate and transforms (trial finding #16), pure: which
 * prompts are "substantive" (the N boundary, slash commands, bare yes/no, the
 * token floor) and how fires and outcomes are booked into session state.
 */
import { describe, expect, test } from "bun:test";

import {
  INTENT_MIN_PROMPT_CHARS,
  SUMMARIZER_FAILURE_MAX_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import { deriveSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import {
  intentPromptOf,
  isSubstantivePrompt,
  withIntentFailure,
  withIntentFire,
  withIntentNone,
  withIntentSet,
} from "@crosscheck/connector-core/derive/intent/gate.ts";

const baseState = (): SessionState =>
  deriveSessionState({
    hostSessionKey: "s1",
    repoId: "github.com/acme/api",
    repoRoot: "/tmp/repo",
    hubUrl: "http://127.0.0.1:1",
    developerId: "dev_1",
    startedAt: "2026-08-21T09:00:00.000Z",
  });

const TASK = "why does the refresh call 500 after the key rotation on staging";

describe("isSubstantivePrompt", () => {
  test(`a task of at least ${String(INTENT_MIN_PROMPT_CHARS)} characters fires; one character short does not`, () => {
    expect(TASK.length).toBeGreaterThanOrEqual(INTENT_MIN_PROMPT_CHARS);
    expect(isSubstantivePrompt(TASK)).toBe(true);
    const exact = "x".repeat(INTENT_MIN_PROMPT_CHARS - 4) + " abc";
    expect(exact.length).toBe(INTENT_MIN_PROMPT_CHARS);
    expect(isSubstantivePrompt(exact)).toBe(true);
    expect(isSubstantivePrompt(exact.slice(1))).toBe(false);
  });

  test("surrounding whitespace does not count toward the floor", () => {
    expect(isSubstantivePrompt(`${" ".repeat(50)}fix it${" ".repeat(50)}`)).toBe(false);
  });

  test("a slash command never fires, however long", () => {
    expect(isSubstantivePrompt(`/model haiku and then ${TASK}`)).toBe(false);
    expect(isSubstantivePrompt("/clear")).toBe(false);
  });

  test("a bare acknowledgement never fires, even padded past the floor", () => {
    for (const ack of ["yes", "ok", "go ahead", "continue.", "thanks!", "LGTM"]) {
      expect(isSubstantivePrompt(ack), ack).toBe(false);
    }
  });

  test("a prompt with no word of three characters never fires", () => {
    expect(isSubstantivePrompt("a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g")).toBe(false);
  });
});

describe("intentPromptOf: what the one intent fire is spent on, and what is parked (review 1006b, H2)", () => {
  test("a real task is parked as typed", () => {
    expect(intentPromptOf(TASK)).toBe(TASK);
  });

  test.each([
    ["a task notification", '<task-notification><summary>Monitor event: "PR #74 CI checks for 493ffb4f"</summary></task-notification>'],
    ["the notification marker", "[SYSTEM NOTIFICATION - NOT USER INPUT]\nMonitor event: PR #74 CI checks pass on the branch"],
    ["another agent's report", '<agent-message from="a7">[Subagent hand-back] Report: CI checks pass on PR 74</agent-message>'],
    ["a long content-free prompt", "mache weiter, limit zuruckgesetzt. bitte alles wiederuafnhemen"],
    ["an English one", "please continue, the usage limit was reset, keep going"],
  ])("%s never spends the fire", (_, turn) => {
    expect(intentPromptOf(turn)).toBeNull();
  });

  test("around a wrapper, only the human text is parked", () => {
    const turn = `<ide_opened_file>The user opened the file /repo/src/auth/refresh.ts in the IDE.</ide_opened_file>\n${TASK}`;
    expect(intentPromptOf(turn)).toBe(TASK);
  });

  test("a wrapper does not lend its length to a short human remark", () => {
    const turn = `<ide_opened_file>The user opened the file /repo/src/auth/refresh.ts in the IDE, a long path.</ide_opened_file>\nfix it`;
    expect(intentPromptOf(turn)).toBeNull();
  });
});

describe("intent transforms", () => {
  test("a fire, a NONE, a set and a failure each book their own counter", () => {
    const fired = withIntentFire(baseState());
    expect(fired.intentFireCount).toBe(1);
    expect(withIntentNone(fired).intentNoneCount).toBe(1);
    expect(withIntentSet(fired).intentSetCount).toBe(1);
    const failed = withIntentFailure(fired, "exit 1: Not logged in");
    expect(failed.intentFailCount).toBe(1);
    expect(failed.intentLastFailure).toBe("exit 1: Not logged in");
    // Each outcome is exactly one counter — the remainder arithmetic holds
    expect(failed.intentNoneCount + failed.intentSetCount).toBe(0);
  });

  test(`the failure reason is cut by the writer to ${String(SUMMARIZER_FAILURE_MAX_CHARS)} chars, never split mid-character`, () => {
    const long = withIntentFailure(baseState(), "x".repeat(1000));
    expect(long.intentLastFailure?.length).toBe(SUMMARIZER_FAILURE_MAX_CHARS);
    const astral = withIntentFailure(baseState(), "x".repeat(119) + "😀😀");
    expect(astral.intentLastFailure?.isWellFormed()).toBe(true);
  });

  test("a fresh state carries no title and zero fires (the pre-intent defaults)", () => {
    const state = baseState();
    expect(state.workContextTitle).toBeNull();
    expect(state.workContextStatus).toBeNull();
    expect(state.intentFireCount).toBe(0);
    expect(state.intentLastFailure).toBeNull();
  });
});
