/**
 * ONE SESSION, MANY TOPICS IN THE OWNER'S REAL SHAPE (review M9 of
 * feat/topic-contexts; DESIGN.md "One session, many topics").
 *
 * The shape the review measured the pilot in, rather than the mirror the
 * first tests built: one long session started in a checkout DETACHED at an old
 * commit (`agentic-main`), every hook — a subagent's included — firing with
 * THAT checkout as its cwd, and the work done in sibling worktrees on their
 * own branches, much of it by `cd <sibling> && … && git commit` in a shell.
 * Each describe below is one of the review's findings, driven through the
 * real hooks against real git, and states what must hold:
 *
 *   H1  a commit is filed under the topic whose worktree MADE it — never under
 *       another topic that merged it in, a start checkout re-detached at a
 *       newer main, a worktree re-added at the same path, or a second
 *       worktree on the same branch.
 *
 * A dead hub (port 1) keeps every record in the spool, where it is read back.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_GIT_TOUCH_CANDIDATES, MAX_TOPICS_PER_SESSION } from "@crosscheck/connector-core/constants.ts";
import { readDropDetail } from "@crosscheck/connector-core/spool/drops.ts";
import { readCaptureLosses } from "@crosscheck/connector-core/state/loss-ledger.ts";
import { readSessionState, updateSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState, TopicContext } from "@crosscheck/connector-core/state/session-state.ts";
import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "nick-shape-uuid";
const DEAD_HUB_URL = "http://127.0.0.1:1";
/** Generous: these tests assert WHAT is filed where, not what a starved hook can afford. */
const WIDE_TIMEOUT_MS = "8000";
/** The repo's own history predates the session (author and committer). */
const BEFORE_THE_SESSION = new Date(Date.now() - 7_200_000).toISOString();

const paths: string[] = [];

/** Real worktrees and real hooks, several of each per test: past bun's 5 s default on a loaded machine. */
setDefaultTimeout(60_000);

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

interface World {
  /** The start checkout, detached — every hook's cwd, as in the owner's sessions. */
  readonly main: string;
  readonly home: string;
  readonly siblings: readonly string[];
}

const env = (home: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_SSH_CANONICALIZE: "off",
  PATH: process.env["PATH"],
  CROSSCHECK_TIMEOUT_MS: WIDE_TIMEOUT_MS,
});

/** The owner's shape: a connected repo, `count` sibling worktrees on `feat/topic-<n>`, the start checkout detached. */
const nickShape = async (label: string, count: number, refFormat?: "reftable"): Promise<World> => {
  const main = await makeRepo(label, { remote: "git@github.com:acme/api.git", ...(refFormat === undefined ? {} : { refFormat }) });
  await git(main, ["commit", "--amend", "--no-edit", `--date=${BEFORE_THE_SESSION}`]);
  await writeFile(join(main, ".crosscheck.json"), `${JSON.stringify({ hubUrl: DEAD_HUB_URL })}\n`, "utf8");
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "config", `--date=${BEFORE_THE_SESSION}`]);
  const home = await makeHome(label);
  paths.push(main, home);
  const siblings: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const parent = await mkdtemp(join(tmpdir(), `cx-nick-${label}-`));
    paths.push(parent);
    const sibling = join(parent, `wt${String(index)}`);
    await git(main, ["worktree", "add", "-b", `feat/topic-${String(index)}`, sibling]);
    siblings.push(sibling);
  }
  await git(main, ["checkout", "--detach"]);
  return { main, home, siblings };
};

const hookPayload = (cwd: string, extra: Record<string, unknown>): string =>
  JSON.stringify({ session_id: SESSION_ID, cwd, ...extra });

const sessionStart = (world: World): Promise<string> =>
  runHook("session-start", hookPayload(world.main, { hook_event_name: "SessionStart", source: "startup" }), env(world.home));

