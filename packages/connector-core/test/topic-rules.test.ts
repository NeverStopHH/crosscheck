/**
 * THE FOUR TOPIC RULES, AGAINST REAL WORKTREES (flows/topic-rules.ts; DESIGN.md
 * "One session, many topics").
 *
 * Every test builds a real repo with a linked worktree, moves its HEAD the way
 * a developer does — a commit, a `git branch -m`, a `git switch -c`, a
 * `git switch --detach` — and asks the rules where the next touch files. The
 * reflog and the refs are git's own files; nothing about descent is stubbed.
 *
 *   (a) first sight of (root, branch) opens a topic — its id names the
 *       worktree and an ordinal, never the branch;
 *   (b) a branch renamed in place keeps its topic;
 *   (c) a branch that continues the work keeps it when the files overlap,
 *       and opens a new one when they do not or when HEAD does not descend;
 *   (d) a detached HEAD on top of the work attaches to it, elsewhere opens
 *       `detached@<sha>`.
 *
 * And the two bounds the reviewer set: the rules spawn no git, and a topic is
 * never excluded for its size.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";

import { DETACHED_LABEL_SHA_CHARS } from "../src/constants.ts";
import type { TouchedRootsResolution } from "../src/capture/touched-root.ts";
import { runGit } from "../src/git/git.ts";
import { readHeadFile } from "../src/git/repo-identity.ts";
import { mintTopicId, topicLifeOf, topicSeenKey, withTopicCapture } from "../src/flows/topic-contexts.ts";
import type { TopicPlan } from "../src/flows/topic-contexts.ts";
import { planTopics } from "../src/flows/topic-rules.ts";
import { deriveSessionState } from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";
import { git, makeRepo, writeRepoFile } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const T0 = Date.parse("2026-10-07T10:00:00.000Z");
const STEP_MS = 60_000;
const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const at = (step: number): Date => new Date(T0 + step * STEP_MS);

const headCommit = async (root: string): Promise<string> => (await runGit(["rev-parse", "HEAD"], root)) ?? "";

/** A repo on `main` (the session's checkout) and a linked worktree on `feat/a`, both realpath'd. */
const world = async (label: string): Promise<{ readonly main: string; readonly sibling: string }> => {
  const main = await realpath(await makeRepo(label, { remote: "git@github.com:acme/api.git" }));
  const sibling = `${main}-wt`;
  cleanups.push(main, sibling);
  await git(main, ["worktree", "add", "-b", "feat/a", sibling]);
  return { main, sibling: await realpath(sibling) };
};

const commitIn = async (root: string, file: string, message: string): Promise<void> => {
  await writeRepoFile(root, file, `${message}\n`);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
};

/** The session as registration leaves it: its own checkout on `main` at its commit. */
const sessionIn = async (main: string): Promise<SessionState> => ({
  ...deriveSessionState({
    hostSessionKey: "rules",
    repoId: REPO_ID,
    repoRoot: main,
    hubUrl: "http://hub.invalid",
    developerId: "dev_1",
    startedAt: at(0).toISOString(),
  }),
  startBranch: "main",
  startHead: await headCommit(main),
  workContextStatus: "implementing",
});

/** One event's touches in `root`, its HEAD read the way the capture pre-pass reads it. */
const resolutionIn = async (root: string, files: readonly string[]): Promise<TouchedRootsResolution> => {
  const head = await readHeadFile(root);
  return {
    rootByPath: new Map(files.map((file) => [`${root}/${file}`, root])),
    foreignDrops: 0,
    outsideDrops: 0,
    newlyResolved: [],
    firstResolvedRoot: null,
    headByRoot: new Map([
      [
        root,
        {
          root,
          repoId: REPO_ID,
          branch: head?.branch ?? null,
          headStamp: head?.content ?? null,
          firstHead: null,
          head,
          touchedAt: at(0).toISOString(),
        },
      ],
    ]),
  };
};

