/**
 * The SECOND evidence lane (regression-guard Stage 1): a bounded
 * `git diff --name-only HEAD` at Stop.
 *
 * WHY THERE ARE TWO LANES. The tool lane only ever sees what the host
 * reports as an edit — the Claude matcher is `Edit|Write|MultiEdit|
 * NotebookEdit` — so `sed -i`, codemods, `prettier --write` and generators
 * leave NO trace in it at all. A `suspect` ranking built on that lane alone
 * names the session that used Edit with full confidence while the codemod
 * session is invisible. This lane sees the file change and cannot say which
 * tool made it; together they are honest, which is why the source is a LABEL
 * on the row rather than a merge.
 *
 * WHY MTIME. `git diff HEAD` reports every uncommitted change in the
 * worktree, including work that was already dirty before this session
 * started. Attributing a teammate's — or yesterday's — half-finished edit to
 * this session is exactly the false accusation the falsifier gate and the
 * lift ranking exist to avoid, so a path only counts when the file was
 * modified after the session began.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm, utimes } from "node:fs/promises";
import { join } from "node:path";

import type { DenylistConfig } from "../src/capture/denylist.ts";
import { captureGitTouches, readGitTouches } from "../src/flows/capture-git-touches.ts";
import type { GitTouchesOutcome } from "../src/flows/capture-git-touches.ts";
import { readSpoolLines } from "../src/spool/files.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "./helpers.ts";

const REPO_KEY = "hub__github.com__acme__api";
const NOW = new Date("2026-08-25T12:00:00.000Z");
const SESSION_START = new Date("2026-08-25T11:00:00.000Z");
const BEFORE_SESSION = new Date("2026-08-25T10:00:00.000Z");

const paths: string[] = [];

interface SpooledTarget {
  readonly kind: string;
  readonly body: { readonly value: string; readonly source?: string };
}

const fixture = async (label: string): Promise<{ repo: string; home: string }> => {
  const repo = await makeRepo(label);
  const home = await makeHome(label);
  paths.push(repo, home);
  await writeRepoFile(repo, "src/workbench/usePlayback.ts", "export const a = 1;\n");
  await writeRepoFile(repo, "src/workbench/Controls.tsx", "export const b = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "workbench"]);
  return { repo, home };
};

const capture = (
  repo: string,
  home: string,
  overrides: Record<string, unknown> = {},
): Promise<GitTouchesOutcome> =>
  captureGitTouches({
    home,
    repoKey: REPO_KEY,
    hostSessionKey: "cc_session",
    repoRoot: repo,
    workContextId: "wc_1",
    producer: {
      developerId: "dev_1",
      agentKind: "claude-code",
      sessionId: "cc_session",
    },
    seenTargets: [],
    denylist: null,
    since: SESSION_START,
    now: NOW,
    ...overrides,
  });

const spooledTargets = async (home: string): Promise<readonly SpooledTarget[]> =>
  (await readSpoolLines(home, REPO_KEY))
    .map((line) => JSON.parse(line) as SpooledTarget)
    .filter((record) => record.kind === "target");

afterAll(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe("captureGitTouches", () => {
  test("records an uncommitted change no Edit tool ever reported", async () => {
    // Arrange: the codemod case — the file changed, and the host saw nothing.
    const { repo, home } = await fixture("git-touch-basic");
    await writeRepoFile(repo, "src/workbench/usePlayback.ts", "export const a = 2;\n");

    // Act
    const outcome = await capture(repo, home);

    // Assert
    expect(outcome.paths).toEqual(["src/workbench/usePlayback.ts"]);
    const targets = await spooledTargets(home);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.body.value).toBe("src/workbench/usePlayback.ts");
    // LABELLED, not merged: the row says which lane saw it.
    expect(targets[0]?.body.source).toBe("git_diff");
  });

  test("ignores work that was already dirty before this session started", async () => {
    // Arrange: yesterday's half-finished edit, still uncommitted.
    const { repo, home } = await fixture("git-touch-stale");
    const stale = join(repo, "src/workbench/Controls.tsx");
    await writeRepoFile(repo, "src/workbench/Controls.tsx", "export const b = 2;\n");
    await utimes(stale, BEFORE_SESSION, BEFORE_SESSION);

    // Act
    const outcome = await capture(repo, home);

    // Assert: attributing it to this session would be a false accusation.
    expect(outcome.paths).toEqual([]);
    expect(await spooledTargets(home)).toHaveLength(0);
  });

  test("skips files the tool lane already recorded — one row, one source", async () => {
    // Arrange
    const { repo, home } = await fixture("git-touch-seen");
    await writeRepoFile(repo, "src/workbench/usePlayback.ts", "export const a = 3;\n");

    // Act
    const outcome = await capture(repo, home, {
      seenTargets: ["src/workbench/usePlayback.ts"],
    });

    // Assert
    expect(outcome.paths).toEqual([]);
  });

  test("applies the hot-file denylist, exactly as the tool lane does", async () => {
    // Arrange: a lockfile every session touches would drown the signal, and
    // the second lane must not be a way around the first lane's filter.
    const { repo, home } = await fixture("git-touch-denylist");
    await writeRepoFile(repo, "bun.lock", "{}\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "lockfile"]);
    await writeRepoFile(repo, "bun.lock", "{ }\n");

    // Act
    const outcome = await capture(repo, home);

    // Assert
    expect(outcome.paths).toEqual([]);
  });

  test("returns nothing, and spools nothing, outside a git repository", async () => {
    // Arrange: fail open — a hook that cannot ask git records no lane at all
    // rather than guessing.
    const home = await makeHome("git-touch-norepo");
    paths.push(home);

    // Act
    const outcome = await capture("/nonexistent-repo-root", home);

    // Assert
    expect(outcome.paths).toEqual([]);
  });

  test("says git DID NOT ANSWER, so a deadline is not read as a clean tree", async () => {
    // Arrange: no repository, so `git diff` cannot answer at all — the same
    // shape a GIT_TOUCHES_TIMEOUT_MS deadline produces on a loaded machine.
    const home = await makeHome("git-touch-unavailable");
    paths.push(home);

    // Act
    const outcome = await capture("/nonexistent-repo-root", home);

    // Assert: an empty result and an UNANSWERED result are different facts.
    // Collapsing them makes a lane that times out every turn look exactly
    // like a lane watching a clean worktree — fail-silent-dead, which the
    // Stop hook then reports as health (hooks/stop.ts counts this as a skip).
    expect(outcome.unavailable).toBe(true);
  });

  test("says git ANSWERED when the tree is merely clean", async () => {
    // Arrange: a real repository with nothing uncommitted.
    const { repo, home } = await fixture("git-touch-clean");

    // Act
    const outcome = await capture(repo, home);

    // Assert: the other half of the distinction. Without this the flag could
    // be hard-coded true and the test above would still pass.
    expect(outcome.paths).toEqual([]);
    expect(outcome.unavailable).toBe(false);
  });
});

describe("the untracked listing (review M8)", () => {
  /** The lane's read of `repo` with the new files asked for, before anything is spooled. */
  const readUntracked = (repo: string, home: string, denylist: DenylistConfig | null = null) =>
    readGitTouches({
      home,
      repoKey: REPO_KEY,
      hostSessionKey: "cc_session",
      repoRoot: repo,
      workContextId: "wc_1",
      producer: { developerId: "dev_1", agentKind: "claude-code", sessionId: "cc_session" },
      seenTargets: [],
      denylist,
      since: SESSION_START,
      now: NOW,
      includeUntracked: true,
    });

  test("never lists a denylisted directory nothing ignores — the config's own included", async () => {
    // Arrange: an unignored node_modules and a directory only the config denies
    const { repo, home } = await fixture("git-touch-untracked-deny");
    await writeRepoFile(repo, "node_modules/pkg/index.js", "module.exports = 1;\n");
    await writeRepoFile(repo, "scratch-out/run.log", "x\n");
    await writeRepoFile(repo, "src/workbench/New.tsx", "export const n = 1;\n");

    // Act
    const read = await readUntracked(repo, home, { mode: "extend", patterns: ["**/scratch-out/**"] });

    // Assert
    expect(read?.fresh).toEqual(["src/workbench/New.tsx"]);
  });

  test("lists new files in a directory the repo tracks before a new directory of its own", async () => {
    // Arrange: `aaa-dump/` sorts before `src/` and the repo has never tracked it
    const { repo, home } = await fixture("git-touch-untracked-order");
    await writeRepoFile(repo, "aaa-dump/one.bin.txt", "x\n");
    await writeRepoFile(repo, "src/workbench/New.tsx", "export const n = 1;\n");
    await writeRepoFile(repo, "top-level.md", "x\n");

    // Act
    const read = await readUntracked(repo, home);

    // Assert
    expect(read?.fresh).toEqual(["src/workbench/New.tsx", "top-level.md", "aaa-dump/one.bin.txt"]);
    expect(read?.isUntrackedCut).toBe(false);
  });
});