/** An Edit by the main thread or a subagent: the cwd is the start checkout, the file anywhere. */
const edit = (world: World, file: string): Promise<string> =>
  runHook(
    "post-tool-use",
    hookPayload(world.main, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file }, tool_response: {} }),
    env(world.home),
  );

const stop = (world: World): Promise<string> =>
  runHook("stop", hookPayload(world.main, { hook_event_name: "Stop", stop_hook_active: false }), env(world.home));

/** A Bash call by a subagent: the cwd is the start checkout, whatever the command does. */
const bash = (world: World, command: string): Promise<string> =>
  runHook(
    "post-tool-use",
    hookPayload(world.main, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: {} }),
    env(world.home),
  );

const subagentStop = (world: World): Promise<string> =>
  runHook("subagent-stop", hookPayload(world.main, { hook_event_name: "SubagentStop", stop_hook_active: false }), env(world.home));

/** One of a full life's topics, in a worktree that is none of the test's (`/cx-nick-full/<n>`). */
const fullTopic = (state: SessionState, index: number): TopicContext => ({
  key: `full${String(index)}.1`,
  sessionId: state.crosscheckSessionId,
  workContextId: `${state.workContextId}~tfull${String(index)}.1`,
  branch: `feat/full-${String(index)}`,
  branches: [`feat/full-${String(index)}`],
  head: null,
  title: `feat/full-${String(index)} @ api`,
  status: "implementing",
  baseCommit: null,
  root: `/cx-nick-full/${String(index)}`,
  registeredAt: new Date().toISOString(),
  lastTouchedAt: new Date(Date.now() - 600_000).toISOString(),
  ackedStatus: null,
});

const MS_PER_HOUR = 3_600_000;
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * MS_PER_HOUR).toISOString();

/** Files a dump adds beyond what it must, so the bound is passed by a margin. */
const DUMP_FILES = 300;

/** `count` empty files `<prefix><n>.js` in `dir`, dated `at` when given (a dump older than the session). */
const writeMany = async (dir: string, count: number, prefix: string, at?: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const path = join(dir, `${prefix}${String(index)}.js`);
      await writeFile(path, "", "utf8");
      if (at !== undefined) {
        await utimes(path, new Date(at), new Date(at));
      }
    }),
  );
};

const commitAll = async (root: string, message: string): Promise<void> => {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", message]);
};

interface SpooledRecord {
  readonly kind: string;
  readonly body: {
    readonly id?: string;
    readonly workContextId?: string;
    readonly value?: string;
    readonly source?: string;
    readonly branch?: string;
    readonly title?: string;
  };
}

const spooled = async (world: World): Promise<readonly SpooledRecord[]> =>
  (await readSpoolLines(world.home, repoKey(DEAD_HUB_URL, REPO_ID))).map((line) => JSON.parse(line) as SpooledRecord);

/** Every topic's files, by the branch it was opened on: `<value>:<source>`, sorted. */
const filesByTopic = (records: readonly SpooledRecord[]): Readonly<Record<string, readonly string[]>> => {
  const branchOf = new Map(
    records.filter((record) => record.kind === "work_context").map((record) => [record.body.id ?? "", record.body.branch ?? "(session)"]),
  );
  const out: Record<string, string[]> = {};
  for (const record of records.filter((entry) => entry.kind === "target")) {
    const branch = branchOf.get(record.body.workContextId ?? "") ?? "(session)";
    out[branch] = [...(out[branch] ?? []), `${record.body.value ?? ""}:${record.body.source ?? ""}`].sort();
  }
  return out;
};