/** The rules' plan for one event, and the state with it folded in — as the hook's one locked write does. */
const touch = async (
  state: SessionState,
  root: string,
  files: readonly string[],
  step: number,
): Promise<{ readonly plan: TopicPlan; readonly state: SessionState }> => {
  const plan = await planTopics(topicLifeOf(state), await resolutionIn(root, files), files.map((file) => `${root}/${file}`), at(step));
  const captured = files.flatMap((file) => {
    const filing = plan.filingByPath.get(`${root}/${file}`);
    return filing === undefined ? [] : [topicSeenKey(filing.key, file)];
  });
  const folded = withTopicCapture(
    { ...state, seenTargets: [...state.seenTargets, ...captured] },
    {
      sessionId: state.crosscheckSessionId,
      opened: plan.opened,
      relabeled: plan.relabeled,
      touched: plan.touched,
      sessionTouched: plan.sessionTouched,
      overflowed: plan.overflowed,
      at: at(step).toISOString(),
    },
  );
  return { plan, state: folded };
};

const keysOf = (plan: TopicPlan): readonly (string | null)[] => [...plan.filingByPath.values()].map((filing) => filing.key);

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

describe("(a) first sight opens a topic", () => {
  test("a branch first seen in a worktree opens a topic whose id names the worktree, never the branch", async () => {
    // Arrange
    const { main, sibling } = await world("rules-a");
    const state = await sessionIn(main);

    // Act
    const { plan } = await touch(state, sibling, ["src/a.ts"], 1);

    // Assert
    const [opened] = plan.opened;
    expect(opened?.key).toBe(mintTopicId(REPO_ID, sibling, 1));
    expect(opened?.key).not.toContain("feat");
    expect(opened).toMatchObject({ branch: "feat/a", branches: ["feat/a"], head: await headCommit(sibling), root: sibling });
    expect(opened?.title).toBe("feat/a @ api");
    expect(keysOf(plan)).toEqual([opened?.key ?? ""]);
  });

  test("the same branch again files under the same topic and attaches nothing", async () => {
    // Arrange
    const { main, sibling } = await world("rules-known");
    const first = await touch(await sessionIn(main), sibling, ["src/a.ts"], 1);

    // Act
    const { plan } = await touch(first.state, sibling, ["src/b.ts"], 2);

    // Assert
    expect(plan.opened).toEqual([]);
    expect(plan.relabeled).toEqual([]);
    expect(keysOf(plan)).toEqual([mintTopicId(REPO_ID, sibling, 1)]);
  });

  test("the session's own checkout on its start branch files under the session's own context", async () => {
    const { main } = await world("rules-start");
    const { plan } = await touch(await sessionIn(main), main, ["src/a.ts"], 1);
    expect(plan.opened).toEqual([]);
    expect(keysOf(plan)).toEqual([null]);
  });
});

