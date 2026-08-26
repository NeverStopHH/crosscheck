/**
 * Cursor edits in a LINKED GIT WORKTREE are captured — the #17 fix on this
 * host, mirrored on connector-claude/test/worktree-capture.test.ts.
 *
 * RED ON MAIN, MEASURED: a conversation registered at checkout A that edits a
 * file in worktree B of the SAME repo captured 0 targets and booked 0 counters
 * of any kind, while a control edit inside A captured normally — the H1 shape
 * (371 worktree edits → 0 targets) with nothing to make it visible, because
 * `handlers/file-edit.ts` never passed `resolveRoot` and booked no
 * capture health at all.
 *
 * afterFileEdit is the ONE capture row on this host, deliberately: Cursor's
 * `postToolUse` also carries `tool_input` and could see Write paths, but
 * capturing there would double-count `editToolFires` against this event for
 * one edit. It stays a failure/injection row.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS } from "@crosscheck/connector-core/constants.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { realpathBestEffort } from "@crosscheck/connector-core/config/paths.ts";
import { readSpoolLines } from "@crosscheck/connector-core/spool/files.ts";
import { cursorHostSessionKey } from "@crosscheck/connector-core/state/host-session-key.ts";
import {
  deriveSessionState,
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { runCursorHook } from "../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const REMOTE = "git@github.com:acme/api.git";
const CONVERSATION_ID = "conv-worktree";
const HOST_KEY = cursorHostSessionKey(CONVERSATION_ID);
const EDITED_FILE = "src/auth/refresh.ts";
/** Port 1 refuses instantly: capture spools locally, the flush fails open. */
const DEAD_HUB_URL = "http://127.0.0.1:1";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const env = (home: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_TIMEOUT_MS: "4000",
  CROSSCHECK_SSH_CANONICALIZE: "off",
});

const sessionState = (
  repoRoot: string,
  overrides: Partial<SessionState> = {},
): SessionState => ({
  ...deriveSessionState({
    hostSessionKey: HOST_KEY,
    repoId: REPO_ID,
    repoRoot,
    hubUrl: DEAD_HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
  }),
  ...overrides,
});

/**
 * The documented afterFileEdit payload: the common base plus `file_path` and
 * `edits[]`. The edit STRINGS are recorded exactly as the host sends them —
 * nothing here parses them (the privacy suite proves it) — and no `cwd`,
 * because the documented input for this event carries none.
 */
const editPayload = (
  workspaceRoot: string,
  absoluteFile: string,
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    conversation_id: CONVERSATION_ID,
    generation_id: "gen-1",
    hook_event_name: "afterFileEdit",
    cursor_version: "3.13.25",
    workspace_roots: [workspaceRoot],
    user_email: "dev@example.com",
    transcript_path: "/home/dev/.cursor/transcripts/conv-worktree.jsonl",
    file_path: absoluteFile,
    edits: [{ old_string: "const limit = 100;", new_string: "const limit = 250;" }],
    ...extra,
  });

const targetsIn = async (home: string): Promise<readonly string[]> => {
  const lines = await readSpoolLines(home, repoKey(DEAD_HUB_URL, REPO_ID));
  return lines
    .map((line) => JSON.parse(line) as { kind: string; body?: { value?: string } })
    .filter((record) => record.kind === "target")
    .map((record) => record.body?.value ?? "");
};

