/**
 * THE GIT LANE OVER EVERY ROOT THE SESSION TOUCHED, through the real hooks
 * (DESIGN.md "One session, many topics"; core flows/git-lane.ts).
 *
 * The owner's shape: one session started in a checkout DETACHED at an old
 * commit, its work done in sibling worktrees on their own branches, much of it
 * through a shell. Pinned here:
 *
 *   - a shell's `cp` and `git commit` in a sibling worktree, and a new file
 *     git does not track yet, are captured at the next Stop — under that
 *     worktree's TOPIC, not the session's start checkout;
 *   - a teammate's commit on the same branch is never this session's;
 *   - SubagentStop sweeps the subagent's own root;
 *   - with eight roots to sweep, Stop stays inside its budget and the lane is
 *     never silently nothing.
 *
 * A dead hub (port 1) keeps every record in the spool, where it is read back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_GIT_LANE_ROOTS } from "@crosscheck/connector-core/constants.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "topic-git-lane-uuid";
const DEAD_HUB_URL = "http://127.0.0.1:1";
/** Generous where a test asserts WHAT the lane records rather than whether a starved hook could afford it. */
const WIDE_TIMEOUT_MS = "8000";
/** Stop's own default envelope is 800 ms; this ceiling is spawn variance on a loaded box, as in stop-git-touches.test.ts. */
const STOP_RETURN_CEILING_MS = 3000;
/** Eight roots swept: the session's own and seven siblings — MAX_GIT_LANE_ROOTS. */
const SIBLINGS_MEASURED = MAX_GIT_LANE_ROOTS - 1;

const paths: string[] = [];

/** An author date two hours back: history the session found, not work it did. */
const BEFORE_THE_SESSION = new Date(Date.now() - 7_200_000).toISOString();

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

interface Fixture {
  readonly main: string;
  readonly home: string;
  readonly siblings: readonly string[];
}

const env = (home: string, timeoutMs?: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_SSH_CANONICALIZE: "off",
  PATH: process.env["PATH"],
  ...(timeoutMs === undefined ? {} : { CROSSCHECK_TIMEOUT_MS: timeoutMs }),
});

/** A connected repo whose start checkout is detached, and `count` sibling worktrees on branches of their own. */
const ownerShape = async (label: string, count: number): Promise<Fixture> => {
  const main = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  // The repo's history is from BEFORE the session: the lane reads this
  // developer's commits since the session began, in git's whole seconds.
  await git(main, ["commit", "--amend", "--no-edit", `--date=${BEFORE_THE_SESSION}`]);
  await writeFile(join(main, ".crosscheck.json"), `${JSON.stringify({ hubUrl: DEAD_HUB_URL })}\n`, "utf8");
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "config", `--date=${BEFORE_THE_SESSION}`]);
  const home = await makeHome(label);
  paths.push(main, home);
  const siblings: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const parent = await mkdtemp(join(tmpdir(), `cx-lane-${label}-`));
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

// The set-up hooks run on the wide envelope: a first touch of a root pays its
// identity in git, and a loaded machine must not turn the arrangement into a
// budget measurement — the default envelope is measured on Stop alone, below.
const sessionStart = (fix: Fixture): Promise<string> =>
  runHook(
    "session-start",
    hookPayload(fix.main, { hook_event_name: "SessionStart", source: "startup" }),
    env(fix.home, WIDE_TIMEOUT_MS),
  );

const edit = (fix: Fixture, file: string): Promise<string> =>
  runHook(
    "post-tool-use",
    hookPayload(fix.main, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file }, tool_response: {} }),
    env(fix.home, WIDE_TIMEOUT_MS),
  );

const stop = (fix: Fixture, timeoutMs: string | undefined = WIDE_TIMEOUT_MS): Promise<string> =>
  runHook("stop", hookPayload(fix.main, { hook_event_name: "Stop", stop_hook_active: false }), env(fix.home, timeoutMs));

interface SpooledRecord {
  readonly kind: string;
  readonly body: { readonly id?: string; readonly workContextId?: string; readonly value?: string; readonly source?: string; readonly branch?: string };
}

const spooled = async (fix: Fixture): Promise<readonly SpooledRecord[]> =>
  (await readSpoolLines(fix.home, repoKey(DEAD_HUB_URL, REPO_ID))).map((line) => JSON.parse(line) as SpooledRecord);