describe("H1: a commit is filed under the topic whose worktree made it", () => {
  test("a topic that merges another topic's branch never takes that topic's commits", async () => {
    // Arrange: topic A (wt0) commits three files; topic B (wt1) merges A's branch
    const world = await nickShape("h1-merge", 2);
    const [a = "", b = ""] = world.siblings;
    await sessionStart(world);
    await edit(world, await writeRepoFile(a, "src/a-edit.ts", "export const a = 1;\n"));
    await edit(world, await writeRepoFile(b, "src/b-edit.ts", "export const b = 1;\n"));
    await stop(world);
    for (const name of ["a1", "a2", "a3"]) {
      await writeRepoFile(a, `src/${name}.ts`, `export const ${name} = 1;\n`);
    }
    await commitAll(a, "topic A work");

    // Act
    await stop(world);
    await commitAll(b, "topic B work");
    await git(b, ["merge", "--no-edit", "feat/topic-0"]);
    await stop(world);

    // Assert: A's files once, under A; B holds only its own
    const topics = filesByTopic(await spooled(world));
    expect(topics["feat/topic-1"]).toEqual(["src/b-edit.ts:tool_edit"]);
    expect(topics["feat/topic-0"]).toEqual([
      "src/a-edit.ts:tool_edit",
      "src/a1.ts:git_commit",
      "src/a2.ts:git_commit",
      "src/a3.ts:git_commit",
    ]);
  });

  test("the start checkout re-detached at a newer main takes none of the work that landed there", async () => {
    // Arrange: topic work committed in wt0 lands on main, and the start checkout follows main
    const world = await nickShape("h1-redetach", 1);
    const [a = ""] = world.siblings;
    await sessionStart(world);
    for (const name of ["x1", "x2"]) {
      await edit(world, await writeRepoFile(a, `src/${name}.ts`, `export const ${name} = 1;\n`));
    }
    await commitAll(a, "topic work");
    await stop(world);
    await git(world.main, ["branch", "-f", "main", "feat/topic-0"]);
    await git(world.main, ["checkout", "--detach", "main"]);

    // Act
    await edit(world, await writeRepoFile(world.main, "src/main-edit.ts", "export const m = 1;\n"));
    await stop(world);

    // Assert: x1 and x2 stay under topic-0, as edits there and as its commit; nothing else holds them
    const topics = filesByTopic(await spooled(world));
    const holders = Object.entries(topics)
      .filter(([, files]) => files.some((file) => file.startsWith("src/x1.ts")))
      .map(([branch]) => branch);
    expect(holders).toEqual(["feat/topic-0"]);
  });

  test("a worktree re-added at the same path takes none of the removed worktree's commits", async () => {
    // Arrange: commit in wt0, remove it, re-add it at the same path on a new branch from that tip
    const world = await nickShape("h1-readd", 1);
    const [a = ""] = world.siblings;
    await sessionStart(world);
    await edit(world, await writeRepoFile(a, "src/first-life.ts", "export const f = 1;\n"));
    await commitAll(a, "first");
    await stop(world);
    const tip = (await Bun.$`git -C ${a} rev-parse HEAD`.quiet().text()).trim();
    await git(world.main, ["worktree", "remove", "--force", a]);
    await git(world.main, ["branch", "-D", "feat/topic-0"]);
    await git(world.main, ["worktree", "add", "-b", "feat/second-life", a, tip]);

    // Act
    await edit(world, await writeRepoFile(a, "src/second-life.ts", "export const s = 1;\n"));
    await stop(world);

    // Assert
    const topics = filesByTopic(await spooled(world));
    expect(topics["feat/second-life"]).toEqual(["src/second-life.ts:tool_edit"]);
  });

  test("of two worktrees on one branch, only the one that committed holds the commit", async () => {
    // Arrange: a twin worktree checked out on wt0's branch with --force
    const world = await nickShape("h1-twin", 1);
    const [a = ""] = world.siblings;
    const parent = await mkdtemp(join(tmpdir(), "cx-nick-twin-"));
    paths.push(parent);
    const twin = join(parent, "twin");
    await git(world.main, ["worktree", "add", "--force", twin, "feat/topic-0"]);
    await sessionStart(world);
    await edit(world, await writeRepoFile(a, "src/t-a.ts", "export const t = 1;\n"));
    await edit(world, await writeRepoFile(twin, "src/t-twin.ts", "export const w = 1;\n"));

    // Act
    await git(a, ["add", "src/t-a.ts"]);
    await git(a, ["commit", "-m", "in a"]);
    await stop(world);

    // Assert: t-a.ts is under wt0's topic alone — the twin's sweep files nothing of it
    const records = await spooled(world);
    const holders = new Set(
      records.filter((record) => record.kind === "target" && record.body.value === "src/t-a.ts").map((record) => record.body.workContextId),
    );
    expect(holders.size).toBe(1);
  });
});

