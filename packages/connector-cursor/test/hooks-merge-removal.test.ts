/**
 * The Cursor half of the finding-#11 removal property (the Claude half and
 * the reasoning live in connector-claude/test/settings-merge-removal.test.ts):
 * ~/.cursor/hooks.json may hold the user's own hooks, and install → remove
 * must hand back the byte-identical foreign file.
 */
import { describe, expect, test } from "bun:test";

import {
  buildCursorHooksPlan,
  mergeCursorHooks,
  removeCursorHooks,
} from "../src/index.ts";

const CURSOR_PLAN = buildCursorHooksPlan("crosscheck");

const render = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value, null, 2)}\n`;

describe("install/remove round trip on cursor hooks", () => {
  test("foreign definitions and unknown keys survive byte-identically", () => {
    // Arrange: a user's ~/.cursor/hooks.json with their own hooks
    const original: Record<string, unknown> = {
      version: 1,
      hooks: {
        afterFileEdit: [{ command: "./hooks/format.sh" }],
        beforeShellExecution: [{ command: "python3 guard.py", timeout: 5 }],
      },
      customKey: { anything: true },
    };
    const before = render(original);

    // Act
    const installed = mergeCursorHooks(original, CURSOR_PLAN);
    const removed = removeCursorHooks(installed);

    // Assert
    expect(removed.changed).toBe(true);
    expect(render(removed.hooks)).toBe(before);
  });

  test("a foreign hook sharing an event with ours survives the strip", () => {
    // Arrange: foreign and owned entries in the SAME event array
    const original: Record<string, unknown> = {
      version: 1,
      hooks: { sessionStart: [{ command: "./hooks/greet.sh" }] },
    };

    // Act
    const installed = mergeCursorHooks(original, CURSOR_PLAN);
    const removed = removeCursorHooks(installed);

    // Assert
    expect(removed.changed).toBe(true);
    expect(render(removed.hooks)).toBe(render(original));
  });

  test("a fresh install removes down to the inert version stub", () => {
    // No prior file: install creates version + our hooks; removal keeps the
    // version stub (whether the file pre-existed is not reconstructable, and
    // a leftover {"version": 1} is inert where a wrong delete is not).
    const installed = mergeCursorHooks({}, CURSOR_PLAN);
    const removed = removeCursorHooks(installed);
    expect(removed.changed).toBe(true);
    expect(removed.hooks).toEqual({ version: 1, hooks: {} });
  });

  test("removal without an install is a no-op that reports changed=false", () => {
    const original: Record<string, unknown> = {
      version: 1,
      hooks: { afterFileEdit: [{ command: "./hooks/format.sh" }] },
    };
    const removed = removeCursorHooks(original);
    expect(removed.changed).toBe(false);
    expect(render(removed.hooks)).toBe(render(original));
  });
});
