/**
 * The human text of a prompt turn (DESIGN.md §4): a harness delivers machine
 * text as user turns — Claude Code's background-task notifications, another
 * agent's or session's message — and their words (PR, CI, checks, pass,
 * event) are nobody's task. Seen live on 0.10.0: four consecutive pointers
 * at unrelated trees, every one fired by such a turn or by "mache weiter".
 *
 * EXACT, NOT AN HTML STRIPPER: one head marker and three named wrappers; any
 * other angle-bracket text is the human's and stays.
 */
import { describe, expect, test } from "bun:test";

import {
  SYSTEM_NOTIFICATION_MARKER,
  humanPromptText,
  isHarnessTurn,
} from "../src/harness-turn.ts";

const TASK_NOTIFICATION =
  "<task-notification><task-id>bp1v5vsl4</task-id>" +
  '<summary>Monitor event: "PR #74 CI checks for 493ffb4f"</summary>' +
  "<event>Comment claims (macos-latest): pass</event></task-notification>";

describe("a turn the harness wrote is nobody's prompt", () => {
  test.each([
    ["a task notification", TASK_NOTIFICATION],
    ["the system-notification marker at the head", `${SYSTEM_NOTIFICATION_MARKER}\n${TASK_NOTIFICATION}`],
    ["the marker followed by plain words", `${SYSTEM_NOTIFICATION_MARKER} Monitor event: PR #74 CI checks pass`],
    ["another agent's message", '<agent-message from="a781e1e961b68f4c2">Report: all suites pass</agent-message>'],
    ["another session's message", '<cross-session-message from="ken-laptop">CI checks pass on main</cross-session-message>'],
    ["two wrappers and whitespace", `  ${TASK_NOTIFICATION}\n\n${TASK_NOTIFICATION}  `],
    ["a wrapper cut off before it closes", "<task-notification><summary>Monitor event: PR #74 CI checks"],
  ])("%s has no human text", (_, turn) => {
    expect(humanPromptText(turn)).toBe("");
    expect(isHarnessTurn(turn)).toBe(true);
  });
});

describe("the human text around a wrapper is kept, and only it", () => {
  test("text before and after a notification survives; the notification does not", () => {
    const turn = `why does the OPTA extraction drop events ${TASK_NOTIFICATION} after the retry`;
    expect(humanPromptText(turn)).toBe("why does the OPTA extraction drop events after the retry");
    expect(isHarnessTurn(turn)).toBe(false);
  });

  test("words on either side of a wrapper never fuse into one", () => {
    expect(humanPromptText(`cache${TASK_NOTIFICATION}key`)).toBe("cache key");
  });
});

describe("everything else is the human's, exactly as typed", () => {
  test.each([
    ["a plain prompt", "why does src/auth/refresh.ts 500 after the key rotation"],
    ["other angle-bracket text", "the <div> in <Player/> overflows; compare <task-id> handling"],
    ["the marker quoted mid-prompt", `what does ${SYSTEM_NOTIFICATION_MARKER} mean in the hook input`],
    ["a tag that only starts like a wrapper", "<task-notifications> is the wrong element name"],
  ])("%s is untouched", (_, prompt) => {
    expect(humanPromptText(prompt)).toBe(prompt);
    expect(isHarnessTurn(prompt)).toBe(false);
  });

  test("a pasted megabyte of whitespace around a wrapper costs linear time, inside a hook budget", () => {
    const LINEAR_BOUND_MS = 250;
    const turn = `${" ".repeat(1_000_000)}${TASK_NOTIFICATION}${"\t".repeat(1_000_000)}x`;
    const started = performance.now();
    expect(humanPromptText(turn)).toBe("x");
    expect(performance.now() - started).toBeLessThan(LINEAR_BOUND_MS);
  });

  test("an empty or blank prompt is not a harness turn — there was nothing to wrap", () => {
    expect(isHarnessTurn("")).toBe(false);
    expect(isHarnessTurn("   ")).toBe(false);
  });
});
