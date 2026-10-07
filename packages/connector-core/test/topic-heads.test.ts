/**
 * A ROOT'S TOPIC, READ FROM ITS HEAD FILE (DESIGN.md "One session, many
 * topics", item 1): every touched root carries the branch it is on —
 * `detached@<sha>` when detached, never a branch that merely points at the
 * commit — the HEAD bytes that were read, and the commit at the first touch.
 *
 * The cost rule is the point: the hook path reads two small files per root and
 * spawns NO git for a root it has seen. Git answers a root's repo id once, on
 * a cache miss; a `git switch` inside the worktree is seen from the HEAD bytes
 * alone. `Bun.spawn` is counted around the second resolution to prove it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";

import { DETACHED_LABEL_SHA_CHARS } from "../src/constants.ts";
import { resolveTouchedRoots } from "../src/capture/touched-root.ts";
import type { KnownWorktreeRoot } from "../src/capture/touched-root.ts";
import { runGit } from "../src/git/git.ts";
import {
  branchLabelOfHead,
  readHeadFile,
  resolveHeadCommit,
} from "../src/git/repo-identity.ts";
import { deriveSessionState, withRootHead } from "../src/state/session-state.ts";
import { withCaptureBookkeeping } from "../src/state/capture-bookkeeping.ts";
import { git, makeRepo, writeRepoFile } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/** A repo and one linked worktree on its own branch, both realpath'd. */
const repoWithWorktree = async (
  label: string,
): Promise<{ readonly main: string; readonly sibling: string }> => {
  const main = await realpath(await makeRepo(label, { remote: "git@github.com:acme/api.git" }));
  const sibling = `${main}-feat`;
  cleanups.push(main, sibling);
  await git(main, ["worktree", "add", "-b", "feat/topic-a", sibling]);
  return { main, sibling: await realpath(sibling) };
};

/** Counts every process spawned while `action` runs. */
const countSpawns = async <T>(action: () => Promise<T>): Promise<{ readonly value: T; readonly spawns: number }> => {
  const original = Bun.spawn;
  let spawns = 0;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    spawns += 1;
    return original(...args);
  }) as typeof Bun.spawn;
  try {
    return { value: await action(), spawns };
  } finally {
    Bun.spawn = original;
  }
};

describe("branchLabelOfHead", () => {
  test("a symbolic ref names its branch; a commit id names a detached HEAD", () => {
    expect(branchLabelOfHead("ref: refs/heads/feat/x")).toBe("feat/x");
    expect(branchLabelOfHead("ref: refs/remotes/origin/main")).toBe("refs/remotes/origin/main");
    expect(branchLabelOfHead(SHA)).toBe(`detached@${SHA.slice(0, DETACHED_LABEL_SHA_CHARS)}`);
  });

  test("anything else is no label at all", () => {
    expect(branchLabelOfHead("ref: ")).toBeNull();
    expect(branchLabelOfHead("not a head")).toBeNull();
    expect(branchLabelOfHead(SHA.toUpperCase())).toBeNull();
  });
});

describe("readHeadFile and resolveHeadCommit read git's files, not git", () => {
  test("a main checkout and a linked worktree each name their own branch and commit", async () => {
    // Arrange
    const { main, sibling } = await repoWithWorktree("heads-pair");
    const tip = await runGit(["rev-parse", "HEAD"], main);

    // Act
    const mainHead = await readHeadFile(main);
    const siblingHead = await readHeadFile(sibling);

    // Assert
    expect(mainHead?.branch).toBe("main");
    expect(siblingHead?.branch).toBe("feat/topic-a");
    expect(siblingHead?.content).toBe("ref: refs/heads/feat/topic-a");
    expect(mainHead === null ? null : await resolveHeadCommit(mainHead)).toBe(tip);
    expect(siblingHead === null ? null : await resolveHeadCommit(siblingHead)).toBe(tip);
  });

  test("a packed ref and a detached HEAD resolve too", async () => {
    // Arrange: every loose ref packed away, then a detached sibling
    const { main, sibling } = await repoWithWorktree("heads-packed");
    await git(main, ["pack-refs", "--all"]);
    await git(sibling, ["checkout", "--detach"]);
    const tip = (await runGit(["rev-parse", "HEAD"], main)) ?? "";

    // Act
    const mainHead = await readHeadFile(main);
    const detached = await readHeadFile(sibling);

    // Assert
    expect(mainHead === null ? null : await resolveHeadCommit(mainHead)).toBe(tip);
    expect(detached?.branch).toBe(`detached@${tip.slice(0, DETACHED_LABEL_SHA_CHARS)}`);
    expect(detached === null ? null : await resolveHeadCommit(detached)).toBe(tip);
  });

  test("a directory that is no checkout has no HEAD", async () => {
    expect(await readHeadFile("/cx-topic-heads/nowhere")).toBeNull();
  });
});