describe("H2: a subagent's shell work in a sibling it never edited is captured", () => {
  test("`cd <sibling> && … && git commit` from the start checkout: the commit and the new file land under the sibling's topic", async () => {
    // Arrange: the work a subagent's shell does, its cwd the start checkout
    const world = await nickShape("h2-cd", 1);
    const [sibling = ""] = world.siblings;
    await sessionStart(world);
    await writeRepoFile(sibling, "src/only-bash.ts", "export const b = 1;\n");
    await commitAll(sibling, "bash only");
    await writeRepoFile(sibling, "src/only-bash-untracked.ts", "export const u = 1;\n");

    // Act
    await bash(world, `cd ${sibling} && cp src/a.ts src/b.ts && git commit -am x`);
    const marked = (await readSessionState(world.home, SESSION_ID))?.knownWorktreeRoots.filter((entry) => entry.bashTouchedAt !== null);
    await subagentStop(world);
    await stop(world);

    // Assert: the command's own `cd` marked the sibling, and its work is under the sibling's topic
    expect(marked?.some((entry) => entry.root === sibling || entry.root.endsWith(sibling))).toBe(true);
    const topics = filesByTopic(await spooled(world));
    expect(topics["feat/topic-0"]).toEqual(["src/only-bash-untracked.ts:git_diff", "src/only-bash.ts:git_commit"]);
  });

  test("a command whose words name no worktree: the next Stop finds the sibling the shell changed", async () => {
    // Arrange: a script the words cannot see into, run from the start checkout, that commits in a sibling
    const world = await nickShape("h2-script", 1);
    const [sibling = ""] = world.siblings;
    await sessionStart(world);
    await writeRepoFile(sibling, "src/scripted.ts", "export const s = 1;\n");
    await commitAll(sibling, "scripted");

    // Act
    await bash(world, "./scripts/release.sh --all");
    await stop(world);

    // Assert
    expect(filesByTopic(await spooled(world))["feat/topic-0"]).toEqual(["src/scripted.ts:git_commit"]);
  });

  test("more changed siblings than one Stop's root budget: the rest are counted, and the next Stop sweeps them", async () => {
    // Arrange: ten siblings changed by a shell whose words name none of them
    const world = await nickShape("h2-cap", 10);
    await sessionStart(world);
    for (const [index, sibling] of world.siblings.entries()) {
      await writeRepoFile(sibling, `src/s${String(index)}.ts`, `export const s${String(index)} = 1;\n`);
      await commitAll(sibling, `s${String(index)}`);
    }

    // Act
    await bash(world, "make all");
    await stop(world);
    const afterFirst = await readSessionState(world.home, SESSION_ID);
    await stop(world);

    // Assert: some were deferred and counted, and after the second Stop every sibling's commit is in
    expect(afterFirst?.gitLaneRootsDeferred ?? 0).toBeGreaterThan(0);
    const topics = filesByTopic(await spooled(world));
    for (const index of world.siblings.keys()) {
      expect({ index, files: topics[`feat/topic-${String(index)}`] }).toEqual({ index, files: [`src/s${String(index)}.ts:git_commit`] });
    }
  });
});

