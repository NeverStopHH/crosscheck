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
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const nickShape = async (label: string, count: number): Promise<World> => {
  const main = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
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
