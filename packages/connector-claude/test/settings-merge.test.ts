import { describe, expect, test } from "bun:test";

import { buildSettingsPlan, mergeClaudeSettings } from "../src/index.ts";

const PLAN = buildSettingsPlan("crosscheck", false);

const FOREIGN_SETTINGS = {
  hooks: {
    PostToolUse: [
      {
        matcher: "Write",
        hooks: [{ type: "command", command: "prettier --write" }],
      },
    ],
  },
  permissions: { allow: ["Bash(bun test)"] },
} as const;

describe("buildSettingsPlan", () => {
  /**
   * Trial finding M10: SESSION_END_BUDGET_RATIO x a 2000 ms measured request
   * timeout gives this connector a 4000 ms internal budget for SessionEnd,
   * against Claude Code's documented 1.5-second SessionEnd share — so a big
   * enough flush is killed by the host mid-write. The documented lever is the
   * per-hook `timeout` key, which raises the host's budget to match, up to 60.
   */
  test("SessionEnd carries the explicit 60-second host timeout", () => {
    // Act
    const entry = PLAN.hooks["SessionEnd"]?.hooks[0];

    // Assert
    expect(entry?.command).toBe("crosscheck hook session-end");
    expect(entry?.timeout).toBe(60);
  });

  test("no other event carries a timeout — one lever, one place", () => {
    // Act
    const others = Object.entries(PLAN.hooks).filter(
      ([event]) => event !== "SessionEnd",
    );

    // Assert
    for (const [event, group] of others) {
      expect(group.hooks[0]?.timeout, event).toBeUndefined();
    }
  });

  test("re-running init does not duplicate the SessionEnd entry", () => {
    // Arrange: a settings file that already carries a crosscheck install
    const first = mergeClaudeSettings({}, PLAN);

    // Act
    const second = mergeClaudeSettings(first.settings, PLAN);

    // Assert: strip-and-append leaves exactly one, still with its timeout
    const groups = (second.settings["hooks"] as Record<string, unknown>)[
      "SessionEnd"
    ] as { hooks: { command: string; timeout?: number }[] }[];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.hooks).toHaveLength(1);
    expect(groups[0]?.hooks[0]?.timeout).toBe(60);
  });

  test("registers the Stop hook, async, for the Tier-1 summarizer gate", () => {
    // DESIGN.md §3 Tier 1: the gated Stop-hook summarizer needs the Stop
    // event; async because the hook returns nothing — it gates and spawns.
    const stop = PLAN.hooks["Stop"];
    expect(stop).toBeDefined();
    expect(JSON.stringify(stop)).toContain("crosscheck hook stop");
    expect(stop?.hooks[0]?.async).toBe(true);
  });
});

describe("mergeClaudeSettings", () => {
  test("preserves foreign PostToolUse hooks", () => {
    // Act
    const merged = mergeClaudeSettings({ ...FOREIGN_SETTINGS }, PLAN);

    // Assert
    const groups = (merged.settings["hooks"] as Record<string, unknown>)[
      "PostToolUse"
    ] as readonly Record<string, unknown>[];
    expect(groups).toHaveLength(2);
    expect(JSON.stringify(groups[0])).toContain("prettier --write");
    expect(JSON.stringify(groups[1])).toContain("crosscheck hook post-tool-use");
  });

  test("leaves unrelated settings keys untouched", () => {
    // Act
    const merged = mergeClaudeSettings({ ...FOREIGN_SETTINGS }, PLAN);

    // Assert
    expect(merged.settings["permissions"]).toEqual({
      allow: ["Bash(bun test)"],
    });
  });

  test("running init twice produces a byte-identical file", () => {
    // Act
    const once = mergeClaudeSettings({ ...FOREIGN_SETTINGS }, PLAN);
    const twice = mergeClaudeSettings(once.settings, PLAN);

    // Assert
    expect(JSON.stringify(twice.settings, null, 2)).toBe(
      JSON.stringify(once.settings, null, 2),
    );
  });

  test("preserves a foreign statusline and reports it", () => {
    // Act
    const merged = mergeClaudeSettings(
      { statusLine: { type: "command", command: "starship prompt" } },
      PLAN,
    );

    // Assert
    expect(merged.statuslineInstalled).toBe(false);
    expect(merged.foreignStatuslineCommand).toBe("starship prompt");
    expect(merged.settings["statusLine"]).toEqual({
      type: "command",
      command: "starship prompt",
    });
  });

  test("replaces a foreign statusline only when forced", () => {
    // Act
    const merged = mergeClaudeSettings(
      { statusLine: { type: "command", command: "starship prompt" } },
      buildSettingsPlan("crosscheck", true),
    );

    // Assert
    expect(merged.statuslineInstalled).toBe(true);
    expect(merged.settings["statusLine"]).toEqual({
      type: "command",
      command: "crosscheck statusline",
    });
  });

  test("adopts an existing crosscheck statusline as its own", () => {
    // Act
    const merged = mergeClaudeSettings(
      {
        statusLine: {
          type: "command",
          command: "bunx --bun @crosscheck/cli statusline",
        },
      },
      PLAN,
    );

    // Assert
    expect(merged.statuslineInstalled).toBe(true);
  });
});