describe("every touched root carries its topic", () => {
  test("a touch in a sibling worktree records its branch, HEAD bytes and first commit", async () => {
    // Arrange
    const { main, sibling } = await repoWithWorktree("heads-touch");
    const file = await writeRepoFile(sibling, "src/a.ts", "export {};\n");
    const tip = await runGit(["rev-parse", "HEAD"], main);

    // Act
    const resolution = await resolveTouchedRoots({
      paths: [file],
      cwd: main,
      sessionRepoRoot: main,
      sessionRepoId: REPO_ID,
      identityRoot: main,
      identityRepoId: REPO_ID,
      knownWorktreeRoots: [],
      // The fixture commits no .crosscheck.json, so the connected-root walk
      // is stood in for; the HEAD reads below are the real ones.
      resolveConnectedRoot: async () => sibling,
      resolveRootRepoId: async () => REPO_ID,
      now: new Date("2026-10-07T10:00:00.000Z"),
    });

    // Assert
    const head = resolution.headByRoot.get(sibling);
    expect(head?.branch).toBe("feat/topic-a");
    expect(head?.headStamp).toBe("ref: refs/heads/feat/topic-a");
    expect(head?.firstHead).toBe(tip);
    expect(head?.touchedAt).toBe("2026-10-07T10:00:00.000Z");
  });

  test("a branch switch inside the worktree flips its topic without spawning git", async () => {
    // Arrange: the first touch judged the root (the one git cost), and its
    // answer is folded into the session's cache as the hook would fold it
    const { main, sibling } = await repoWithWorktree("heads-switch");
    const file = await writeRepoFile(sibling, "src/a.ts", "export {};\n");
    const input = {
      paths: [file],
      cwd: main,
      sessionRepoRoot: main,
      sessionRepoId: REPO_ID,
      identityRoot: main,
      identityRepoId: REPO_ID,
      resolveConnectedRoot: async () => sibling,
    };
    // The cache miss: the repo id is git's answer, once.
    const first = await resolveTouchedRoots({ ...input, knownWorktreeRoots: [] });
    const state = withCaptureBookkeeping(
      deriveSessionState({
        hostSessionKey: "topic-heads",
        repoId: REPO_ID,
        repoRoot: main,
        hubUrl: "http://hub.invalid",
        developerId: null,
        startedAt: "2026-10-07T09:00:00.000Z",
      }),
      { resolution: first, capturedCount: 1, editFired: true, toolLabel: "Edit", firstPath: file, now: new Date() },
    );
    const firstHead = first.headByRoot.get(sibling)?.firstHead;
    await git(sibling, ["switch", "-c", "feat/topic-b"]);

    // Act
    const { value: second, spawns } = await countSpawns(() =>
      resolveTouchedRoots({ ...input, knownWorktreeRoots: state.knownWorktreeRoots }),
    );

    // Assert: the new branch, the HEAD bytes that say so, the first commit
    // kept — and not one process spawned to learn it
    expect(spawns).toBe(0);
    expect(second.headByRoot.get(sibling)?.branch).toBe("feat/topic-b");
    expect(second.headByRoot.get(sibling)?.headStamp).toBe("ref: refs/heads/feat/topic-b");
    expect(second.headByRoot.get(sibling)?.firstHead).toBe(firstHead ?? "missing");
  });

  test("the session's own checkout is a touched root too", async () => {
    // Arrange: a start checkout detached at its commit
    const { main } = await repoWithWorktree("heads-own");
    await git(main, ["checkout", "--detach"]);
    const file = await writeRepoFile(main, "src/own.ts", "export {};\n");
    const tip = (await runGit(["rev-parse", "HEAD"], main)) ?? "";

    // Act
    const { value: resolution, spawns } = await countSpawns(() =>
      resolveTouchedRoots({
        paths: [file],
        cwd: main,
        sessionRepoRoot: main,
        sessionRepoId: REPO_ID,
        identityRoot: main,
        identityRepoId: REPO_ID,
        knownWorktreeRoots: [],
      }),
    );

    // Assert: `detached@<sha>` and never the `main` branch that points there
    expect(spawns).toBe(0);
    expect(resolution.headByRoot.get(main)?.branch).toBe(`detached@${tip.slice(0, DETACHED_LABEL_SHA_CHARS)}`);
  });
});

describe("withRootHead keeps the first touch and moves the entry to the end", () => {
  const base = deriveSessionState({
    hostSessionKey: "root-head",
    repoId: REPO_ID,
    repoRoot: "/cx/root-head",
    hubUrl: "http://hub.invalid",
    developerId: null,
    startedAt: "2026-10-07T09:00:00.000Z",
  });
  const touch = (root: string, branch: string, at: string, firstHead: string | null) => ({
    root,
    repoId: REPO_ID,
    branch,
    headStamp: `ref: refs/heads/${branch}`,
    firstHead,
    touchedAt: at,
  });

  test("a later touch keeps firstTouchedAt and firstHead and moves lastTouchedAt", () => {
    // Act
    const once = withRootHead(base, touch("/cx/a", "x", "2026-10-07T10:00:00.000Z", SHA));
    const twice = withRootHead(once, touch("/cx/a", "y", "2026-10-07T11:00:00.000Z", null));

    // Assert
    const entry = twice.knownWorktreeRoots.find((known) => known.root === "/cx/a") as KnownWorktreeRoot;
    expect(entry.branch).toBe("y");
    expect(entry.firstHead).toBe(SHA);
    expect(entry.firstTouchedAt).toBe("2026-10-07T10:00:00.000Z");
    expect(entry.lastTouchedAt).toBe("2026-10-07T11:00:00.000Z");
    expect(entry.attempts).toBe(1);
  });

  test("the most recently touched root is last, so the FIFO cap evicts the stalest", () => {
    // Act
    const a = withRootHead(base, touch("/cx/a", "x", "2026-10-07T10:00:00.000Z", SHA));
    const b = withRootHead(a, touch("/cx/b", "x", "2026-10-07T10:01:00.000Z", SHA));
    const again = withRootHead(b, touch("/cx/a", "x", "2026-10-07T10:02:00.000Z", SHA));

    // Assert
    expect(again.knownWorktreeRoots.map((entry) => entry.root)).toEqual(["/cx/b", "/cx/a"]);
  });
});
