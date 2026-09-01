/**
 * The documented contract, held two ways (design §4.3): the recorded
 * fixtures must keep parsing (WE tightened a parser → this file fails on
 * that pull request), and a payload MISSING a mapped field must degrade to
 * a NAMED drift count instead of a crash or a silent death (§10 risk 5) —
 * driven through the REAL runner, not the schema alone.
 */
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { runCursorHook } from "../src/index.ts";
import {
  missingMappedFields,
  parseCursorPayload,
  CURSOR_HOOK_EVENTS,
} from "../src/payload.ts";
import type { CursorHookEvent } from "../src/payload.ts";
import { readContractDrift } from "../src/drift.ts";
import {
  AFTER_FILE_EDIT_INPUT,
  AFTER_SHELL_EXECUTION_INPUT,
  AFTER_SHELL_EXECUTION_WITH_EXIT,
  POST_TOOL_USE_FAILING_COMMAND,
  POST_TOOL_USE_FAILURE_INPUT,
  POST_TOOL_USE_INPUT,
  SESSION_END_INPUT,
  SESSION_START_INPUT,
  SESSION_START_INPUT_BACKGROUND,
  STOP_INPUT,
} from "./fixtures/cursor-contract/payloads.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";

const FIXTURES: readonly (readonly [CursorHookEvent, object])[] = [
  ["sessionStart", SESSION_START_INPUT],
  ["sessionStart", SESSION_START_INPUT_BACKGROUND],
  ["afterFileEdit", AFTER_FILE_EDIT_INPUT],
  ["afterShellExecution", AFTER_SHELL_EXECUTION_INPUT],
  ["afterShellExecution", AFTER_SHELL_EXECUTION_WITH_EXIT],
  ["postToolUse", POST_TOOL_USE_INPUT],
  ["postToolUse", POST_TOOL_USE_FAILING_COMMAND],
  ["postToolUseFailure", POST_TOOL_USE_FAILURE_INPUT],
  ["stop", STOP_INPUT],
  ["sessionEnd", SESSION_END_INPUT],
];

describe("the recorded payloads keep parsing", () => {
  test.each(FIXTURES.map(([event, payload]) => [event, payload] as const))(
    "%s fixture parses with zero missing mapped fields",
    (event, payload) => {
      // Act
      const parsed = parseCursorPayload(JSON.stringify(payload));

      // Assert
      expect(parsed).not.toBeNull();
      if (parsed === null) return;
      expect(missingMappedFields(event, parsed)).toEqual([]);
    },
  );

  test("unknown extra fields are ignored, never fatal — tolerance is part of the contract", () => {
    // Arrange: the documented payload plus fields Cursor may add tomorrow.
    const withNoise = {
      ...SESSION_START_INPUT,
      some_future_field: { nested: true },
      another: [1, 2, 3],
    };

    // Act + Assert
    const parsed = parseCursorPayload(JSON.stringify(withNoise));
    expect(parsed).not.toBeNull();
    expect(missingMappedFields("sessionStart", parsed ?? {})).toEqual([]);
  });

  test("wrong-typed optional fields fall back to undefined instead of failing the parse", () => {
    // Arrange: file_path as a number, workspace_roots as a string.
    const wrongTypes = {
      ...AFTER_FILE_EDIT_INPUT,
      file_path: 42,
      workspace_roots: "not-an-array",
    };

    // Act
    const parsed = parseCursorPayload(JSON.stringify(wrongTypes));

    // Assert: parse survives; the dead mapping shows up as MISSING (drift).
    expect(parsed).not.toBeNull();
    expect(missingMappedFields("afterFileEdit", parsed ?? {})).toEqual([
      "file_path",
    ]);
  });
});

