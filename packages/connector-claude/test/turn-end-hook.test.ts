/**
 * A TEAMMATE WHO STARTS ON A RESTING FILE IS TOLD WHEN THE TURN ENDS (review
 * of feat/collision-visible, round 3, F-M2). Within TRIPWIRE_RECHECK_TTL_MS
 * of an answer fully dealt with, an edit of the file asks the hub nothing
 * (round 2, L1) — and probe r3d D1 showed what that cost: two edits settle
 * refresh.ts, Ken starts on it, four more edits inside the window make 0
 * tripwire calls, the turn moves on, and Ken is never surfaced. The sync
 * Stop hook `turn-end` asks again, once per resting file, for at most
 * TURN_END_RECHECK_MAX_FILES of them, and tells the person before the turn
 * is over. A turn with nothing resting costs one state read: no git, no hub,
 * no write.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { prepareHook } from "../src/hooks/runner.ts";
import { handleTurnEnd } from "../src/hooks/turn-end.ts";
import { sessionStatePath } from "@crosscheck/connector-core/config/paths.ts";
import { TURN_END_RECHECK_MAX_FILES } from "@crosscheck/connector-core/constants.ts";
import { readSessionState, updateSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { activeTeammateSession } from "../../connector-core/test/fixtures/hint-hub.ts";
import {
  BEHAVIOUR_TIMING,
  OVERLAP_FILE,
  SESSION_ID,
  SUBAGENT,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
  forgetRepoIdentities,
  kenSession,
  parsed,
  pastRecheckWindow,
  promptPayload,
  trackForCleanup,
} from "./fixtures/collision-fixture.ts";
import type { CollisionFixture } from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

const KEN_NOTICE =
  "crosscheck: Ken is working on refresh.ts on branch feat/ken-rotation (last active just now) — " +
  "talk before you both change it";

/** Edits of the settled file that land inside its rest. */
const EDITS_INSIDE_WINDOW = 4;

const turnEnded = (repo: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: SESSION_ID, cwd: repo, hook_event_name: "Stop", stop_hook_active: false, ...extra });

const stateText = async (home: string): Promise<string> => Bun.file(sessionStatePath(home, SESSION_ID)).text();

/** A session whose subagent settled refresh.ts with Nick on it: asked about, told, resting. */
const settledFixture = async (label: string): Promise<CollisionFixture> => {
  const fix = await collisionFixture(label, BEHAVIOUR_TIMING);
  await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
  await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
  const state = await readSessionState(fix.home, SESSION_ID);
  expect((state?.tripwireCheckedFiles ?? []).map((check) => check.file)).toEqual([OVERLAP_FILE]);
  return fix;
};

describe("the turn's end asks again about the files still resting (round 3, F-M2)", () => {
  test("Ken starts on a resting file and every later edit lands inside the window: the turn's end tells the person (probe r3d D1)", async () => {
    // Arrange: Ken joins; the rest of the burst asks the hub nothing
    const fix = await settledFixture("te-d1");
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    const before = fix.hub.calls.tripwire;
    const inside = [];
    for (let edit = 0; edit < EDITS_INSIDE_WINDOW; edit += 1) {
      inside.push(parsed(await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env)));
    }

    // Act
    const ended = parsed(await runHook("turn-end", turnEnded(fix.repo), fix.env));

    // Assert: silent inside the window, told at the turn's end, Nick not told twice
    expect(inside.map((output) => output.systemMessage)).toEqual(Array.from({ length: EDITS_INSIDE_WINDOW }, () => undefined));
    expect(ended.systemMessage).toBe(KEN_NOTICE);
    expect(fix.hub.calls.tripwire).toBe(before + 1);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect((state?.collisionNotices ?? []).map((group) => group.name).sort()).toEqual(["Ken", "Nick"]);
  });

  test("the file stops resting, so its next edit asks the agent about Ken too", async () => {
    // Arrange
    const fix = await settledFixture("te-unrest");
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    await runHook("turn-end", turnEnded(fix.repo), fix.env);

    // Act: the main thread edits the file in the next turn, still inside the old window
    const next = parsed(await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env));

    // Assert: asked about Ken, and the person is not told of him a second time
    expect(next.hookSpecificOutput?.permissionDecisionReason).toContain("Ken has an active session");
    expect(next.systemMessage).toBeUndefined();
  });

  test("a resting file whose teammates were all told and asked: one call, nothing told, and the debt is paid", async () => {
    // Arrange: nobody new on the file
    const fix = await settledFixture("te-nothing-new");
    const before = fix.hub.calls.tripwire;

    // Act
    const ended = await runHook("turn-end", turnEnded(fix.repo), fix.env);
    await pastRecheckWindow(fix.home);
    await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env);

    // Assert: told nothing, and owed nothing — the next prompt, past the rest, asks no tripwire again
    expect(ended).toBe("");
    expect(fix.hub.calls.tripwire).toBe(before + 1);
    expect((await readSessionState(fix.home, SESSION_ID))?.tripwireCheckedFiles).toEqual([]);
  });

  test("at most TURN_END_RECHECK_MAX_FILES resting files are asked about", async () => {
    // Arrange: five files resting, all settled a moment ago
    const fix = await collisionFixture("te-cap", BEHAVIOUR_TIMING);
    const at = new Date(Date.now() - 1_000).toISOString();
    await updateSessionState(fix.home, SESSION_ID, (fresh) => ({
      ...fresh,
      tripwireCheckedFiles: Array.from({ length: TURN_END_RECHECK_MAX_FILES + 2 }, (_, index) => ({
        file: `src/f${String(index)}.ts`,
        at,
      })),
    }));
    fix.hub.setTripwireSessions([]);

    // Act
    await runHook("turn-end", turnEnded(fix.repo), fix.env);

    // Assert
    expect(fix.hub.calls.tripwire).toBe(TURN_END_RECHECK_MAX_FILES);
  });

  test("a rest that ended before the turn did is still owed, and the turn's end pays it", async () => {
    // Arrange: the file settled longer ago than the window, and Ken joined inside it
    const fix = await settledFixture("te-expired");
    await pastRecheckWindow(fix.home);
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    const before = fix.hub.calls.tripwire;

    // Act
    const ended = parsed(await runHook("turn-end", turnEnded(fix.repo), fix.env));

    // Assert
    expect(ended.systemMessage).toBe(KEN_NOTICE);
    expect(fix.hub.calls.tripwire).toBe(before + 1);
  });

  test("a Stop another stop hook forced is the same turn seen twice: nothing asked", async () => {
    // Arrange
    const fix = await settledFixture("te-forced");
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    const before = fix.hub.calls.tripwire;

    // Act
    const ended = await runHook("turn-end", turnEnded(fix.repo, { stop_hook_active: true }), fix.env);

    // Assert
    expect(ended).toBe("");
    expect(fix.hub.calls.tripwire).toBe(before);
  });

  test("with nothing to spare, the turn's end makes no call at all", async () => {
    // Arrange
    const fix = await settledFixture("te-spent");
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    const before = fix.hub.calls.tripwire;
    const ctx = await prepareHook(turnEnded(fix.repo), fix.env);

    // Act
    const ended = ctx === null ? "no context" : await handleTurnEnd(ctx, { spareMs: () => 0 });

    // Assert
    expect(ended).toBe("");
    expect(fix.hub.calls.tripwire).toBe(before);
  });
});

