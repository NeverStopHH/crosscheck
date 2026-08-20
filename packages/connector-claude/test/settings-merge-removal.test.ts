/**
 * Clobber-safety for the user-level install (finding #11), property-style:
 * ~/.claude/settings.json holds the user's OWN hooks, statusLine,
 * permissions, anything — so install must be purely additive and removal
 * must restore every foreign byte. The generator is seeded and
 * deterministic (mulberry32 — no flake-luck, same cases every run), the
 * render is the same 2-space JSON init writes, and the property is exact:
 *
 *   render(remove(merge(settings))) === render(settings)
 *
 * for arbitrary foreign settings, plus merge preserving every foreign key
 * and hook. The same round trip is pinned for the mcp config
 * (~/.claude.json — Claude Code's own state file) here, and for Cursor's
 * ~/.cursor/hooks.json in connector-cursor/test/hooks-merge-removal.test.ts
 * (this package does not depend on connector-cursor).
 */
import { describe, expect, test } from "bun:test";

import {
  buildSettingsPlan,
  mergeClaudeSettings,
  removeClaudeSettings,
} from "../src/index.ts";
import {
  mergeMcpConfig,
  removeMcpConfig,
} from "@crosscheck/connector-core/config/mcp-config.ts";
import type { McpServerEntry } from "@crosscheck/connector-core/config/mcp-config.ts";

const PLAN = buildSettingsPlan("crosscheck", false);
const MCP_ENTRY: McpServerEntry = {
  type: "stdio",
  command: "crosscheck",
  args: ["mcp"],
};

const render = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value, null, 2)}\n`;

/** Deterministic PRNG — the property runs the same cases on every machine. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(random: () => number, options: readonly T[]): T =>
  options[Math.floor(random() * options.length)] as T;

const FOREIGN_COMMANDS = [
  "prettier --write",
  "bun run lint",
  "/usr/local/bin/notify.sh done",
  "echo ok",
] as const;

const EVENTS = [
  "SessionStart",
  "PostToolUse",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "Stop",
  "Notification",
  "PreCompact",
] as const;

const foreignGroup = (random: () => number): Record<string, unknown> => ({
  ...(random() < 0.5 ? { matcher: pick(random, ["Write", "Bash", "Edit|Write"]) } : {}),
  hooks: Array.from({ length: 1 + Math.floor(random() * 2) }, () => ({
    type: "command",
    command: pick(random, FOREIGN_COMMANDS),
    ...(random() < 0.3 ? { async: true } : {}),
  })),
});

/** Arbitrary foreign settings: hooks on our events and others, extras. */
const foreignSettings = (random: () => number): Record<string, unknown> => {
  const hooks = EVENTS.filter(() => random() < 0.5).reduce<
    Record<string, unknown>
  >(
    (record, event) => ({
      ...record,
      [event]: Array.from(
        { length: 1 + Math.floor(random() * 2) },
        () => foreignGroup(random),
      ),
    }),
    {},
  );
  return {
    ...(random() < 0.7 ? { permissions: { allow: ["Bash(bun test)"] } } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(random() < 0.5
      ? { statusLine: { type: "command", command: "my-statusline" } }
      : {}),
    ...(random() < 0.5 ? { model: "opus" } : {}),
    ...(random() < 0.4 ? { env: { FOO: "bar" } } : {}),
  };
};

const PROPERTY_RUNS = 200;

describe("install/remove round trip on arbitrary foreign settings", () => {
  test("removal restores the byte-identical foreign file", () => {
    const random = mulberry32(0xc05c);
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      // Arrange
      const original = foreignSettings(random);
      const before = render(original);

      // Act
      const installed = mergeClaudeSettings(original, PLAN).settings;
      const removed = removeClaudeSettings(installed);

      // Assert
      expect(removed.changed).toBe(true);
      expect(render(removed.settings)).toBe(before);
    }
  });

  test("merge preserves every foreign key and every foreign hook", () => {
    const random = mulberry32(0xbeef);
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      // Arrange
      const original = foreignSettings(random);

      // Act
      const installed = mergeClaudeSettings(original, PLAN).settings;

      // Assert: every foreign top-level key survives with identical value
      // (hooks and statusLine are merged, everything else must be untouched)
      for (const [key, value] of Object.entries(original)) {
        if (key === "hooks" || key === "statusLine") {
          continue;
        }
        expect(JSON.stringify(installed[key])).toBe(JSON.stringify(value));
      }
      // Every foreign hook command still present somewhere in the merge
      const rendered = JSON.stringify(installed);
      const originalRender = JSON.stringify(original);
      for (const command of FOREIGN_COMMANDS) {
        if (originalRender.includes(command)) {
          expect(rendered).toContain(command);
        }
      }
    }
  });

  test("removal without an install is a no-op that reports changed=false", () => {
    const random = mulberry32(0xfeed);
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const original = foreignSettings(random);
      const removed = removeClaudeSettings(original);
      expect(removed.changed).toBe(false);
      expect(render(removed.settings)).toBe(render(original));
    }
  });

  test("a group mixing a foreign hook with an owned one loses only ours", () => {
    // The hand-edited shape a group-count comparison misses: one group,
    // two hooks, one of them crosscheck's. Removal must keep the group and
    // the foreign hook, and drop exactly the owned entry.
    const mixed: Record<string, unknown> = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [
              { type: "command", command: "prettier --write" },
              { type: "command", command: "crosscheck hook post-tool-use" },
            ],
          },
        ],
      },
    };

    const removed = removeClaudeSettings(mixed);

    expect(removed.changed).toBe(true);
    expect(render(removed.settings)).toBe(
      render({
        hooks: {
          PostToolUse: [
            {
              matcher: "Write",
              hooks: [{ type: "command", command: "prettier --write" }],
            },
          ],
        },
      }),
    );
  });
});

describe("install/remove round trip on the mcp config", () => {
  test("~/.claude.json foreign content — projects state included — survives", () => {
    // Arrange: the shape of Claude Code's own state file, abbreviated
    const original: Record<string, unknown> = {
      numStartups: 42,
      installMethod: "brew",
      projects: {
        "/Users/dev/repo": { allowedTools: [], history: ["do a thing"] },
      },
      mcpServers: {
        playwright: { type: "stdio", command: "npx", args: ["playwright-mcp"] },
      },
    };
    const before = render(original);

    // Act
    const installed = mergeMcpConfig(original, MCP_ENTRY);
    const removed = removeMcpConfig(installed);

    // Assert
    expect(removed.changed).toBe(true);
    expect(render(removed.config)).toBe(before);
  });

  test("a foreign server squatting our key is not ours to delete", () => {
    const original: Record<string, unknown> = {
      mcpServers: { crosscheck: { type: "stdio", command: "who-knows", args: [] } },
    };
    const removed = removeMcpConfig(original);
    expect(removed.changed).toBe(false);
    expect(render(removed.config)).toBe(render(original));
  });

  test("an mcpServers record the install created is removed with the entry", () => {
    const original: Record<string, unknown> = { numStartups: 1 };
    const installed = mergeMcpConfig(original, MCP_ENTRY);
    const removed = removeMcpConfig(installed);
    expect(removed.changed).toBe(true);
    expect(render(removed.config)).toBe(render(original));
  });
});

