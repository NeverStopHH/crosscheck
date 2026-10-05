/**
 * LOSS-13, Cursor half, and LOSS-12 on the Cursor runner
 * (docs/1.0/loss-accounting.md §3 rows 14 and 19).
 *
 * A payload missing a field capture needs used to reach the drift ledger
 * (src/drift.ts) and nothing else: doctor could say "Cursor renamed
 * something", and the hub's coverage still read `complete` over the edit
 * that was never captured. The drift is now ALSO a capture loss, unkeyed —
 * drift is counted before repo resolution, so the payload's repo is unknown,
 * and an unknown repo is charged to every repo (§4.3). The cursor-hook
 * process runs under the same budget race as Claude's, so an abandoned
 * handler is booked the same way.
 *
 * Driven through the REAL runner, like contract.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { runCursorHook } from "../src/index.ts";
import { runCursorHookWith } from "../src/runner.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  lossLedgerPath,
  readCaptureLosses,
} from "@crosscheck/connector-core/state/loss-ledger.ts";
import {
  deriveSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { cursorHostSessionKey } from "@crosscheck/connector-core/state/host-session-key.ts";
import {
  AFTER_FILE_EDIT_INPUT,
  BEFORE_SUBMIT_PROMPT_INPUT,
} from "./fixtures/cursor-contract/payloads.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const DEAD_HUB_URL = "http://127.0.0.1:1";
/**
 * afterFileEdit's budget is POST_TOOL_USE_BUDGET_RATIO (4) × this: one
 * second, so repo identity resolves and the HANDLER is what the budget cuts.
 */