/** A repo with a COMMITTED config and a linked worktree carrying it too. */
const repoWithWorktree = async (
  label: string,
  remote = REMOTE,
): Promise<{ main: string; worktree: string; home: string }> => {
  const main = await makeRepo(label, { remote });
  await writeFile(
    join(main, ".crosscheck.json"),
    `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
    "utf8",
  );
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "config"]);
  const worktree = join(await mkdtemp(join(tmpdir(), `cx-cur-wt-${label}-`)), "feature");
  await git(main, ["worktree", "add", worktree, "HEAD"]);
  const home = await makeHome(label);
  paths.push(main, join(worktree, ".."), home);
  return { main, worktree, home };
};

describe("a cursor conversation at checkout A editing a file in worktree B", () => {
  test("captures the worktree file under its repo-relative id", async () => {
    // Arrange
    const { main, worktree, home } = await repoWithWorktree("cur-d1");
    await writeRepoFile(worktree, EDITED_FILE, "export const a = 1;\n");
    await writeSessionState(home, sessionState(main));

    // Act: the workspace is checkout A, the edited file lives in worktree B
    const stdout = await runCursorHook(
      "afterFileEdit",
      editPayload(main, join(worktree, EDITED_FILE)),
      env(home),
    );

    // Assert: the ladder still answers no-directive JSON, and the target landed
    expect(stdout).toBe("{}");
    expect(await targetsIn(home)).toEqual([EDITED_FILE]);
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.seenTargets).toEqual([EDITED_FILE]);
    expect(state?.editToolFires).toBe(1);
    expect(state?.targetsCapturedCount).toBe(1);
    expect(state?.lastPostToolUseTool).toBe("afterFileEdit");
    expect(state?.lastEditedPath).toBe(join(worktree, EDITED_FILE));
    expect(state?.lastEditedPathResolvedAgainst).not.toBeNull();
    expect(state?.outsideRootDrops).toBe(0);
    expect(state?.foreignRepoDrops).toBe(0);
  });

  test("captures a file in worktree C when the workspace root is worktree B", async () => {
    // Arrange: the D3 geometry — the workspace's own root contains neither
    // the session root nor the edited file, so the free identity candidate
    // governs nothing here and the walk to C's own root must do the work.
    const { main, worktree, home } = await repoWithWorktree("cur-d3");
    const third = join(await mkdtemp(join(tmpdir(), "cx-cur-wt-c-")), "featC");
    await git(main, ["worktree", "add", third, "HEAD"]);
    paths.push(join(third, ".."));
    await writeRepoFile(third, EDITED_FILE, "export const a = 1;\n");
    await writeSessionState(home, sessionState(main));

    // Act
    const stdout = await runCursorHook(
      "afterFileEdit",
      editPayload(worktree, join(third, EDITED_FILE)),
      env(home),
    );

    // Assert
    expect(stdout).toBe("{}");
    expect(await targetsIn(home)).toEqual([EDITED_FILE]);
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.outsideRootDrops).toBe(0);
    expect(state?.foreignRepoDrops).toBe(0);
  });

  test("a payload whose cwd is the empty string resolves exactly like one with no cwd", async () => {
    // Arrange: Cursor 3.13.25 sends `cwd: ""` on neighbouring tool events
    // (top level AND inside tool_input), and `??` folds undefined, not "". The
    // field is in our looseObject schema, and after #17 it feeds the connected
    // -root walk and both toRepoRelative calls — an empty one resolving
    // against the hook process's own cwd would silently drop the edit.
    //
    // THE PATH IS RELATIVE ON PURPOSE, and that is the whole test. With an
    // ABSOLUTE file_path this case passes with the fold DELETED, because
    // `resolve("", "/abs/x.ts")` is `/abs/x.ts` — the fold cannot be seen and
    // the guard pins nothing. A relative one is resolved against the empty
    // cwd, i.e. against the HOOK PROCESS's own working directory.
    const { main, home } = await repoWithWorktree("cur-empty-cwd");
    await writeRepoFile(main, EDITED_FILE, "export const a = 1;\n");
    await writeSessionState(home, sessionState(main));

    // Act: documented resolution is "relative to the event's cwd when
    // present, the workspace root else" — and an EMPTY cwd is not present
    const stdout = await runCursorHook(
      "afterFileEdit",
      editPayload(main, EDITED_FILE, { cwd: "" }),
      env(home),
    );

    // Assert: captured under its repo-relative path, and nothing dropped —
    // unfolded, the target list is empty and a drop is counted instead
    expect(stdout).toBe("{}");
    expect(await targetsIn(home)).toEqual([EDITED_FILE]);
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.outsideRootDrops).toBe(0);
    expect(state?.foreignRepoDrops).toBe(0);
  });
});

describe("cursor drops that must stay drops, now counted (#17)", () => {
  test("a file in a linked worktree of a DIFFERENT connected repo is a foreign drop", async () => {
    // Arrange
    const { main, home } = await repoWithWorktree("cur-foreign");
    const other = await repoWithWorktree("cur-foreign-web", "git@github.com:acme/web.git");
    await writeRepoFile(other.worktree, "src/app.ts", "export const b = 2;\n");
    await writeSessionState(home, sessionState(main));

    // Act
    const stdout = await runCursorHook(
      "afterFileEdit",
      editPayload(main, join(other.worktree, "src/app.ts")),
      env(home),
    );

    // Assert: counted as FOREIGN, not as outside-root — doctor's cause must
    // stay the true one, and the foreign root is cached under ITS repo id so
    // a repeated touch of it costs no git either
    expect(stdout).toBe("{}");
    expect(await targetsIn(home)).toEqual([]);
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(state?.outsideRootDrops).toBe(0);
    expect(state?.editToolFires).toBe(1);
    expect(
      state?.knownWorktreeRoots.some((entry) => entry.repoId === "github.com/acme/web"),
    ).toBe(true);
  });

  test("a loose file under no connected root is an outside-root drop", async () => {
    // Arrange
    const { main, home } = await repoWithWorktree("cur-outside");
    const loose = await mkdtemp(join(tmpdir(), "cx-cur-loose-"));
    await writeFile(join(loose, "x.ts"), "export const c = 3;\n", "utf8");
    paths.push(loose);
    await writeSessionState(home, sessionState(main));

    // Act
    const stdout = await runCursorHook(
      "afterFileEdit",
      editPayload(main, join(loose, "x.ts")),
      env(home),
    );

    // Assert: "1 fire → 0 targets" with the cause named
    expect(stdout).toBe("{}");
    expect(await targetsIn(home)).toEqual([]);
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.outsideRootDrops).toBe(1);
    expect(state?.foreignRepoDrops).toBe(0);
    expect(state?.editToolFires).toBe(1);
    expect(state?.lastEditedPathResolvedAgainst).toBeNull();
  });

  test("a worktree checked out before the config was committed is OUTSIDE-root, not foreign", async () => {
    // Arrange: the walk requires the COMMITTED .crosscheck.json at the
    // worktree's own root, so a worktree pinned to an earlier commit resolves
    // to no root at all. That is the documented meaning — an unresolvable root
    // is not evidence of a second repo — and it is pinned here so nobody
    // later "fixes" it into a foreign drop.
    const main = await makeRepo("cur-preconfig", { remote: REMOTE });
    const before = join(await mkdtemp(join(tmpdir(), "cx-cur-wt-pre-")), "old");
    await git(main, ["worktree", "add", before, "HEAD"]);
    await writeFile(
      join(main, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await git(main, ["add", "."]);
    await git(main, ["commit", "-m", "config"]);
    const home = await makeHome("cur-preconfig");
    paths.push(main, join(before, ".."), home);
    await writeRepoFile(before, EDITED_FILE, "export const a = 1;\n");
    await writeSessionState(home, sessionState(main));

    // Act
    await runCursorHook(
      "afterFileEdit",
      editPayload(main, join(before, EDITED_FILE)),
      env(home),
    );

    // Assert
    expect(await targetsIn(home)).toEqual([]);
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.outsideRootDrops).toBe(1);
    expect(state?.foreignRepoDrops).toBe(0);
  });
});

describe("a foreign-repo workspace still shows the edit that caused the drop", () => {
  test("books the edit-tool fire alongside the foreign drop", async () => {
    // Arrange: the conversation registered in repo A, but this event's
    // workspace resolves to a DIFFERENT connected repo — the first-wins guard
    // in requireSessionState returns before capture. Without the fire being
    // counted there, such a session prints `0 edit-tool fires -> 0 targets`
    // and PASSes: the exact silence the counters exist to end, and the reason
    // the Claude hook counts the fire before its own guard returns.
    const { main, home } = await repoWithWorktree("cur-foreign-ws");
    const other = await repoWithWorktree("cur-foreign-ws-web", "git@github.com:acme/web.git");
    await writeRepoFile(other.main, "src/app.ts", "export const b = 2;\n");
    await writeSessionState(home, sessionState(main));

    // Act: the WORKSPACE itself is the foreign repo
    const stdout = await runCursorHook(
      "afterFileEdit",
      editPayload(other.main, join(other.main, "src/app.ts")),
      env(home),
    );

    // Assert
    expect(stdout).toBe("{}");
    expect(await targetsIn(home)).toEqual([]);
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(state?.editToolFires).toBe(1);
    expect(state?.targetsCapturedCount).toBe(0);
    // ...and NAMES it. doctor renders the drop counts only inside its
    // `lastEditedPath !== null` branch, so a drop booked without these two
    // fields produces `N edit-tool fires -> 0 targets - last tool none yet -
    // last edited path resolved: no edit yet` with the drops invisible: a
    // WARN that contradicts itself and diagnoses nothing.
    expect(state?.lastPostToolUseTool).toBe("afterFileEdit");
    expect(state?.lastEditedPath).toBe(join(other.main, "src/app.ts"));
    expect(state?.lastEditedPathResolvedAgainst).toBeNull();
  });

  test("a non-edit cursor event never inflates the fire counter", async () => {
    // Arrange: the same foreign-workspace shape on the shell row — that event
    // is not an edit, so it may book the drop and nothing else.
    const { main, home } = await repoWithWorktree("cur-foreign-shell");
    const other = await repoWithWorktree("cur-foreign-shell-web", "git@github.com:acme/web.git");
    await writeSessionState(home, sessionState(main));

    // Act
    await runCursorHook(
      "afterShellExecution",
      JSON.stringify({
        conversation_id: CONVERSATION_ID,
        hook_event_name: "afterShellExecution",
        workspace_roots: [other.main],
        command: "bun test",
        output: "error TS2304: cannot find name 'limiter' at build step 7",
        exit_code: 1,
      }),
      env(home),
    );

    // Assert
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(state?.editToolFires).toBe(0);
    // ...and it is not an edit, so it names no edited path either: the #18
    // line must keep describing the last EDIT, not the last event.
    expect(state?.lastEditedPath).toBeNull();
    expect(state?.lastPostToolUseTool).toBeNull();
  });
});

