/**
 * Edits in a LINKED GIT WORKTREE are captured (trial finding #17).
 *
 * A session registers at checkout A and then edits a file in worktree B of the
 * SAME repo. Before the fix, capture derived the target's repo-relative id
 * against `state.repoRoot` (= A) only, so the file — outside A — resolved to
 * null and the target was dropped, silently and uncounted (371 worktree edits
 * → 0 targets across the trial). Both shapes are pinned:
 *   D1  cwd at the main checkout A, file in worktree B;
 *   D2  cwd inside the worktree B, file in B;
 *   D3  cwd inside worktree B, file in a THIRD worktree C — the cwd's root is
 *       not the file's root, so the free D2 candidate must not be assumed for
 *       a path it does not contain.
 * And the drops that must STAY drops, now counted: a file in a DIFFERENT
 * connected repo (foreignRepoDrops) — from any cwd — and a loose file under no
 * connected root (outsideRootDrops).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";
import {
  activeTeammateSession,
  startHintHub,
} from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../connector-core/test/fixtures/hint-hub.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "worktree-uuid";
const EDITED_FILE = "src/auth/refresh.ts";
/** Port 1 refuses instantly: capture spools locally, the flush fails open. */
const DEAD_HUB_URL = "http://127.0.0.1:1";
const TIMEOUT_MS = "4000";

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const sessionState = (repoRoot: string): SessionState => ({
  hostSessionKey: SESSION_ID,
  crosscheckSessionId: `cc_${SESSION_ID}`,
  workContextId: `wc_cc_${SESSION_ID}`,
  repoId: REPO_ID,
  repoRoot,
  hubUrl: DEAD_HUB_URL,
  developerId: "dev_self",
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: null,
  seenTargets: [],
  deliveredHintRefs: [],
  deliveredHintHashes: [],
  tripwireAskedFiles: [],
  briefingSolvedRefs: [],
  foreignRepoDrops: 0,
  outsideRootDrops: 0,
  knownWorktreeRoots: [],
  editToolFires: 0,
  targetsCapturedCount: 0,
  lastTargetAt: null,
  lastPostToolUseTool: null,
  lastEditedPath: null,
  lastEditedPathResolvedAgainst: null,
  hintCandidatesSeen: 0,
  briefingPending: false,
  stopTurnCount: 0,
  summarizerFireCount: 0,
  summarizerLastFireTurn: null,
  summarizerEstimatedTokens: 0,
  summarizerNoneCount: 0,
  summarizerDraftCount: 0,
  summarizerFailCount: 0,
  summarizerLastFailure: null,
  summarizerUnparsedCount: 0,
  intentFireCount: 0,
  summarizerRejectCount: 0,
  summarizerLastRejection: null,
  workContextTitle: null,
  workContextStatus: null,
  intentNoneCount: 0,
  intentSetCount: 0,
  intentFailCount: 0,
  intentLastFailure: null,
  workContextIntent: null,
  ghostPending: false,
  ghostNoticeCount: 0,
  ghostFireCount: 0,
  ghostNoOverlapCount: 0,
  ghostNoHubAnswerCount: 0,
  ghostNoneCount: 0,
  ghostDraftCount: 0,
  ghostFailCount: 0,
  ghostLastFailure: null,
  probedFingerprints: [],
});

const env = (home: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
  CROSSCHECK_SSH_CANONICALIZE: "off",
});

const editPayload = (cwd: string, absoluteFile: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: absoluteFile },
    tool_response: {},
  });