describe("M4: a renamed branch's topic is retitled on the hub", () => {
  test("`git branch -m` in a sibling: the topic keeps its id and opening branch, and goes out titled by the new name", async () => {
    // Arrange: a topic on feat/topic-0, then the branch renamed and edited on
    const world = await nickShape("m4-rename", 1);
    const [sibling = ""] = world.siblings;
    await sessionStart(world);
    await edit(world, await writeRepoFile(sibling, "src/before.ts", "export const b = 1;\n"));
    await git(sibling, ["branch", "-m", "feat/topic-0", "feat/renamed"]);

    // Act
    await edit(world, await writeRepoFile(sibling, "src/after.ts", "export const a = 1;\n"));

    // Assert: two records of ONE context, the later one carrying the new title
    const contexts = (await spooled(world)).filter((record) => record.kind === "work_context" && record.body.branch === "feat/topic-0");
    expect(new Set(contexts.map((record) => record.body.id)).size).toBe(1);
    expect(contexts.map((record) => record.body.title)).toEqual(["feat/topic-0 @ api", "feat/renamed @ api"]);
    const topic = (await readSessionState(world.home, SESSION_ID))?.topicContexts.find((entry) => entry.branch === "feat/topic-0");
    expect(topic?.title).toBe("feat/renamed @ api");
    expect(filesByTopic(await spooled(world))["feat/topic-0"]).toEqual(["src/after.ts:tool_edit", "src/before.ts:tool_edit"]);
  });

  test("a rename seen first by the Stop sweep — a shell's commit, no edit — retitles the topic too", async () => {
    // Arrange
    const world = await nickShape("m4-rename-lane", 1);
    const [sibling = ""] = world.siblings;
    await sessionStart(world);
    await edit(world, await writeRepoFile(sibling, "src/before.ts", "export const b = 1;\n"));
    await git(sibling, ["branch", "-m", "feat/topic-0", "feat/renamed"]);
    await writeRepoFile(sibling, "src/shell.ts", "export const s = 1;\n");
    await commitAll(sibling, "through a shell");

    // Act
    await stop(world);

    // Assert
    const contexts = (await spooled(world)).filter((record) => record.kind === "work_context" && record.body.branch === "feat/topic-0");
    expect(contexts.map((record) => record.body.title)).toEqual(["feat/topic-0 @ api", "feat/renamed @ api"]);
    expect(filesByTopic(await spooled(world))["feat/topic-0"]).toContain("src/shell.ts:git_commit");
  });
});

