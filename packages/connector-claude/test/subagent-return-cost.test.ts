/**
 * THE SUBAGENT-RETURN HOOK COSTS NOTHING WHEN THERE IS NOTHING TO RELAY
 * (review of feat/collision-visible, round 2, M2). It fires on the main
 * thread for EVERY Agent/Task call, most of them a background launch with
 * nothing queued, and it ran the runner's full preparation first: four git
 * spawns, a config read and a fired-marker write — a median of 135 ms against
 * a 64 ms bare start (probe subagent-cost). The runner now answers those
 * fires from the payload and one state read: no git, no write. Measured
 * through the real runner and handler in a child that leaves one file per
 * `git` it attempts to spawn (fixtures/count-git-spawns.ts; round 3, F-L8b:
 * the logging `git` on PATH this used to count with missed the spawns a
 * budget race abandoned, so mutations X2 and X5 survived one run in two).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  OVERLAP_FILE,
  SESSION_ID,
  SUBAGENT,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
  forgetRepoIdentities,
  trackForCleanup,
} from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

const CHILD = join(import.meta.dir, "fixtures", "run-real-hook-in-child.ts");

/** Preloaded into the child: one file per `git` it attempts to spawn. */
const GIT_SPAWN_COUNTER = join(import.meta.dir, "fixtures", "count-git-spawns.ts");

/** Every call the test hub has answered, of any kind. */
const hubCallsOf = (calls: object): number =>
  Object.values(calls).reduce<number>((total, count) => total + Number(count), 0);

/** A request timeout no cold child start can spend before the drain. */
const ROOMY_TIMEOUT_MS = "3000";

/** What Claude Code hands PostToolUse for an Agent call, with `tool_response` and extra fields as given. */
const agentFired = (repo: string, toolResponse: Record<string, unknown>, extra: Record<string, string> = {}): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_agent_cost",
    tool_input: { description: "d", prompt: "p", subagent_type: "general-purpose" },
    tool_response: toolResponse,
    ...extra,
  });

/** A fresh directory the child's spawn counter writes one file per `git` attempt into. */
const spawnLogDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-git-spawns-"));
  trackForCleanup(dir);
  return dir;
};

/** Every file under `root` with its mtime and size: what a write would change. */
const snapshot = async (root: string): Promise<Readonly<Record<string, string>>> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  const stats = await Promise.all(files.map(async (path) => [relative(root, path), await stat(path)] as const));
  return Object.fromEntries(stats.map(([path, info]) => [path, `${String(info.mtimeMs)}:${String(info.size)}`]));
};

/** The hook through the real runner in a child that counts its git spawns; its stdout and the git calls it attempted. */
const runInChild = async (stdin: string, env: Env): Promise<{ readonly output: string; readonly gitCalls: number }> => {
  const logDir = await spawnLogDir();
  const child = Bun.spawn({
    cmd: [process.execPath, "--preload", GIT_SPAWN_COUNTER, CHILD, "subagent-return", stdin, JSON.stringify(env)],
    env: { ...process.env, CX_GIT_SPAWN_LOG_DIR: logDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) {
    throw new Error(`the hook child failed: ${await new Response(child.stderr).text()}`);
  }
  const calls = (await readdir(logDir)).filter((name) => name.endsWith(".call"));
  return { output, gitCalls: calls.length };
};

describe("a subagent-return fire with nothing to relay spawns no git and writes nothing (round 2, M2)", () => {
  test("an empty queue on a completed return: no git, no write, no hub call", async () => {
    // Arrange
    const fix = await collisionFixture("sc-empty");
    const before = await snapshot(fix.home);
    const hubBefore = hubCallsOf(fix.hub.calls);

    // Act
    const { output, gitCalls } = await runInChild(agentFired(fix.repo, { status: "completed" }), fix.env);

    // Assert
    expect(output).toBe("");
    expect(gitCalls).toBe(0);
    expect(await snapshot(fix.home)).toEqual(before);
    expect(hubCallsOf(fix.hub.calls)).toBe(hubBefore);
  });

  test("a background LAUNCH, even with a relay queued, leaves the queue for the prompt it reports back on", async () => {
    // Arrange: a subagent's hit is queued
    const fix = await collisionFixture("sc-launch");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    const before = await snapshot(fix.home);

    // Act
    const { output, gitCalls } = await runInChild(agentFired(fix.repo, { status: "async_launched", agentId: "a1" }), fix.env);

    // Assert
    expect(output).toBe("");
    expect(gitCalls).toBe(0);
    expect(await snapshot(fix.home)).toEqual(before);
  });

  test("a nested subagent's own return, with a relay queued", async () => {
    // Arrange
    const fix = await collisionFixture("sc-nested");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    const before = await snapshot(fix.home);

    // Act
    const { output, gitCalls } = await runInChild(agentFired(fix.repo, { status: "completed" }, SUBAGENT), fix.env);

    // Assert
    expect(output).toBe("");
    expect(gitCalls).toBe(0);
    expect(await snapshot(fix.home)).toEqual(before);
  });

  test("with a relay queued, a completed return still drains it — the full hook runs", async () => {
    // Arrange: the identity the subagent's edit cached is forgotten, so the
    // full hook resolves its repo with git and the counter has git to see
    const fix = await collisionFixture("sc-drain");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await forgetRepoIdentities(fix.home);

    // Act: a roomy timeout, so a cold child's git spawns cannot spend the
    // spare the drain is made in (that bound is pinned in-process elsewhere)
    const { output, gitCalls } = await runInChild(agentFired(fix.repo, { status: "completed" }), {
      ...fix.env,
      CROSSCHECK_TIMEOUT_MS: ROOMY_TIMEOUT_MS,
    });

    // Assert
    expect(output).toContain("refresh.ts");
    expect(gitCalls).toBeGreaterThan(0);
  });
});