/** The id of the topic context spooled for `branch`. */
const topicIdOf = (records: readonly SpooledRecord[], branch: string): string | undefined =>
  records.find((record) => record.kind === "work_context" && record.body.branch === branch)?.body.id;

const targetsUnder = (records: readonly SpooledRecord[], workContextId: string | undefined): readonly (readonly [string, string])[] =>
  records
    .filter((record) => record.kind === "target" && record.body.workContextId === workContextId)
    .map((record) => [record.body.value ?? "", record.body.source ?? ""] as const)
    .sort(([left], [right]) => left.localeCompare(right));

describe("Stop sweeps every root the session touched", () => {
  test("a shell's cp and commit, a new untracked file — all under the worktree's topic; a teammate's commit never", async () => {
    // Arrange: the session edits one file in sibling 0, which makes the root
    // known; then a shell copies it and commits, writes a new file it never
    // adds, and a teammate commits on the same branch
    const fix = await ownerShape("lane-sweep", 1);
    const sibling = fix.siblings[0] ?? "";
    await sessionStart(fix);
    const edited = await writeRepoFile(sibling, "src/a.ts", "export const a = 1;\n");
    await edit(fix, edited);
    await copyFile(edited, join(sibling, "src/copied.ts"));
    await git(sibling, ["add", "-A"]);
    await git(sibling, ["commit", "-m", "copy a"]);
    await writeRepoFile(sibling, "src/untracked.ts", "export const u = 1;\n");
    await writeRepoFile(sibling, "src/theirs.ts", "export const t = 1;\n");
    await git(sibling, ["add", "src/theirs.ts"]);
    await git(sibling, ["-c", "user.email=teammate@example.com", "-c", "user.name=Teammate", "commit", "-m", "theirs"]);

    // Act
    await stop(fix);

    // Assert: everything the shell did is filed under feat/topic-0, by lane
    const records = await spooled(fix);
    const topic = topicIdOf(records, "feat/topic-0");
    expect(topic?.startsWith(`wc_cc_${SESSION_ID}~t`)).toBe(true);
    expect(targetsUnder(records, topic)).toEqual([
      ["src/a.ts", "tool_edit"],
      ["src/copied.ts", "git_commit"],
      ["src/untracked.ts", "git_diff"],
    ]);
    expect(records.some((record) => record.body.value === "src/theirs.ts")).toBe(false);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.gitLaneRan).toBe(1);
    expect(state?.gitLaneSkipped).toBe(0);
  });

  test("the next Stop records none of it again — one target per file per topic", async () => {
    // Arrange
    const fix = await ownerShape("lane-again", 1);
    const sibling = fix.siblings[0] ?? "";
    await sessionStart(fix);
    await edit(fix, await writeRepoFile(sibling, "src/a.ts", "export const a = 1;\n"));
    await writeRepoFile(sibling, "src/untracked.ts", "export const u = 1;\n");
    await stop(fix);
    const first = (await spooled(fix)).filter((record) => record.kind === "target").length;

    // Act
    await stop(fix);

    // Assert
    expect((await spooled(fix)).filter((record) => record.kind === "target").length).toBe(first);
  });
});

describe("SubagentStop sweeps the subagent's own root", () => {
  test("a subagent's shell work in a worktree the session never edited lands under that worktree's topic", async () => {
    // Arrange: the subagent ran in sibling 0 and only through a shell
    const fix = await ownerShape("lane-subagent", 1);
    const sibling = fix.siblings[0] ?? "";
    await sessionStart(fix);
    await writeRepoFile(sibling, "src/generated.ts", "export const g = 1;\n");
    await writeRepoFile(sibling, "src/committed.ts", "export const c = 1;\n");
    await git(sibling, ["add", "src/committed.ts"]);
    await git(sibling, ["commit", "-m", "subagent work"]);

    // Act
    await runHook(
      "subagent-stop",
      hookPayload(sibling, { hook_event_name: "SubagentStop", stop_hook_active: false, agent_id: "agent-1", agent_type: "general-purpose" }),
      env(fix.home, WIDE_TIMEOUT_MS),
    );

    // Assert
    const records = await spooled(fix);
    expect(targetsUnder(records, topicIdOf(records, "feat/topic-0"))).toEqual([
      ["src/committed.ts", "git_commit"],
      ["src/generated.ts", "git_diff"],
    ]);
  });

  test("a stop already continuing is the same subagent seen twice, and sweeps nothing", async () => {
    const fix = await ownerShape("lane-subagent-active", 1);
    const sibling = fix.siblings[0] ?? "";
    await sessionStart(fix);
    await writeRepoFile(sibling, "src/generated.ts", "export const g = 1;\n");
    await runHook(
      "subagent-stop",
      hookPayload(sibling, { hook_event_name: "SubagentStop", stop_hook_active: true }),
      env(fix.home, WIDE_TIMEOUT_MS),
    );
    expect((await spooled(fix)).filter((record) => record.kind === "target")).toHaveLength(0);
  });
});