/** A repo A with a committed config, a linked worktree B carrying it too. */
const repoWithWorktree = async (
  label: string,
  remote = "git@github.com:acme/api.git",
): Promise<{ main: string; worktree: string; home: string }> => {
  const main = await makeRepo(label, { remote });
  await writeFile(
    join(main, ".crosscheck.json"),
    `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
    "utf8",
  );
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "config"]);
  const worktree = join(await mkdtemp(join(tmpdir(), `cx-wt-${label}-`)), "feature");
  await git(main, ["worktree", "add", worktree, "HEAD"]);
  const home = await makeHome(label);
  paths.push(main, join(worktree, ".."), home);
  return { main, worktree, home };
};

/** One more linked worktree of an existing checkout, carrying the config. */
const addWorktree = async (main: string, label: string): Promise<string> => {
  const worktree = join(await mkdtemp(join(tmpdir(), `cx-wt-${label}-`)), label);
  await git(main, ["worktree", "add", worktree, "HEAD"]);
  paths.push(join(worktree, ".."));
  return worktree;
};

const targetsIn = async (home: string): Promise<readonly string[]> => {
  const lines = await readSpoolLines(home, repoKey(DEAD_HUB_URL, REPO_ID));
  return lines
    .map((line) => JSON.parse(line) as { kind: string; body?: { value?: string } })
    .filter((record) => record.kind === "target")
    .map((record) => record.body?.value ?? "");
};

describe("a session at checkout A editing a file in worktree B", () => {
  test("D1: cwd at the main checkout captures the worktree file", async () => {
    // Arrange
    const { main, worktree, home } = await repoWithWorktree("d1");
    await writeRepoFile(worktree, EDITED_FILE, "export const a = 1;\n");
    await writeSessionState(home, sessionState(main));

    // Act: cwd = A, the edited file lives in worktree B
    const stdout = await runHook(
      "post-tool-use",
      editPayload(main, join(worktree, EDITED_FILE)),
      env(home),
    );

    // Assert: the worktree file was captured under its repo-relative id
    expect(stdout).toBe("");
    expect(await targetsIn(home)).toEqual([EDITED_FILE]);
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.seenTargets).toEqual([EDITED_FILE]);
    expect(state?.editToolFires).toBe(1);
    expect(state?.targetsCapturedCount).toBe(1);
    expect(state?.lastEditedPathResolvedAgainst).not.toBeNull();
  });

  test("D2: cwd inside the worktree captures the worktree file", async () => {
    // Arrange
    const { main, worktree, home } = await repoWithWorktree("d2");
    await writeRepoFile(worktree, EDITED_FILE, "export const a = 1;\n");
    await writeSessionState(home, sessionState(main));

    // Act: cwd = B, the worktree itself
    const stdout = await runHook(
      "post-tool-use",
      editPayload(worktree, join(worktree, EDITED_FILE)),
      env(home),
    );

    // Assert
    expect(stdout).toBe("");
    expect(await targetsIn(home)).toEqual([EDITED_FILE]);
  });

  test("D3: cwd inside worktree B captures a file in worktree C", async () => {
    // Arrange: session bound to A, a second worktree C of the same repo, and a
    // hook whose cwd is worktree B — B contains neither the session root nor
    // the edited file, so the free identity candidate governs nothing here
    const { main, worktree, home } = await repoWithWorktree("d3");
    const third = await addWorktree(main, "d3-featC");
    await writeRepoFile(third, EDITED_FILE, "export const a = 1;\n");
    await writeSessionState(home, sessionState(main));

    // Act
    const stdout = await runHook(
      "post-tool-use",
      editPayload(worktree, join(third, EDITED_FILE)),
      env(home),
    );

    // Assert: C's own root governed the file — captured, nothing dropped
    expect(stdout).toBe("");
    expect(await targetsIn(home)).toEqual([EDITED_FILE]);
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.outsideRootDrops).toBe(0);
    expect(state?.foreignRepoDrops).toBe(0);
    expect(state?.lastEditedPathResolvedAgainst).not.toBeNull();
  });
});

describe("drops that must stay drops, now counted (#17)", () => {
  test("a file in a DIFFERENT connected repo is a foreign drop", async () => {
    // Arrange: session in repo A (cwd A), a second connected repo next door
    const { main, home } = await repoWithWorktree("foreign");
    const foreign = await makeRepo("foreign-web", {
      remote: "git@github.com:acme/web.git",
    });
    await writeFile(
      join(foreign, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await git(foreign, ["add", "."]);
    await git(foreign, ["commit", "-m", "config"]);
    await writeRepoFile(foreign, "src/app.ts", "export const b = 2;\n");
    paths.push(foreign);
    await writeSessionState(home, sessionState(main));

    // Act
    const stdout = await runHook(
      "post-tool-use",
      editPayload(main, join(foreign, "src/app.ts")),
      env(home),
    );

    // Assert: nothing captured, the foreign touch counted
    expect(stdout).toBe("");
    expect(await targetsIn(home)).toEqual([]);
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(state?.editToolFires).toBe(1);
  });

  test("a file in a linked worktree of a DIFFERENT connected repo is a foreign drop", async () => {
    // Arrange: session in repo A; a second connected repo with its own
    // linked worktree — the same-repoId rule must say no here
    const { main, home } = await repoWithWorktree("foreign-wt");
    const other = await repoWithWorktree("foreign-wt-other", "git@github.com:acme/web.git");
    await writeRepoFile(other.worktree, "src/app.ts", "export const b = 2;\n");
    await writeSessionState(home, sessionState(main));

    // Act: cwd A, the file lives in the OTHER repo's worktree
    const stdout = await runHook(
      "post-tool-use",
      editPayload(main, join(other.worktree, "src/app.ts")),
      env(home),
    );

    // Assert: not captured, counted as foreign — not as outside-root
    expect(stdout).toBe("");
    expect(await targetsIn(home)).toEqual([]);
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(state?.outsideRootDrops).toBe(0);
    // …and the foreign root is cached under ITS repoId, so the next touch of
    // that worktree costs no git either
    expect(
      state?.knownWorktreeRoots.some((entry) => entry.repoId === "github.com/acme/web"),
    ).toBe(true);
  });

  test("a DIFFERENT repo stays foreign even from a worktree cwd", async () => {
    // Arrange: the same second-repo touch as above, but the hook's cwd is a
    // worktree of THIS repo — the geometry where the identity shortcut used to
    // swallow every path and book the drop under the wrong counter
    const { main, worktree, home } = await repoWithWorktree("foreign-from-wt");
    const other = await repoWithWorktree(
      "foreign-from-wt-other",
      "git@github.com:acme/web.git",
    );
    await writeRepoFile(other.main, "src/app.ts", "export const b = 2;\n");
    await writeSessionState(home, sessionState(main));

    // Act
    const stdout = await runHook(
      "post-tool-use",
      editPayload(worktree, join(other.main, "src/app.ts")),
      env(home),
    );

    // Assert: foreign, not outside-root — doctor's cause stays the true one
    expect(stdout).toBe("");
    expect(await targetsIn(home)).toEqual([]);
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(state?.outsideRootDrops).toBe(0);
  });

  test("a loose file under no connected root is an outside-root drop", async () => {
    // Arrange
    const { main, home } = await repoWithWorktree("outside");
    const loose = await mkdtemp(join(tmpdir(), "cx-loose-"));
    await writeFile(join(loose, "x.ts"), "export const c = 3;\n", "utf8");
    paths.push(loose);
    await writeSessionState(home, sessionState(main));

    // Act
    const stdout = await runHook(
      "post-tool-use",
      editPayload(main, join(loose, "x.ts")),
      env(home),
    );

    // Assert
    expect(stdout).toBe("");
    expect(await targetsIn(home)).toEqual([]);
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.outsideRootDrops).toBe(1);
    expect(state?.foreignRepoDrops).toBe(0);
  });
});

describe("the foreign-repo guard is still load-bearing after #17 (#9)", () => {
  // The #17 resolver counts a foreign file's drop on its own, so disconnecting
  // the early `state.repoId !== ctx.identity.repoId` guard no longer changes
  // `foreignRepoDrops`. What the guard still uniquely governs: a touch whose
  // CWD is a wholly foreign repo returns BEFORE capture/flush/heartbeat, so it
  // never disturbs the in-repo #18 diagnostics — the last edited path stays the
  // last edit that actually belonged to THIS session's repo, not the foreign
  // drop. Disconnect the guard and the foreign file overwrites those fields
  // (its own resolution is null), which is what this pins.
  test("a foreign-cwd touch leaves the in-repo #18 diagnostics intact", async () => {
    // Arrange: session at A; a good in-repo edit first, then a foreign repo F
    const { main, home } = await repoWithWorktree("guard");
    await writeRepoFile(main, "src/own.ts", "export const a = 1;\n");
    const foreign = await makeRepo("guard-foreign", {
      remote: "git@github.com:acme/web.git",
    });
    await writeFile(
      join(foreign, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await git(foreign, ["add", "."]);
    await git(foreign, ["commit", "-m", "config"]);
    await writeRepoFile(foreign, "src/app.ts", "export const b = 2;\n");
    paths.push(foreign);
    await writeSessionState(home, sessionState(main));

    // Act 1: a good edit of a file in A (cwd A) sets the #18 fields to A
    await runHook(
      "post-tool-use",
      editPayload(main, join(main, "src/own.ts")),
      env(home),
    );
    const afterOwn = await readSessionState(home, SESSION_ID);
    expect(afterOwn?.lastEditedPathResolvedAgainst).not.toBeNull();

    // Act 2: an edit whose CWD IS the foreign repo — the guard fires
    const stdout = await runHook(
      "post-tool-use",
      editPayload(foreign, join(foreign, "src/app.ts")),
      env(home),
    );

    // Assert: counted foreign, nothing captured, and the #18 fields still name
    // the last IN-REPO edit — the guard returned before touching them.
    // `lastEditedPath` holds the path AS THE HOST GAVE IT (absolute), not the
    // repo-relative id: the #18 line has to be able to name a path that never
    // resolved, and such a path has no repo-relative form to hold.
    expect(stdout).toBe("");
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(state?.seenTargets).toEqual(["src/own.ts"]);
    expect(state?.lastEditedPath).toBe(join(main, "src/own.ts"));
    expect(state?.lastEditedPathResolvedAgainst).toBe(
      afterOwn?.lastEditedPathResolvedAgainst ?? null,
    );
  });

  test("a foreign-cwd touch NAMES itself when no in-repo edit ever did", async () => {
    // Arrange: the other half of the rule above. With nothing to preserve,
    // leaving the #18 fields empty produced a doctor line that denied the
    // edits it had just counted — `N edit-tool fires → 0 targets · last
    // edited path resolved: no edit yet` — and hid the foreign drop count,
    // which doctor renders ONLY inside its `lastEditedPath !== null` branch.
    const { main, home } = await repoWithWorktree("guard-first");
    const foreign = await makeRepo("guard-first-foreign", {
      remote: "git@github.com:acme/web.git",
    });
    await writeFile(
      join(foreign, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await git(foreign, ["add", "."]);
    await git(foreign, ["commit", "-m", "config"]);
    await writeRepoFile(foreign, "src/app.ts", "export const b = 2;\n");
    paths.push(foreign);
    await writeSessionState(home, sessionState(main));

    // Act: the session's FIRST edit has a foreign cwd
    await runHook(
      "post-tool-use",
      editPayload(foreign, join(foreign, "src/app.ts")),
      env(home),
    );

    // Assert
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.editToolFires).toBe(1);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(state?.lastEditedPath).toBe(join(foreign, "src/app.ts"));
    expect(state?.lastEditedPathResolvedAgainst).toBeNull();
  });

  test("a secret-shaped dropped path is refused, and the drop still counts", async () => {
    // Arrange: the path this guard stores comes from the MODEL's own
    // tool_input. `withCaptureBookkeeping` screens and bounds the same field
    // on the capture path (finding A5) and `containsSecret` refuses an
    // identical string as a capture TARGET — so writing it here unscreened
    // was the one way round that screen, into the state file and onto the
    // doctor line.
    const { main, home } = await repoWithWorktree("guard-secret");
    const foreign = await makeRepo("guard-secret-foreign", {
      remote: "git@github.com:acme/web.git",
    });
    await writeFile(
      join(foreign, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await git(foreign, ["add", "."]);
    await git(foreign, ["commit", "-m", "config"]);
    paths.push(foreign);
    await writeSessionState(home, sessionState(main));
    const secretish = join(foreign, `ghp_${"0123456789".repeat(4)}`, "x.ts");

    // Act
    await runHook("post-tool-use", editPayload(foreign, secretish), env(home));

    // Assert: refused, and still counted
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.lastEditedPath).toBeNull();
    expect(state?.editToolFires).toBe(1);
    expect(state?.foreignRepoDrops).toBe(1);
  });
});

