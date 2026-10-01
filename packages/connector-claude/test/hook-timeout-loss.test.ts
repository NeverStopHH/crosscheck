/**
 * LOSS-12, first half (docs/1.0/loss-accounting.md §3 row 14, §4.3): a hook
 * that runs out of budget is a COUNTED loss, keyed when it can be.
 *
 * The race used to resolve to "" and the binary exited on that string
 * (cli/src/bin/crosscheck.ts emitAndExit), abandoning whatever the handler had
 * not yet written — PostToolUse's targets, Stop's git lane — with nothing
 * counted anywhere. Driven through the REAL runner (`runHookWith`), with a
 * handler that never settles, so the only thing that can end the hook is the
 * budget itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { repoKey } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { runHookWith } from "../src/hooks/runner.ts";
import {
  lossLedgerPath,
  readCaptureLosses,
} from "@crosscheck/connector-core/state/loss-ledger.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:1";
/**
 * PostToolUse's budget is POST_TOOL_USE_BUDGET_RATIO (4) × this: one second,
 * room enough for repo identity to resolve under a loaded machine, so the
 * handler — not the git spawns before it — is what the budget cuts.
 */
const RESOLVING_TIMEOUT_MS = "250";
/**
 * 4 ms of budget: less than one git spawn, and repo identity spawns several
 * (hooks/runner.ts prepareHook), so the race resolves BEFORE the hook knows
 * its repo — the unkeyed shape of the same loss.
 */
const UNRESOLVED_TIMEOUT_MS = "1";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const fixture = async (
  label: string,
  timeoutMs: string,
): Promise<{ readonly repo: string; readonly home: string; readonly env: Env }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: timeoutMs,
      CROSSCHECK_SSH_CANONICALIZE: "off",
    },
  };
};

const editPayload = (repo: string): string =>
  JSON.stringify({
    session_id: "timeout-loss-uuid",
    cwd: repo,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: join(repo, "src/limiter.ts") },
    tool_response: {},
  });

const neverSettles = (): Promise<string> => new Promise<string>(() => {});

const ledgerLines = async (home: string): Promise<readonly Record<string, unknown>[]> => {
  const raw = await Bun.file(lossLedgerPath(home)).text();
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("LOSS-12: a hook that runs out of budget is a counted loss, keyed when it can be", () => {
  test("a PostToolUse whose handler outlives its budget appends hook_timed_out under its repo", async () => {
    // Arrange
    const { repo, home, env } = await fixture("timeout-keyed", RESOLVING_TIMEOUT_MS);
    const key = repoKey(HUB_URL, REPO_ID);

    // Act
    const output = await runHookWith("post-tool-use", neverSettles, editPayload(repo), env);

    // Assert: still the silent no-op on the wire, and now a ledger line
    expect(output).toBe("");
    const losses = await readCaptureLosses(home, key);
    expect(losses.byKind["hook_timed_out"]).toBe(1);
    expect(losses.byDetail["hook_timed_out:post-tool-use"]).toBe(1);
    const [line] = await ledgerLines(home);
    expect(line?.["key"]).toBe(key);
  });

  test("a hook the budget cut before its repo resolved is booked with no key, charged to every repo", async () => {
    // Arrange
    const { repo, home, env } = await fixture("timeout-unkeyed", UNRESOLVED_TIMEOUT_MS);

    // Act
    await runHookWith("post-tool-use", neverSettles, editPayload(repo), env);

    // Assert
    const [line] = await ledgerLines(home);
    expect(line?.["kind"]).toBe("hook_timed_out");
    expect(line?.["key"]).toBeNull();
    expect((await readCaptureLosses(home, "any-other-repo-key")).total).toBe(1);
  });

  test("a hook that finishes inside its budget books nothing", async () => {
    // Arrange
    const { repo, home, env } = await fixture("timeout-none", RESOLVING_TIMEOUT_MS);

    // Act
    const output = await runHookWith(
      "post-tool-use",
      () => Promise.resolve("done"),
      editPayload(repo),
      env,
    );

    // Assert
    expect(output).toBe("done");
    expect((await readCaptureLosses(home, repoKey(HUB_URL, REPO_ID))).total).toBe(0);
  });
});