describe("the contract-drift tripwire through the REAL runner", () => {
  const driftEnv = async (label: string) => {
    const home = await makeHome(label);
    return {
      home,
      env: {
        CROSSCHECK_HOME: home,
        CROSSCHECK_HUB_URL: "http://127.0.0.1:1",
        CROSSCHECK_API_KEY: "test-key",
      },
    };
  };

  test("a payload missing a mapped field degrades to {} AND counts, naming event and field", async () => {
    // Arrange: the afterFileEdit fixture WITHOUT file_path — the renamed-
    // field future the tripwire exists for.
    const { home, env } = await driftEnv("drift-field");
    const { file_path: _dropped, ...withoutPath } = AFTER_FILE_EDIT_INPUT;

    // Act
    const out = await runCursorHook(
      "afterFileEdit",
      JSON.stringify(withoutPath),
      env,
    );

    // Assert: fail-open output, doctor-visible count.
    expect(out).toBe("{}");
    const drift = await readContractDrift(home);
    expect(drift.total).toBe(1);
    expect(drift.byField["afterFileEdit.file_path"]).toBe(1);
    await rm(home, { recursive: true, force: true });
  });

  test("a missing conversation_id counts on every event", async () => {
    // Arrange
    const { home, env } = await driftEnv("drift-conv");
    const { conversation_id: _dropped, ...withoutConv } = SESSION_START_INPUT;

    // Act
    const out = await runCursorHook(
      "sessionStart",
      JSON.stringify(withoutConv),
      env,
    );

    // Assert
    expect(out).toBe("{}");
    const drift = await readContractDrift(home);
    expect(drift.byField["sessionStart.conversation_id"]).toBe(1);
    await rm(home, { recursive: true, force: true });
  });

  test("afterShellExecution with EMPTY or ABSENT output is ordinary use, never drift", async () => {
    // Arrange: a silent successful command (mkdir, git add) — output empty
    // or omitted. Counting this as drift would WARN on every quiet command
    // and teach people to ignore the tripwire (the cry-wolf failure).
    const { home, env } = await driftEnv("drift-shell-quiet");
    const quiet = { ...AFTER_SHELL_EXECUTION_INPUT, output: "" };
    const { output: _dropped, ...absent } = AFTER_SHELL_EXECUTION_INPUT;

    // Act
    const outQuiet = await runCursorHook(
      "afterShellExecution",
      JSON.stringify(quiet),
      env,
    );
    const outAbsent = await runCursorHook(
      "afterShellExecution",
      JSON.stringify(absent),
      env,
    );

    // Assert: fail-open output, zero drift lines.
    expect(outQuiet).toBe("{}");
    expect(outAbsent).toBe("{}");
    expect((await readContractDrift(home)).total).toBe(0);
    await rm(home, { recursive: true, force: true });
  });

  test("a conversation_id with nothing printable left counts as conversation_id drift", async () => {
    // Arrange: present and non-empty — so the missing-fields gate passes —
    // but nothing survives the shared shape rule: no state file could ever
    // be keyed by it, and silence without a count would be the named death.
    const { home, env } = await driftEnv("drift-unprintable-id");

    // Act
    const out = await runCursorHook(
      "sessionStart",
      JSON.stringify({
        ...SESSION_START_INPUT,
        conversation_id: "\n\u200b\u0000 ",
      }),
      env,
    );

    // Assert
    expect(out).toBe("{}");
    const drift = await readContractDrift(home);
    expect(drift.byField["sessionStart.conversation_id"]).toBe(1);
    await rm(home, { recursive: true, force: true });
  });

  test("non-JSON stdin counts as (unparseable); EMPTY stdin is a human poking, not drift", async () => {
    // Arrange
    const { home, env } = await driftEnv("drift-garbage");

    // Act
    const garbage = await runCursorHook("stop", "this is not json", env);
    const empty = await runCursorHook("stop", "", env);

    // Assert: both fail open; only the garbage counts.
    expect(garbage).toBe("{}");
    expect(empty).toBe("{}");
    const drift = await readContractDrift(home);
    expect(drift.total).toBe(1);
    expect(drift.byField["stop.(unparseable)"]).toBe(1);
    await rm(home, { recursive: true, force: true });
  });

  test("workspace_roots missing WITH the documented CURSOR_PROJECT_DIR backstop is NOT drift", async () => {
    // Arrange: no workspace_roots, but the env variable the docs promise —
    // the payload proceeds to repo resolution (which silently no-ops in a
    // non-repo dir) and no drift is recorded.
    const { home, env } = await driftEnv("drift-envroot");
    const { workspace_roots: _dropped, ...withoutRoots } = SESSION_START_INPUT;

    // Act
    const out = await runCursorHook(
      "sessionStart",
      JSON.stringify(withoutRoots),
      { ...env, CURSOR_PROJECT_DIR: home },
    );

    // Assert
    expect(out).toBe("{}");
    expect((await readContractDrift(home)).total).toBe(0);
    await rm(home, { recursive: true, force: true });
  });
});

describe("the docs excerpt stays in step with the code", () => {
  test("every registered event is named in the excerpt — fixtures cannot drift from provenance", async () => {
    // Arrange
    const excerpt = await Bun.file(
      join(import.meta.dir, "fixtures", "cursor-contract", "docs-excerpt-cursor-hooks.md"),
    ).text();

    // Assert: source + date recorded, all eight events documented.
    expect(excerpt).toContain("https://cursor.com/docs/hooks");
    expect(excerpt).toContain("2026-08-18");
    for (const event of CURSOR_HOOK_EVENTS) {
      expect(excerpt, event).toContain(`### ${event}`);
    }
  });
});