describe("the tripwire trips on a worktree file (#17 pre-tool-use)", () => {
  const preToolUsePayload = (cwd: string, absoluteFile: string): string =>
    JSON.stringify({
      session_id: SESSION_ID,
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: absoluteFile },
    });

  test("a teammate targeting the worktree file makes the edit ask", async () => {
    // Arrange: session at checkout A, an active teammate on the repo-relative
    // id of a file that lives in worktree B
    const { main, worktree, home } = await repoWithWorktree("tw");
    await writeRepoFile(worktree, EDITED_FILE, "export const a = 1;\n");
    const hub = startHintHub();
    hub.setTripwireSessions([activeTeammateSession()]);
    hubs.push(hub);
    await writeSessionState(home, {
      ...sessionState(main),
      hubUrl: hub.url,
    });
    const liveEnv: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
      CROSSCHECK_SSH_CANONICALIZE: "off",
    };

    // Act: edit the worktree file from the main checkout (D1 shape)
    const stdout = await runHook(
      "pre-tool-use",
      preToolUsePayload(main, join(worktree, EDITED_FILE)),
      liveEnv,
    );

    // Assert: the wire tripped — the ladder's ceiling, ask
    const decision = (
      JSON.parse(stdout) as {
        hookSpecificOutput?: { permissionDecision?: string };
      }
    ).hookSpecificOutput;
    expect(decision?.permissionDecision).toBe("ask");
  });
});
