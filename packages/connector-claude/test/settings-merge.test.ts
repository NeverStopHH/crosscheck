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
