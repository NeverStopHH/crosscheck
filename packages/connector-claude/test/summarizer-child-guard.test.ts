/**
 * Hooks inside the summarizer's OWN nested claude (trial finding #14). The
 * nested `claude -p` ran crosscheck's globally installed hooks: one plain run
 * from a connected repo minted 3 new session-state files and hub sessions,
 * and its Stop hook could have fired the summarizer again — recursion with a
 * fresh 6-fire cap per phantom session. The lean argv keeps hooks out of that
 * process; the child marker is the guard that does not depend on flags:
 * EVERY hook entry returns silence under it — no stdout, no hub request, no
 * state file, no spool line, no turn counted — through the real dispatcher.
 *
 * The marker's spelling is operator-visible (the env of a stuck process), so
 * it is spelled out rather than imported: this file must run — and go red —
 * against a tree that does not know it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHook } from "../src/index.ts";
import type { Env, HookName } from "../src/index.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";
import { startSlowHub } from "./fixtures/slow-hub.ts";
import type { MockHub } from "./fixtures/slow-hub.ts";

const CHILD_MARKER = "CROSSCHECK_SUMMARIZER_CHILD";
const REPO_ID = "github.com/acme/api";
const SESSION_ID = "child-guard-session-uuid";

const paths: string[] = [];
const hubs: MockHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

const transcriptLine = (type: string, blocks: unknown[]): string =>
  `${JSON.stringify({ type, message: { role: type, content: blocks } })}\n`;

/** A turn that WOULD fire the gate — so a counted Stop is visible. */
const diagnosisTranscript = (): string =>
  transcriptLine("user", [{ type: "text", text: "why is bun test red" }]) +
  transcriptLine("assistant", [
    { type: "tool_use", name: "Bash", input: { command: "bun test packages/api" } },
  ]) +
  transcriptLine("user", [
    { type: "tool_result", content: "1 fail — TypeError: cursor is undefined" },
  ]) +
  transcriptLine("assistant", [
    { type: "text", text: "The root cause is the stale cursor id" },
  ]);

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly hub: MockHub;
  readonly transcript: string;
  readonly file: string;
  readonly env: Env;
}

const fixture = async (label: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const file = await writeRepoFile(repo, "src/limiter.ts", "export const a = 1;\n");
  const dir = await mkdtemp(join(tmpdir(), "cx-child-guard-"));
  paths.push(dir);
  const transcript = join(dir, "transcript.jsonl");
  await writeFile(transcript, diagnosisTranscript(), "utf8");
  const hub = startSlowHub({ ingest: 0, end: 0, other: 0 });
  hubs.push(hub);
  return {
    repo,
    home,
    hub,
    transcript,
    file,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: "2000",
      CROSSCHECK_SUMMARIZER_CMD: "/nonexistent/never-spawned",
    },
  };
};

const totalCalls = (hub: MockHub): number =>
  Object.values(hub.calls).reduce((sum, count) => sum + count, 0);

const payloadFor = (fix: Fixture, name: HookName): string => {
  const base = { session_id: SESSION_ID, cwd: fix.repo };
  const byName: Record<HookName, Record<string, unknown>> = {
    "session-start": { ...base, hook_event_name: "SessionStart", source: "startup" },
    "user-prompt-submit": {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt: "why does the refresh call fail after key rotation",
    },
    "pre-tool-use": {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: fix.file },
    },
    "post-tool-use": {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: fix.file },
      tool_response: {},
    },
    stop: {
      ...base,
      hook_event_name: "Stop",
      transcript_path: fix.transcript,
      stop_hook_active: false,
    },
    "session-end": { ...base, hook_event_name: "SessionEnd", reason: "exit" },
  };
  return JSON.stringify(byName[name]);
};

const seedState = async (fix: Fixture): Promise<string> => {
  await writeSessionState(fix.home, {
    hostSessionKey: SESSION_ID,
    crosscheckSessionId: `cc_${SESSION_ID}`,
    workContextId: `wc_cc_${SESSION_ID}`,
    repoId: REPO_ID,
    repoRoot: fix.repo,
    hubUrl: fix.hub.url,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
  });
  return JSON.stringify(await readSessionState(fix.home, SESSION_ID));
};

const childEnv = (fix: Fixture): Env => ({ ...fix.env, [CHILD_MARKER]: "1" });

describe("hooks under the summarizer child marker: silence, no hub, no disk", () => {
  // These two REGISTER on a fresh session without the marker (SessionStart
  // directly, PostToolUse through its state-less recovery) — the loudest
  // hooks, so the silence is the strongest claim.
  test.each(["session-start", "post-tool-use"] as const)(
    "%s on a fresh session: no output, zero hub requests, nothing under the home",
    async (name) => {
      // Arrange
      const fix = await fixture(`fresh-${name}`);

      // Act
      const stdout = await runHook(name, payloadFor(fix, name), childEnv(fix));

      // Assert
      expect(stdout).toBe("");
      expect(totalCalls(fix.hub)).toBe(0);
      expect(await readdir(fix.home)).toEqual([]);
    },
  );

  // These four do their work only on a REGISTERED session (hints, tripwire,
  // turn count + fire, end + delete): the state is seeded so that each would
  // act without the marker, and must leave it byte-identical with it.
  test.each(["user-prompt-submit", "pre-tool-use", "stop", "session-end"] as const)(
    "%s on a registered session: no output, zero hub requests, state untouched, no spool",
    async (name) => {
      // Arrange
      const fix = await fixture(`registered-${name}`);
      const before = await seedState(fix);

      // Act
      const stdout = await runHook(name, payloadFor(fix, name), childEnv(fix));

      // Assert
      expect(stdout).toBe("");
      expect(totalCalls(fix.hub)).toBe(0);
      expect(JSON.stringify(await readSessionState(fix.home, SESSION_ID))).toBe(before);
      expect(await readdir(fix.home)).toEqual(["sessions"]);
    },
  );

  test("the Stop hook counts no turn and spends no fire slot under the marker", async () => {
    // Arrange: a diagnosis turn that fires the gate on an ordinary Stop
    const fix = await fixture("stop-no-turn");
    await seedState(fix);

    // Act
    await runHook("stop", payloadFor(fix, "stop"), childEnv(fix));

    // Assert
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.stopTurnCount).toBe(0);
    expect(state?.summarizerFireCount).toBe(0);
  });

  test("positive control: without the marker the same SessionStart registers and writes state", async () => {
    // Arrange
    const fix = await fixture("control");

    // Act
    await runHook("session-start", payloadFor(fix, "session-start"), fix.env);

    // Assert: the hub saw the register, the home has the session file —
    // the exact two things the marker suppresses above.
    expect(fix.hub.calls.register).toBeGreaterThanOrEqual(1);
    expect(await readSessionState(fix.home, SESSION_ID)).not.toBeNull();
  });

  test('only the value "1" is the marker — any other value is an ordinary hook', async () => {
    const fix = await fixture("marker-value");

    await runHook(
      "session-start",
      payloadFor(fix, "session-start"),
      { ...fix.env, [CHILD_MARKER]: "0" },
    );

    expect(fix.hub.calls.register).toBeGreaterThanOrEqual(1);
  });
});