describe("M5: a dirty file carried across a branch switch stays with the topic that holds it", () => {
  test("edit on feat/topic-0, switch to a new branch, edit elsewhere: the Stop files the carried file under neither twice", async () => {
    // Arrange: the review's probe P4, in the owner's shape
    const world = await nickShape("m5-carried", 1);
    const [sibling = ""] = world.siblings;
    await sessionStart(world);
    await edit(world, await writeRepoFile(sibling, "src/carried.ts", "export const c = 1;\n"));
    await git(sibling, ["switch", "-c", "feat/next"]);
    await edit(world, await writeRepoFile(sibling, "src/fresh.ts", "export const f = 1;\n"));

    // Act
    await stop(world);

    // Assert: still two topics (the edit came first), but each file in exactly one of them
    const topics = filesByTopic(await spooled(world));
    expect(topics["feat/topic-0"]).toEqual(["src/carried.ts:tool_edit"]);
    expect(topics["feat/next"]).toEqual(["src/fresh.ts:tool_edit"]);
  });

  test("a carried file changed again after the switch still files under the topic that holds it", async () => {
    // Arrange: the carried file is committed on the new branch by a shell
    const world = await nickShape("m5-carried-commit", 1);
    const [sibling = ""] = world.siblings;
    await sessionStart(world);
    await edit(world, await writeRepoFile(sibling, "src/carried.ts", "export const c = 1;\n"));
    await git(sibling, ["switch", "-c", "feat/next"]);
    await edit(world, await writeRepoFile(sibling, "src/fresh.ts", "export const f = 1;\n"));
    await stop(world);
    await writeRepoFile(sibling, "src/brand-new.ts", "export const n = 1;\n");
    await commitAll(sibling, "carried, fresh and a brand-new file");

    // Act
    await stop(world);

    // Assert: the commit's files split by holder; the file nobody held goes to the root's topic now
    const topics = filesByTopic(await spooled(world));
    expect(topics["feat/topic-0"]).toEqual(["src/carried.ts:tool_edit"]);
    expect(topics["feat/next"]).toEqual(["src/brand-new.ts:git_commit", "src/fresh.ts:tool_edit"]);
  });

  test("the same path in another worktree is never held for this one: each worktree's copy files under its own topic", async () => {
    // Arrange: wt0's topic edited src/same.ts; wt1 changes its own src/same.ts through a shell
    const world = await nickShape("m5-two-roots", 2);
    const [a = "", b = ""] = world.siblings;
    await sessionStart(world);
    await edit(world, await writeRepoFile(a, "src/same.ts", "export const a = 1;\n"));
    await edit(world, await writeRepoFile(b, "src/b-own.ts", "export const b = 1;\n"));
    await writeRepoFile(b, "src/same.ts", "export const b2 = 1;\n");

    // Act
    await stop(world);

    // Assert
    const topics = filesByTopic(await spooled(world));
    expect(topics["feat/topic-0"]).toEqual(["src/same.ts:tool_edit"]);
    expect(topics["feat/topic-1"]).toEqual(["src/b-own.ts:tool_edit", "src/same.ts:git_diff"]);
  });
});

describe("M7: a topic overflow counts each file once, never each sweep of it", () => {
  test("a sibling past the topic cap: three dirty files, two Stops — three counted, and a denylisted one not at all", async () => {
    // Arrange: a life that has already opened every topic it may, and a fourth
    // dirty file the denylist refuses
    const world = await nickShape("m7-overflow", 1);
    const [sibling = ""] = world.siblings;
    await sessionStart(world);
    await updateSessionState(world.home, SESSION_ID, (fresh) => ({
      ...fresh,
      topicContexts: Array.from({ length: MAX_TOPICS_PER_SESSION }, (_, index) => fullTopic(fresh, index)),
    }));
    for (const name of ["o1", "o2", "o3"]) {
      await writeRepoFile(sibling, `src/${name}.ts`, `export const ${name} = 1;\n`);
    }
    await writeRepoFile(sibling, ".env.local", "TOKEN=synthetic\n");

    // Act: the shell marks the sibling, then two turns end
    await bash(world, `cd ${sibling} && touch src/o1.ts`);
    await stop(world);
    await bash(world, `cd ${sibling} && touch src/o1.ts`);
    await stop(world);

    // Assert: the three files reached the session's own context once each, and three were counted
    const losses = await readCaptureLosses(world.home, repoKey(DEAD_HUB_URL, REPO_ID));
    expect(losses.byKind["topic_overflow"]).toBe(3);
    expect((await readSessionState(world.home, SESSION_ID))?.topicOverflowCount).toBe(3);
    expect(filesByTopic(await spooled(world))["(session)"]).toEqual(["src/o1.ts:git_diff", "src/o2.ts:git_diff", "src/o3.ts:git_diff"]);
  });
});