describe("(b) a rename keeps the topic", () => {
  test("a branch renamed in place, then committed on, keeps its topic and the new name joins the affinity", async () => {
    // Arrange: a topic on feat/a, then `git branch -m` and a commit
    const { main, sibling } = await world("rules-b");
    const first = await touch(await sessionIn(main), sibling, ["src/a.ts"], 1);
    await git(sibling, ["branch", "-m", "feat/a", "feat/a-renamed"]);
    await commitIn(sibling, "src/other.ts", "after the rename");

    // Act: a file the topic never touched — the rename alone is enough
    const { plan, state } = await touch(first.state, sibling, ["src/other.ts"], 2);

    // Assert
    const id = mintTopicId(REPO_ID, sibling, 1);
    expect(plan.opened).toEqual([]);
    expect(keysOf(plan)).toEqual([id]);
    expect(plan.relabeled).toEqual([{ id, label: "feat/a-renamed", head: await headCommit(sibling) }]);
    const topic = state.topicContexts.find((entry) => entry.key === id);
    expect(topic?.branches).toEqual(["feat/a", "feat/a-renamed"]);
    expect(topic?.head).toBe(await headCommit(sibling));
    expect(topic?.title).toBe("feat/a @ api");
  });

  test("a second rename is judged against the topic's NEWEST name, and keeps the topic again", async () => {
    // Arrange: feat/a renamed to feat/b (the topic now answers to both), then feat/b renamed to feat/c
    const { main, sibling } = await world("rules-b-twice");
    const first = await touch(await sessionIn(main), sibling, ["src/a.ts"], 1);
    await git(sibling, ["branch", "-m", "feat/a", "feat/b"]);
    const second = await touch(first.state, sibling, ["src/b.ts"], 2);
    await git(sibling, ["branch", "-m", "feat/b", "feat/c"]);

    // Act: a file the topic never touched
    const { plan, state } = await touch(second.state, sibling, ["src/c.ts"], 3);

    // Assert
    const id = mintTopicId(REPO_ID, sibling, 1);
    expect(plan.opened).toEqual([]);
    expect(keysOf(plan)).toEqual([id]);
    expect(state.topicContexts.find((entry) => entry.key === id)?.branches).toEqual(["feat/a", "feat/b", "feat/c"]);
  });

  test("a branch deleted after the next one was cut at its tip is no rename: unrelated work opens its own topic (review H3)", async () => {
    // Arrange: a topic on feat/a with a commit; then feat/next cut at its tip, and feat/a deleted
    const { main, sibling } = await world("rules-b-deleted");
    await commitIn(sibling, "src/old-work.ts", "old work");
    const first = await touch(await sessionIn(main), sibling, ["src/old-work.ts"], 1);
    await git(sibling, ["switch", "-c", "feat/unrelated"]);
    await git(sibling, ["branch", "-D", "feat/a"]);

    // Act: a file the topic never touched
    const { plan } = await touch(first.state, sibling, ["src/unrelated.ts"], 2);

    // Assert: a new topic for feat/unrelated, nothing attached to feat/a's
    expect(plan.opened.map((topic) => topic.branch)).toEqual(["feat/unrelated"]);
    expect(plan.relabeled).toEqual([]);
  });
});

describe("(c) a move to another branch", () => {
  test("a branch that continues the work keeps the topic when this event's files overlap the topic's", async () => {
    // Arrange: a topic on feat/a that touched src/a.ts, then a follow-up branch on top of it
    const { main, sibling } = await world("rules-c-keep");
    const first = await touch(await sessionIn(main), sibling, ["src/a.ts"], 1);
    await git(sibling, ["switch", "-c", "feat/a-2"]);
    await commitIn(sibling, "src/a.ts", "continued");

    // Act
    const { plan, state } = await touch(first.state, sibling, ["src/a.ts"], 2);

    // Assert
    const id = mintTopicId(REPO_ID, sibling, 1);
    expect(plan.opened).toEqual([]);
    expect(keysOf(plan)).toEqual([id]);
    expect(state.topicContexts.find((entry) => entry.key === id)?.branches).toEqual(["feat/a", "feat/a-2"]);
  });

  test("the same move with files the topic never touched opens the worktree's second topic", async () => {
    // Arrange
    const { main, sibling } = await world("rules-c-open");
    const first = await touch(await sessionIn(main), sibling, ["src/a.ts"], 1);
    await git(sibling, ["switch", "-c", "feat/b"]);
    await commitIn(sibling, "src/b.ts", "other work");

    // Act
    const { plan } = await touch(first.state, sibling, ["src/b.ts"], 2);

    // Assert: a new topic, ordinal 2 in the same worktree
    expect(plan.opened.map((topic) => [topic.key, topic.branch])).toEqual([[mintTopicId(REPO_ID, sibling, 2), "feat/b"]]);
    expect(plan.relabeled).toEqual([]);
  });

  test("a branch whose commit does not descend from the topic's opens a new topic even when the files overlap", async () => {
    // Arrange: the topic moved on with a commit; then a branch from the commit BEFORE it
    const { main, sibling } = await world("rules-c-older");
    const base = await headCommit(sibling);
    await commitIn(sibling, "src/a.ts", "topic work");
    const first = await touch(await sessionIn(main), sibling, ["src/a.ts"], 1);
    await git(sibling, ["switch", "-c", "feat/older", base]);

    // Act
    const { plan } = await touch(first.state, sibling, ["src/a.ts"], 2);

    // Assert
    expect(plan.opened.map((topic) => [topic.branch, topic.head])).toEqual([["feat/older", base]]);
  });
});

