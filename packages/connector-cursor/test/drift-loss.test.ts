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
import { AFTER_FILE_EDIT_INPUT } from "./fixtures/cursor-contract/payloads.ts";
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

describe("LOSS-13: host contract drift reaches the loss ledger", () => {
  test("an afterFileEdit with no file_path appends host_contract_drift, unkeyed, naming the event", async () => {
    // Arrange
    const { home, env } = await homeEnv("drift-loss-field");
    const { file_path: _dropped, ...withoutPath } = AFTER_FILE_EDIT_INPUT;

    // Act
    const out = await runCursorHook("afterFileEdit", JSON.stringify(withoutPath), env);

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
    // Arrange
    const { home, env } = await homeEnv("drift-loss-garbage");

    // Act
    await runCursorHook("stop", "this is not json", env);

    // Assert
    const losses = await readCaptureLosses(home, "any-repo-key");
    expect(losses.byDetail["host_contract_drift:stop"]).toBe(1);
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