describe("M8: a large untracked dump hides no real new file, and is counted once", () => {
  test("a node_modules nothing ignores and a cache past the bound: the real file is captured, one drop booked over two Stops", async () => {
    // Arrange: a sibling whose `src/` the repo tracks, an unignored
    // node_modules (denylisted), an unignored cache past the candidate bound
    // (not denylisted, written before the session), and one real new file
    // in `src/` that sorts after both
    const world = await nickShape("m8-dump", 1);
    const [sibling = ""] = world.siblings;
    await writeRepoFile(sibling, "src/index.ts", "export {};\n");
    await commitAll(sibling, "tracked src");
    await writeMany(join(sibling, "node_modules", "pkg"), DUMP_FILES, "index");
    await writeMany(join(sibling, ".cache", "blobs"), MAX_GIT_TOUCH_CANDIDATES + DUMP_FILES, "blob", BEFORE_THE_SESSION);
    await sessionStart(world);
    await edit(world, await writeRepoFile(sibling, "src/edited.ts", "export const e = 1;\n"));
    await writeRepoFile(sibling, "src/zz-real-new.ts", "export const z = 1;\n");

    // Act
    await bash(world, `cd ${sibling} && ./generate.sh`);
    await stop(world);
    await bash(world, `cd ${sibling} && ./generate.sh`);
    await stop(world);

    // Assert: the real file is the topic's; the dump is one booked cut, not one per path per Stop
    const files = filesByTopic(await spooled(world))["feat/topic-0"] ?? [];
    expect(files).toContain("src/zz-real-new.ts:git_diff");
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect((await readDropDetail(world.home, repoKey(DEAD_HUB_URL, REPO_ID))).byReason["capture-capped"]).toBe(1);
  });
});

describe("review mutation #1: a sibling's window opens at its first touch, not at the session's start", () => {
  test("work done in a sibling an hour before the session first touched it is never this session's", async () => {
    // Arrange: a session started two hours ago; an hour ago, before it ever
    // touched the sibling, somebody committed there and left a new file
    const world = await nickShape("mut1-window", 1);
    const [sibling = ""] = world.siblings;
    await sessionStart(world);
    await updateSessionState(world.home, SESSION_ID, (fresh) => ({ ...fresh, startedAt: hoursAgo(2) }));
    const anHourAgo = hoursAgo(1);
    await writeRepoFile(sibling, "src/committed-before.ts", "export const c = 1;\n");
    await git(sibling, ["add", "src/committed-before.ts"]);
    await Bun.$`git -C ${sibling} commit -q -m before`.env({ ...process.env, GIT_AUTHOR_DATE: anHourAgo, GIT_COMMITTER_DATE: anHourAgo });
    const leftBefore = await writeRepoFile(sibling, "src/left-before.ts", "export const l = 1;\n");
    await utimes(leftBefore, new Date(anHourAgo), new Date(anHourAgo));

    // Act: the session's first touch of the sibling, then the turn ends
    await edit(world, await writeRepoFile(sibling, "src/now.ts", "export const n = 1;\n"));
    await stop(world);

    // Assert
    expect(filesByTopic(await spooled(world))["feat/topic-0"]).toEqual(["src/now.ts:tool_edit"]);
  });
});

describe("M3: a reftable repository files its work under the session, and the lane still sweeps it", () => {
  test("no `.invalid` topic; the sibling's commit and new file are still read", async () => {
    // Arrange: the owner's shape in a reftable repo — every HEAD file says `ref: refs/heads/.invalid`
    const world = await nickShape("m3-reftable", 1, "reftable");
    const [sibling = ""] = world.siblings;
    await sessionStart(world);
    await edit(world, await writeRepoFile(sibling, "src/edited.ts", "export const e = 1;\n"));
    await writeRepoFile(sibling, "src/committed.ts", "export const c = 1;\n");
    await commitAll(sibling, "in a reftable worktree");
    await writeRepoFile(sibling, "src/untracked.ts", "export const u = 1;\n");

    // Act
    await stop(world);

    // Assert: one context — the session's own — holding the edit, the commit and the new file
    const records = await spooled(world);
    const titles = records.filter((record) => record.kind === "work_context").map((record) => record.body.title ?? "");
    expect(titles.some((title) => title.includes(".invalid"))).toBe(false);
    expect(filesByTopic(records)).toEqual({
      "(session)": ["src/committed.ts:git_commit", "src/edited.ts:tool_edit", "src/untracked.ts:git_diff"],
    });
  });
});