describe("(d) a detached HEAD", () => {
  test("a HEAD detached on top of the topic's work attaches to the topic", async () => {
    // Arrange
    const { main, sibling } = await world("rules-d-keep");
    const first = await touch(await sessionIn(main), sibling, ["src/a.ts"], 1);
    await git(sibling, ["switch", "--detach"]);
    await commitIn(sibling, "src/c.ts", "detached work");

    // Act
    const { plan, state } = await touch(first.state, sibling, ["src/c.ts"], 2);

    // Assert
    const id = mintTopicId(REPO_ID, sibling, 1);
    const label = `detached@${(await headCommit(sibling)).slice(0, DETACHED_LABEL_SHA_CHARS)}`;
    expect(plan.opened).toEqual([]);
    expect(keysOf(plan)).toEqual([id]);
    expect(state.topicContexts.find((entry) => entry.key === id)?.branches).toEqual(["feat/a", label]);
  });

  test("a HEAD detached on a commit the topic never reached opens `detached@<sha>`", async () => {
    // Arrange: the topic moved on; then a detach at the commit before it
    const { main, sibling } = await world("rules-d-open");
    const base = await headCommit(sibling);
    await commitIn(sibling, "src/a.ts", "topic work");
    const first = await touch(await sessionIn(main), sibling, ["src/a.ts"], 1);
    await git(sibling, ["switch", "--detach", base]);

    // Act
    const { plan } = await touch(first.state, sibling, ["src/a.ts"], 2);

    // Assert
    const label = `detached@${base.slice(0, DETACHED_LABEL_SHA_CHARS)}`;
    expect(plan.opened.map((topic) => [topic.branch, topic.title])).toEqual([[label, `${label} @ api`]]);
  });

  test("the session's own checkout detached in place stays the session's own context", async () => {
    // Arrange
    const { main } = await world("rules-d-start");
    const state = await sessionIn(main);
    await git(main, ["switch", "--detach"]);

    // Act
    const { plan, state: after } = await touch(state, main, ["src/a.ts"], 1);

    // Assert
    expect(plan.opened).toEqual([]);
    expect(keysOf(plan)).toEqual([null]);
    expect(after.startBranches).toEqual([`detached@${(await headCommit(main)).slice(0, DETACHED_LABEL_SHA_CHARS)}`]);
  });
});

describe("the bounds", () => {
  test("the rules spawn no git: a rename and the descent behind it are answered from git's files", async () => {
    // Arrange: a worktree move that needs a descent answer
    const { main, sibling } = await world("rules-spawns");
    const first = await touch(await sessionIn(main), sibling, ["src/a.ts"], 1);
    await git(sibling, ["branch", "-m", "feat/a", "feat/a-renamed"]);
    await commitIn(sibling, "src/a.ts", "renamed");

    // Act
    const { value, spawns } = await countSpawns(() => touch(first.state, sibling, ["src/a.ts"], 2));

    // Assert
    expect(value.plan.relabeled.map((relabel) => relabel.label)).toEqual(["feat/a-renamed"]);
    expect(spawns).toBe(0);
  });

  test("a topic is never excluded for its size: every file of a 300-file event files under its topic", async () => {
    // Arrange: a topic whose seen-set already holds 1000 files
    const { main, sibling } = await world("rules-size");
    const state = await sessionIn(main);
    const id = mintTopicId(REPO_ID, sibling, 1);
    const big = { ...state, seenTargets: Array.from({ length: 1000 }, (_, index) => topicSeenKey(id, `old/${String(index)}.ts`)) };
    const files = Array.from({ length: 300 }, (_, index) => `src/f${String(index)}.ts`);

    // Act
    const { plan } = await touch(big, sibling, files, 1);

    // Assert
    expect(plan.opened.map((topic) => topic.key)).toEqual([id]);
    expect(keysOf(plan)).toEqual(files.map(() => id));
  });
});