const RESOLVING_TIMEOUT_MS = "250";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const homeEnv = async (label: string): Promise<{ readonly home: string; readonly env: Env }> => {
  const home = await makeHome(label);
  paths.push(home);
  return {
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: DEAD_HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

const ledgerLines = async (home: string): Promise<readonly Record<string, unknown>[]> => {
  const raw = await Bun.file(lossLedgerPath(home)).text();
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const connectedRepo = async (label: string): Promise<string> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  paths.push(repo);
  return repo;
};

describe("LOSS-13: host contract drift reaches the loss ledger", () => {
  test("an afterFileEdit with no file_path appends host_contract_drift, unkeyed, naming the event", async () => {
    // Arrange: a workspace inside a repo this machine reports for
    const { home, env } = await homeEnv("drift-loss-field");
    const repo = await connectedRepo("drift-loss-field-repo");
    const { file_path: _dropped, ...withoutPath } = AFTER_FILE_EDIT_INPUT;

    // Act
    const out = await runCursorHook(
      "afterFileEdit",
      JSON.stringify({ ...withoutPath, workspace_roots: [repo] }),
      env,
    );

    // Assert: fail-open output, and a loss every repo on this machine is charged with
    expect(out).toBe("{}");
    const [line] = await ledgerLines(home);
    expect(line?.["kind"]).toBe("host_contract_drift");
    expect(line?.["key"]).toBeNull();
    expect(line?.["detail"]).toBe("afterFileEdit");
    const losses = await readCaptureLosses(home, repoKey(DEAD_HUB_URL, REPO_ID));
    expect(losses.byKind["host_contract_drift"]).toBe(1);
  });

  test("non-JSON stdin on a registered hook is the same loss", async () => {
    // Arrange: the documented CURSOR_PROJECT_DIR is the one place left to look
    const { home, env } = await homeEnv("drift-loss-garbage");
    const repo = await connectedRepo("drift-loss-garbage-repo");

    // Act
    await runCursorHook("stop", "this is not json", { ...env, CURSOR_PROJECT_DIR: repo });

    // Assert
    const losses = await readCaptureLosses(home, "any-repo-key");
    expect(losses.byDetail["host_contract_drift:stop"]).toBe(1);
  });

  test("review M4: a drifted payload from a folder no connected repo owns books no loss", async () => {
    // Arrange: a folderless-looking workspace — a plain directory, no .git above
    const { home, env } = await homeEnv("drift-loss-unconnected");
    const { file_path: _dropped, ...withoutPath } = AFTER_FILE_EDIT_INPUT;

    // Act
    await runCursorHook("afterFileEdit", JSON.stringify({ ...withoutPath, workspace_roots: [home] }), env);

    // Assert: the drift ledger still says Cursor renamed something; no repo is charged
    expect(await Bun.file(lossLedgerPath(home)).exists()).toBe(false);
  });

  test("review M4: a drifted payload in a registered conversation is keyed to its repo", async () => {
    // Arrange: the state the conversation's earlier hooks wrote
    const { home, env } = await homeEnv("drift-loss-state");
    const repo = await connectedRepo("drift-loss-state-repo");
    await writeSessionState(
      home,
      deriveSessionState({
        hostSessionKey: cursorHostSessionKey(AFTER_FILE_EDIT_INPUT.conversation_id),
        repoId: REPO_ID,
        repoRoot: repo,
        hubUrl: DEAD_HUB_URL,
        developerId: null,
        startedAt: new Date().toISOString(),
      }),
    );
    const { file_path: _dropped, ...withoutPath } = AFTER_FILE_EDIT_INPUT;

    // Act
    await runCursorHook("afterFileEdit", JSON.stringify(withoutPath), env);

    // Assert
    const [line] = await ledgerLines(home);
    expect(line?.["key"]).toBe(repoKey(DEAD_HUB_URL, REPO_ID));
  });

  test("a payload that drifts nothing books nothing", async () => {
    // Arrange: the documented payload, in a workspace that is no repo at all
    const { home, env } = await homeEnv("drift-loss-clean");

    // Act
    await runCursorHook(
      "afterFileEdit",
      JSON.stringify({ ...AFTER_FILE_EDIT_INPUT, workspace_roots: [home] }),
      env,
    );

    // Assert
    expect((await readCaptureLosses(home, "any-repo-key")).total).toBe(0);
  });
});

describe("LOSS-12 on the Cursor runner: an abandoned handler is a counted loss", () => {
  test("review M4: beforeSubmitPrompt timing out books nothing — it derives, it does not capture", async () => {
    // Arrange
    const repo = await connectedRepo("cursor-timeout-prompt");
    const { home, env } = await homeEnv("cursor-timeout-prompt");

    // Act
    await runCursorHookWith(
      "beforeSubmitPrompt",
      () => new Promise<string>(() => {}),
      JSON.stringify({ ...BEFORE_SUBMIT_PROMPT_INPUT, workspace_roots: [repo] }),
      { ...env, CROSSCHECK_TIMEOUT_MS: RESOLVING_TIMEOUT_MS, CROSSCHECK_SSH_CANONICALIZE: "off" },
    );

    // Assert
    expect(await Bun.file(lossLedgerPath(home)).exists()).toBe(false);
  });

  test("an afterFileEdit whose handler outlives its budget appends hook_timed_out under its repo", async () => {
    // Arrange
    const repo = await makeRepo("cursor-timeout", { remote: "git@github.com:acme/api.git" });
    paths.push(repo);
    const { home, env } = await homeEnv("cursor-timeout");
    const payload = {
      ...AFTER_FILE_EDIT_INPUT,
      workspace_roots: [repo],
      file_path: join(repo, "src/rate-limit.ts"),
    };

    // Act
    const out = await runCursorHookWith(
      "afterFileEdit",
      () => new Promise<string>(() => {}),
      JSON.stringify(payload),
      { ...env, CROSSCHECK_TIMEOUT_MS: RESOLVING_TIMEOUT_MS, CROSSCHECK_SSH_CANONICALIZE: "off" },
    );

    // Assert
    expect(out).toBe("{}");
    const [line] = await ledgerLines(home);
    expect(line?.["kind"]).toBe("hook_timed_out");
    expect(line?.["detail"]).toBe("afterFileEdit");
    expect(line?.["key"]).toBe(repoKey(DEAD_HUB_URL, REPO_ID));
  });
});
