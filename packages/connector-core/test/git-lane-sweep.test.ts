/**
 * WHAT A SWEEP SAYS IT ANSWERED (flows/git-lane.ts `sweepGitRoots`; review
 * mutation #4 of feat/topic-contexts). A root git did not answer for must
 * read as unanswered — the turn a skip, the loss booked, the root's bash mark
 * kept so the next Stop tries it first — never as swept. A root that answered
 * is swept, its mark spent.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { MAX_GIT_LANE_TARGETS_PER_ROOT, MAX_TARGETS_PER_INVOCATION } from "../src/constants.ts";
import { sweepGitRoots } from "../src/flows/git-lane.ts";
import type { GitLaneSweep, SweepGitRootsInput } from "../src/flows/git-lane.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { deriveSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo, makeStalledGitDir, runProbeWithGit, writeRepoFile } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
/**
 * Each git call's deadline under a git that never answers (helpers.ts
 * `makeStalledGitDir`): the call times out on it whatever the machine's speed.
 */
const STALLED_GIT_TIMEOUT_MS = 250;
/** A deadline any git process meets on a loaded machine. */
const WIDE_GIT_TIMEOUT_MS = 30_000;
const SWEEP_PROBE = join(import.meta.dir, "fixtures", "sweep-git-roots-probe.ts");

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const sweepOf = async (label: string, gitTimeoutMs: number): Promise<{ readonly root: string; readonly input: SweepGitRootsInput }> => {
  const root = await realpath(await makeRepo(label, { remote: "git@github.com:acme/api.git" }));
  const home = await makeHome(label);
  cleanups.push(root, home);
  await writeRepoFile(root, "src/dirty.ts", "export const d = 1;\n");
  const state = deriveSessionState({
    hostSessionKey: label,
    repoId: REPO_ID,
    repoRoot: root,
    hubUrl: "http://hub.invalid",
    developerId: "dev_1",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  return {
    root,
    input: {
      home,
      repoKey: "hub__github.com__acme__api",
      hostSessionKey: label,
      state,
      roots: [{ root, since: new Date(state.startedAt), firstHead: null, isSessionRoot: true }],
      producer: { developerId: "dev_1", agentKind: "claude-code", sessionId: state.crosscheckSessionId },
      denylist: null,
      now: new Date(),
      seq: null,
      gitTimeoutMs,
    },
  };
};

describe("a sweep answers only for the roots git answered for (review mutation #4)", () => {
  test("a root git did not answer in time is unavailable and not swept", async () => {
    // Arrange: a git that never answers, so no machine is fast enough to beat the deadline
    const { input } = await sweepOf("sweep-unanswered", STALLED_GIT_TIMEOUT_MS);
    const gitDir = await makeStalledGitDir();
    cleanups.push(gitDir);

    // Act
    const sweep = await runProbeWithGit<Pick<GitLaneSweep, "unavailable" | "swept">>(SWEEP_PROBE, gitDir, input);

    // Assert: a skip the hook books, and the root keeps its turn
    expect(sweep.unavailable).toBe(true);
    expect(sweep.swept).toEqual([]);
  });

  test("a root git answered for is swept", async () => {
    // Arrange
    const { root, input } = await sweepOf("sweep-answered", WIDE_GIT_TIMEOUT_MS);

    // Act
    const sweep = await sweepGitRoots(input);

    // Assert
    expect(sweep.unavailable).toBe(false);
    expect(sweep.swept).toEqual([root]);
    expect(sweep.captured).toContain("src/dirty.ts");
  });
});

/** `count` fresh files only a shell wrote, `src/f000.ts` on, beside the fixture's one. */
const dirtyMany = async (root: string, count: number): Promise<readonly string[]> => {
  const paths = Array.from({ length: count }, (_, index) => `src/f${String(index).padStart(3, "0")}.ts`);
  for (const path of paths) {
    await writeRepoFile(root, path, "export const f = 1;\n");
  }
  return paths;
};

/** Five hundred files written and listed is seconds of git on a loaded machine, past bun's 5 s. */
const LANE_CAP_TEST_TIMEOUT_MS = 60_000;

/**
 * THE LANE'S OWN CAP IS PILOT-SCALE (release gate, production lane,
 * 2026-10-09). The sweep stats up to MAX_GIT_TOUCH_CANDIDATES paths and then
 * handed the fresh ones to a cap written for ONE TOOL CALL — twenty — so a
 * root a long session left a hundred files dirty filed twenty per Stop and
 * booked the rest, the shared files behind them never reached a teammate, and
 * a resumed life could never re-file what its earlier life had left. Every
 * fresh path the lane examined is filed, up to the lane's own bound; what that
 * bound cuts is still counted.
 */
describe("a root's sweep files every fresh path it examined, up to the lane's own cap", () => {
  test("more fresh files than one tool call may spool are all filed by one sweep, nothing capped", async () => {
    // Arrange
    const { root, input } = await sweepOf("sweep-pilot-scale", WIDE_GIT_TIMEOUT_MS);
    const fresh = await dirtyMany(root, MAX_TARGETS_PER_INVOCATION + 5);

    // Act
    const sweep = await sweepGitRoots(input);

    // Assert: every fresh file, beside the fixture's own dirty one and the
    // README its first commit made inside the window — nothing cut
    expect(sweep.captured).toEqual(expect.arrayContaining([...fresh, "src/dirty.ts"]));
    expect((await readDropDetail(input.home, input.repoKey)).byReason["capture-capped"]).toBeUndefined();
  });

  test(
    "past the lane's cap the rest is counted, exactly as many as were cut",
    async () => {
      // Arrange: the cap plus two fresh files, beside the fixture's own two
      // (its dirty file, and the README its first commit made in the window)
      const { root, input } = await sweepOf("sweep-lane-cap", WIDE_GIT_TIMEOUT_MS);
      await dirtyMany(root, MAX_GIT_LANE_TARGETS_PER_ROOT + 2);

      // Act
      const sweep = await sweepGitRoots(input);

      // Assert: four candidates past the cap, four counted
      expect(sweep.captured).toHaveLength(MAX_GIT_LANE_TARGETS_PER_ROOT);
      expect((await readDropDetail(input.home, input.repoKey)).byReason["capture-capped"]).toBe(4);
    },
    LANE_CAP_TEST_TIMEOUT_MS,
  );

  test("the block a hook's allocator hands the sweep is as wide as the roots file, not a cap's worth per root", async () => {
    // Arrange: an allocator that remembers what it was asked for
    const { root, input } = await sweepOf("sweep-exact-block", WIDE_GIT_TIMEOUT_MS);
    await dirtyMany(root, MAX_TARGETS_PER_INVOCATION + 5);
    const asked: number[] = [];

    // Act
    const sweep = await sweepGitRoots({
      ...input,
      allocate: async (count) => {
        asked.push(count);
        return { epoch: "e1", from: 1, count };
      },
    });

    // Assert: one block, exactly the paths filed — positions precede records and leave no cap-sized gap
    expect(asked).toEqual([sweep.captured.length]);
    expect(sweep.captured.length).toBeGreaterThan(MAX_TARGETS_PER_INVOCATION);
  });
});