describe("a worktree PATH that is torn down and rebuilt from another repo", () => {
  test("does not capture the new repo's file under this repo", async () => {
    // Arrange: the fixed-path convention (~/worktrees/feature) plus a long
    // conversation. The cache is keyed by the realpath'd DIRECTORY, so a
    // positive answer that stood forever meant the second checkout inherited
    // the first one's repo id: another repo's file was spooled into this
    // repo's work context under a repo-relative path, and BOTH drop counters
    // stayed 0 — nothing on `status` or `doctor` said a word.
    const { main, worktree, home } = await repoWithWorktree("cur-reuse");
    await writeRepoFile(worktree, EDITED_FILE, "export const a = 1;\n");
    await writeSessionState(home, sessionState(main));

    // Act 1: one edit in worktree B caches its root as THIS repo
    await runCursorHook(
      "afterFileEdit",
      editPayload(main, join(worktree, EDITED_FILE)),
      env(home),
    );
    const cached = await readSessionState(home, HOST_KEY);

    // Act 2: the same PATH is torn down and stood up again from another repo
    await git(main, ["worktree", "remove", "--force", worktree]);
    const other = await repoWithWorktree("cur-reuse-web", "git@github.com:acme/web.git");
    await git(other.main, ["worktree", "add", worktree, "HEAD"]);
    await writeRepoFile(worktree, "src/secret-of-other-repo.ts", "export const b = 2;\n");
    await runCursorHook(
      "afterFileEdit",
      editPayload(main, join(worktree, "src/secret-of-other-repo.ts")),
      env(home),
    );

    // Assert: the first edit is captured, the second is a FOREIGN drop — the
    // counter doctor explains as "a multi-repo workspace's touches of its
    // second repo", which is exactly what this is
    expect(cached?.knownWorktreeRoots.some((entry) => entry.repoId === REPO_ID)).toBe(true);
    expect(await targetsIn(home)).toEqual([EDITED_FILE]);
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(state?.editToolFires).toBe(2);
    expect(state?.targetsCapturedCount).toBe(1);
  });
});

