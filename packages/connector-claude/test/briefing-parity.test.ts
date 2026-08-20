/**
 * Briefing parity for LATE registrations (trial finding #9's follow-through):
 * a session that registers through PostToolUse's recovery — the parent-
 * workspace shape, where SessionStart had no file to derive a repo from and
 * exited silent — used to lose its briefing entirely: the briefing rendered
 * ONLY in session-start.ts, and no later hook ever owed one.
 *
 * The ACP connector's house pattern closes the gap (inject/injector.ts: "the
 * cached briefing on the first prompt it is ready for, the hint flow
 * afterwards"): after a late registration, the NEXT UserPromptSubmit delivers
 * the briefing — exactly once, outranking the hint for that one prompt, and
 * through the same core `assembleBriefing` flow and renderers SessionStart
 * uses, so nothing a parent-workspace session sees is assembled by different
 * code than a normal session's.
 *
 * Everything here drives the real hook entry point; only the hub is canned.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";
import { CANDIDATE_BODY } from "../../connector-core/test/fixtures/hint-hub.ts";
import { startParityHub } from "../../connector-core/test/fixtures/parity-hub.ts";
import type { ParityHub } from "../../connector-core/test/fixtures/parity-hub.ts";

const REMOTE = "git@github.com:acme/api.git";
const SESSION_ID = "late-uuid";
const PROMPT = "why does src/auth/refresh.ts still 500 after the key rotation";
/** The one line only the BRIEFING renderer opens its presence section with. */
const BRIEFING_HEADER = "Teammate sessions active now:";
const TEAMMATE_NAME = "Mona";

const paths: string[] = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly hub: ParityHub;
  readonly env: Env;
}

const fixture = async (label: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: REMOTE });
  const home = await makeHome(label);
  paths.push(repo, home);
  // The shared two-surface hub (connector-core/test/fixtures/parity-hub.ts)
  // — the cursor deferred-briefing suite drives the identical canned answers.
  const hub = startParityHub(TEAMMATE_NAME);
  stops.push(hub.stop);
  // What `crosscheck init` commits: the trust anchor the file-derived
  // registration path (runner.ts rung 2) demands before it will register.
  await writeRepoFile(repo, ".crosscheck.json", renderRepoConfig(hub.url));
  return {
    repo,
    home,
    hub,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

const postToolUsePayload = (cwd: string, filePath: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: filePath },
    tool_response: {},
  });

const promptPayload = (cwd: string, prompt: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd,
    hook_event_name: "UserPromptSubmit",
    prompt,
  });

interface HookOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName?: string;
    readonly additionalContext?: string;
  };
}

const contextOf = (stdout: string): string => {
  if (stdout.length === 0) {
    return "";
  }
  const parsed = JSON.parse(stdout) as HookOutput;
  return parsed.hookSpecificOutput?.additionalContext ?? "";
};

/** The Ken shape: registration arrives through PostToolUse's recovery. */
const registerLate = async (fixed: Fixture, cwd: string): Promise<void> => {
  const file = await writeRepoFile(fixed.repo, "src/auth/token.ts", "export const a = 1;\n");
  const stdout = await runHook("post-tool-use", postToolUsePayload(cwd, file), fixed.env);
  expect(stdout).toBe("");
  const state = await readSessionState(fixed.home, SESSION_ID);
  if (state === null) {
    throw new Error("recovery did not publish session state");
  }
};

describe("a session that registered late, through PostToolUse recovery", () => {
  test("the next prompt carries the briefing and outranks the hint", async () => {
    // Arrange: recovery-registered session; the hub offers BOTH a presence
    // briefing and an injectable hint candidate for this very prompt.
    const fixed = await fixture("parity-deliver");
    await registerLate(fixed, fixed.repo);

    // Act
    const stdout = await runHook(
      "user-prompt-submit",
      promptPayload(fixed.repo, PROMPT),
      fixed.env,
    );

    // Assert — the briefing, through the core renderer
    const context = contextOf(stdout);
    expect(context).toContain(BRIEFING_HEADER);
    expect(context).toContain(TEAMMATE_NAME);
    // — and NOT the hint: precedence is pinned, one injection per prompt,
    // the hint flow was never even asked for candidates.
    expect(context).not.toContain(CANDIDATE_BODY);
    expect(fixed.hub.calls.candidates).toBe(0);
    // — the debt is spent
    const state = await readSessionState(fixed.home, SESSION_ID);
    expect(state?.briefingPending).toBe(false);
  });

  test("the briefing arrives exactly once — the second prompt gets the hint", async () => {
    // Arrange
    const fixed = await fixture("parity-once");
    await registerLate(fixed, fixed.repo);
    const first = await runHook(
      "user-prompt-submit",
      promptPayload(fixed.repo, PROMPT),
      fixed.env,
    );
    expect(contextOf(first)).toContain(BRIEFING_HEADER);

    // Act: the SAME session prompts again
    const second = await runHook(
      "user-prompt-submit",
      promptPayload(fixed.repo, PROMPT),
      fixed.env,
    );

    // Assert: no second briefing — the hint path is back in charge
    const context = contextOf(second);
    expect(context).not.toContain(BRIEFING_HEADER);
    expect(context).toContain(CANDIDATE_BODY);
    expect(fixed.hub.calls.candidates).toBe(1);
  });

  test("a prompt whose cwd resolves to NO repo delivers through the session's own state", async () => {
    // Arrange: the full Ken shape — cwd is the PARENT workspace for every
    // hook, so cwd resolution finds nothing and the prompt has no file paths
    // to derive from. The session's own state file is the only road home.
    const workspace = await mkdtemp(join(tmpdir(), "cx-parity-workspace-"));
    paths.push(workspace);
    const fixed = await fixture("parity-workspace");
    await registerLate(fixed, workspace);

    // Act
    const stdout = await runHook(
      "user-prompt-submit",
      promptPayload(workspace, PROMPT),
      fixed.env,
    );

    // Assert: the briefing arrives anyway — nothing lost to the workspace shape
    const context = contextOf(stdout);
    expect(context).toContain(BRIEFING_HEADER);
    expect(context).toContain(TEAMMATE_NAME);
  });

  test("a SessionStart-registered session owes no next-prompt briefing", async () => {
    // Arrange: the NORMAL path — SessionStart delivered the briefing in-hook.
    const fixed = await fixture("parity-normal");
    const startStdout = await runHook(
      "session-start",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fixed.repo,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      fixed.env,
    );
    expect(contextOf(startStdout)).toContain(BRIEFING_HEADER);

    // Act
    const stdout = await runHook(
      "user-prompt-submit",
      promptPayload(fixed.repo, PROMPT),
      fixed.env,
    );

    // Assert: the prompt path is the hint path, exactly as before
    const context = contextOf(stdout);
    expect(context).not.toContain(BRIEFING_HEADER);
    expect(context).toContain(CANDIDATE_BODY);
  });
});