describe("the lane's cost with eight roots", () => {
  const touchedSiblings = async (label: string, count: number): Promise<Fixture> => {
    const fix = await ownerShape(label, count);
    await sessionStart(fix);
    for (const [index, sibling] of fix.siblings.entries()) {
      await edit(fix, await writeRepoFile(sibling, `src/edited${String(index)}.ts`, "export const e = 1;\n"));
      await writeRepoFile(sibling, `src/shell${String(index)}.ts`, "export const s = 1;\n");
    }
    return fix;
  };

  const shellFilesOf = (records: readonly SpooledRecord[]): readonly string[] =>
    records
      .filter((record) => record.kind === "target" && record.body.source === "git_diff")
      .map((record) => record.body.value ?? "")
      .sort();

  test("on a wide envelope every root is swept, each file under its own topic", async () => {
    // Arrange
    const fix = await touchedSiblings("lane-eight-wide", SIBLINGS_MEASURED);

    // Act
    const started = Date.now();
    await stop(fix);
    const elapsedMs = Date.now() - started;

    // Assert
    const records = await spooled(fix);
    console.log(`[topic-git-lane] eight roots, wide envelope: Stop returned in ${String(elapsedMs)} ms`);
    expect(shellFilesOf(records)).toHaveLength(SIBLINGS_MEASURED);
    for (const index of fix.siblings.keys()) {
      const topic = topicIdOf(records, `feat/topic-${String(index)}`);
      expect(targetsUnder(records, topic).map(([value]) => value)).toContain(`src/shell${String(index)}.ts`);
    }
  });

  test("past the cap the next Stop sweeps the roots the last one left — in turn, never never", async () => {
    // Arrange: one sibling more than a Stop sweeps beside the session's own root
    const fix = await touchedSiblings("lane-rotation", MAX_GIT_LANE_ROOTS);

    // Act
    await stop(fix);
    const afterFirst = shellFilesOf(await spooled(fix));
    await stop(fix);
    const afterSecond = shellFilesOf(await spooled(fix));

    // Assert: the first Stop swept seven siblings, the second the one left
    expect(afterFirst).toHaveLength(MAX_GIT_LANE_ROOTS - 1);
    expect(afterSecond).toHaveLength(MAX_GIT_LANE_ROOTS);
  });

  test("on the default envelope Stop stays inside its budget, and the lane is never silently nothing", async () => {
    // Arrange: Stop's DEFAULT envelope — the number this test exists to measure
    const fix = await touchedSiblings("lane-eight-default", SIBLINGS_MEASURED);

    // Act
    const started = Date.now();
    await stop(fix, undefined);
    const elapsedMs = Date.now() - started;

    // Assert: the lane ran or the turn is counted a skip — exactly one — and
    // a skip is a counted loss; the hook returned well inside its ceiling
    const state = await readSessionState(fix.home, SESSION_ID);
    const ran = state?.gitLaneRan ?? 0;
    const skipped = state?.gitLaneSkipped ?? 0;
    console.log(
      `[topic-git-lane] eight roots, default envelope: Stop returned in ${String(elapsedMs)} ms · ran=${String(ran)} skipped=${String(skipped)} recorded=${String(state?.gitTouchCount ?? 0)}`,
    );
    expect(ran + skipped).toBe(1);
    expect(elapsedMs).toBeLessThan(STOP_RETURN_CEILING_MS);
  });
});