describe("the session's worktree-root cache is fed to the resolver", () => {
  test("a cached answer decides the touch, so no root is judged by git twice", async () => {
    // Arrange: worktree B really belongs to THIS repo, but the session state
    // already carries a cached answer saying it belongs to another. If the
    // connector feeds its cache to the resolver, the cached answer decides and
    // the touch is a foreign drop; if it does not, git re-judges the root and
    // the file is captured. Nothing else in the fixture differs.
    const { main, worktree, home } = await repoWithWorktree("cur-cache");
    await writeRepoFile(worktree, EDITED_FILE, "export const a = 1;\n");
    await writeSessionState(
      home,
      sessionState(main, {
        knownWorktreeRoots: [
          {
            root: await realpathBestEffort(worktree),
            repoId: "github.com/acme/somewhere-else",
            attempts: 1,
            // UNSTAMPED, like every entry an older state file holds: the
            // answer stands, which is what this test is about.
            stamp: null,
          },
        ],
      }),
    );

    // Act
    await runCursorHook(
      "afterFileEdit",
      editPayload(main, join(worktree, EDITED_FILE)),
      env(home),
    );

    // Assert
    expect(await targetsIn(home)).toEqual([]);
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.foreignRepoDrops).toBe(1);
  });

  test("an UNRESOLVABLE root is retried a bounded number of times, then stands", async () => {
    // Arrange: a directory that IS a connected root by the walk's rule (a
    // `.git` entry beside a readable `.crosscheck.json`) but whose identity
    // git cannot resolve — a broken worktree link. Three edits in it: with the
    // cache fed, the attempt budget is spent and STOPS at
    // MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS; without it, every edit re-resolves
    // and the recorded attempts never rise above one. This is the count
    // assertion the clock cannot make.
    const { main, home } = await repoWithWorktree("cur-attempts");
    const broken = await mkdtemp(join(tmpdir(), "cx-cur-broken-"));
    paths.push(broken);
    await writeFile(join(broken, ".git"), "gitdir: /nowhere/at/all\n", "utf8");
    await writeFile(
      join(broken, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(broken, "x.ts"), "export const c = 3;\n", "utf8");
    await writeSessionState(home, sessionState(main));

    // Act
    for (let touch = 0; touch < 3; touch += 1) {
      await runCursorHook(
        "afterFileEdit",
        editPayload(main, join(broken, "x.ts")),
        env(home),
      );
    }

    // Assert
    const state = await readSessionState(home, HOST_KEY);
    const entry = state?.knownWorktreeRoots.find(
      (row) => row.repoId === null,
    );
    expect(entry).toBeDefined();
    expect(entry?.attempts).toBe(MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS);
    expect(state?.outsideRootDrops).toBe(3);
    expect(state?.foreignRepoDrops).toBe(0);
    expect(state?.editToolFires).toBe(3);
  });
});