const CHILD = join(import.meta.dir, "fixtures", "run-real-hook-in-child.ts");
const GIT_SPAWN_COUNTER = join(import.meta.dir, "fixtures", "count-git-spawns.ts");

/** The hook through the real runner in a child that counts its git spawns. */
const runInChild = async (stdin: string, env: Env): Promise<{ readonly output: string; readonly gitCalls: number }> => {
  const logDir = await mkdtemp(join(tmpdir(), "cx-git-spawns-"));
  trackForCleanup(logDir);
  const child = Bun.spawn({
    cmd: [process.execPath, "--preload", GIT_SPAWN_COUNTER, CHILD, "turn-end", stdin, JSON.stringify(env)],
    env: { ...process.env, CX_GIT_SPAWN_LOG_DIR: logDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) {
    throw new Error(`the hook child failed: ${await new Response(child.stderr).text()}`);
  }
  return { output, gitCalls: (await readdir(logDir)).filter((name) => name.endsWith(".call")).length };
};

describe("a turn with nothing resting costs one state read", () => {
  test("no git, no hub call, no write", async () => {
    // Arrange: a registered session that edited nothing
    const fix = await collisionFixture("te-empty", BEHAVIOUR_TIMING);
    const written = await stateText(fix.home);
    const before = fix.hub.calls.tripwire + fix.hub.calls.other;

    // Act
    const { output, gitCalls } = await runInChild(turnEnded(fix.repo), fix.env);

    // Assert
    expect(output).toBe("");
    expect(gitCalls).toBe(0);
    expect(fix.hub.calls.tripwire + fix.hub.calls.other).toBe(before);
    expect(await stateText(fix.home)).toBe(written);
  });

  test("with a file resting, the full hook runs — the counter sees its git", async () => {
    // Arrange: the identity the settling edits cached is forgotten, so the
    // full hook resolves its repo with git and the counter has git to see
    const fix = await settledFixture("te-full");
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    await forgetRepoIdentities(fix.home);

    // Act
    const { output, gitCalls } = await runInChild(turnEnded(fix.repo), fix.env);

    // Assert
    expect(parsed(output).systemMessage).toBe(KEN_NOTICE);
    expect(gitCalls).toBeGreaterThan(0);
  });

  test("the repo identity an earlier hook resolved is not paid for again: the full hook spawns no git (batch-2 M6)", async () => {
    // Arrange: the settling edits resolved this directory's repo with git
    const fix = await settledFixture("te-warm");
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);

    // Act
    const { output, gitCalls } = await runInChild(turnEnded(fix.repo), fix.env);

    // Assert
    expect(parsed(output).systemMessage).toBe(KEN_NOTICE);
    expect(gitCalls).toBe(0);
  });
});
