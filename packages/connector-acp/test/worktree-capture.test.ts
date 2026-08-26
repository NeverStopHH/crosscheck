/**
 * ACP edits in a LINKED GIT WORKTREE are captured, and ACP sessions book
 * capture health — the #17/#18/#20 fix on this host, mirrored on
 * connector-claude/test/worktree-capture.test.ts.
 *
 * RED ON MAIN, MEASURED: two `session/update` tool_call edits offered, one
 * inside the session cwd and one in worktree B of the SAME repo, captured
 * 1 of 2 — the worktree edit was dropped with `foreignRepoDrops` and
 * `outsideRootDrops` both 0. And `targetsCapturedCount` stayed 0 even for the
 * target that DID land, because the engine booked no capture health at all:
 * every ACP session printed `0 edit-tool fires → 0 targets` in `crosscheck
 * status`/`doctor`, so `isCaptureSilentlyDead` could never fire for one.
 *
 * TWO ACP-SPECIFIC TRAPS ARE PINNED HERE, because the Claude reference cannot
 * warn about either:
 *   1. the counters' write used to sit BEHIND `if (captured.length === 0)
 *      return` — exactly the case they exist for, which would have made
 *      fires === targets always and the WARN structurally unreachable;
 *   2. `wire/v1.ts` folds `tool_call` and `tool_call_update` into one shape,
 *      so one edit arriving pending then completed would tick the fire
 *      counter twice and corrupt the ratio the WARN is measured on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DOCTOR_CAPTURE_SILENT_FIRES_WARN,
  MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS,
} from "@crosscheck/connector-core/constants.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import {
  REMOTE,
  bootCaptureHub,
  createHarness,
  handshake,
  toolCallUpdate,
  wireLine,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub, Harness } from "./fixtures/capture-harness.ts";
import {
  git,
  makeHome,
  makeRepo,
  writeRepoFile,
} from "../../connector-core/test/helpers.ts";

const EDITED_FILE = "src/auth/refresh.ts";

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-worktree");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A repo whose ROOT carries a COMMITTED `.crosscheck.json` plus one linked
 * worktree carrying it too — what `findConnectedRepoRootForFile` requires
 * before it will call a directory a connected root.
 */
const repoWithWorktree = async (
  label: string,
  remote = REMOTE,
): Promise<{ main: string; worktree: string }> => {
  const main = await makeRepo(label, { remote });
  await writeFile(
    join(main, ".crosscheck.json"),
    `${JSON.stringify({ hubUrl: hub.hubUrl }, null, 2)}\n`,
    "utf8",
  );
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "config"]);
  const worktree = join(await mkdtemp(join(tmpdir(), `cx-acp-wt-${label}-`)), "feature");
  await git(main, ["worktree", "add", worktree, "HEAD"]);
  cleanups.push(main, join(worktree, ".."));
  return { main, worktree };
};

const harnessAt = async (label: string, repo: string): Promise<Harness> => {
  const home = await makeHome(label);
  cleanups.push(home);
  return createHarness(hub, cleanups, label, { home, repo });
};

const editUpdate = (
  sessionId: string,
  absolutePath: string,
  overrides: Record<string, unknown> = {},
) =>
  toolCallUpdate(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "call_1",
    kind: "edit",
    status: "in_progress",
    locations: [{ path: absolutePath }],
    ...overrides,
  });

describe("an ACP session at checkout A editing a file in worktree B", () => {
  test("captures the worktree file and books the edit as a fire", async () => {
    // Arrange
    const { main, worktree } = await repoWithWorktree("acp-wt");
    await writeRepoFile(worktree, EDITED_FILE, "export const a = 1;\n");
    const h = await harnessAt("acp-wt", main);
    const sessionId = "sess_wt";
    const hostKey = `acp-fake-agent--${sessionId}`;

    // Act
    handshake(h, sessionId, main);
    h.capture.offer("a2c", editUpdate(sessionId, join(worktree, EDITED_FILE)));
    await h.capture.settle();

    // Assert
    expect(h.capture.counters().targets).toBe(1);
    const state = await readSessionState(h.home, hostKey);
    expect(state?.seenTargets).toEqual([EDITED_FILE]);
    expect(state?.editToolFires).toBe(1);
    expect(state?.targetsCapturedCount).toBe(1);
    expect(state?.lastPostToolUseTool).toBe("edit");
    expect(state?.lastEditedPath).toBe(join(worktree, EDITED_FILE));
    expect(state?.lastEditedPathResolvedAgainst).not.toBeNull();
    expect(state?.foreignRepoDrops).toBe(0);
    expect(state?.outsideRootDrops).toBe(0);
  });

  test("an fs/write_text_file into the worktree is captured and counted too", async () => {
    // Arrange: the CLIENT performs this write at the agent's request, so it is
    // an edit by any honest reading — and on an agent that only ever writes
    // this way it is the ONLY edit signal there is. Not counting it would
    // leave such a session at `0 fires → 0 targets`, unable to WARN.
    const { main, worktree } = await repoWithWorktree("acp-fswrite");
    await writeRepoFile(worktree, "src/written.ts", "export const a = 1;\n");
    const h = await harnessAt("acp-fswrite", main);
    const sessionId = "sess_fswrite";
    const hostKey = `acp-fake-agent--${sessionId}`;

    // Act
    handshake(h, sessionId, main);
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        id: 77,
        method: "fs/write_text_file",
        params: {
          sessionId,
          path: join(worktree, "src/written.ts"),
          content: "export const a = 2;\n",
        },
      }),
    );
    await h.capture.settle();

    // Assert
    const state = await readSessionState(h.home, hostKey);
    expect(state?.seenTargets).toEqual(["src/written.ts"]);
    expect(state?.editToolFires).toBe(1);
    expect(state?.targetsCapturedCount).toBe(1);
    expect(state?.lastPostToolUseTool).toBe("fs/write_text_file");
  });

  test("one edit signalled BOTH ways books two fires against one target", async () => {
    // Arrange: an agent may announce `tool_call kind: "edit"` AND ask the
    // client to perform the write. Both are honest edit signals and both are
    // counted, so the ratio a human reads is 2 → 1 for one edit. That trade
    // is deliberate — dropping either signal leaves some real agent
    // permanently at `0 fires → 0 targets`, unable to WARN — and it can never
    // produce a FALSE warn, because the first of the two captures the target.
    // Pinned so the distortion is a measured number rather than an assurance.
    const { main, worktree } = await repoWithWorktree("acp-both");
    await writeRepoFile(worktree, EDITED_FILE, "export const a = 1;\n");
    const h = await harnessAt("acp-both", main);
    const sessionId = "sess_both";
    const hostKey = `acp-fake-agent--${sessionId}`;
    const path = join(worktree, EDITED_FILE);

    // Act
    handshake(h, sessionId, main);
    h.capture.offer("a2c", editUpdate(sessionId, path));
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        id: 78,
        method: "fs/write_text_file",
        params: { sessionId, path, content: "export const a = 2;\n" },
      }),
    );
    await h.capture.settle();

    // Assert
    const state = await readSessionState(h.home, hostKey);
    expect(state?.editToolFires).toBe(2);
    expect(state?.targetsCapturedCount).toBe(1);
    expect(state?.seenTargets).toEqual([EDITED_FILE]);
  });

  test("one edit arriving pending then completed ticks the fire counter ONCE", async () => {
    // Arrange: `wire/v1.ts` folds `tool_call` and `tool_call_update` into one
    // shape, and agents commonly repeat the whole ToolCallUpdate — kind and
    // all — on the status change. Counting per status change would report
    // three fires for one edit and silently corrupt the ratio.
    const { main, worktree } = await repoWithWorktree("acp-refire");
    await writeRepoFile(worktree, EDITED_FILE, "export const a = 1;\n");
    const h = await harnessAt("acp-refire", main);
    const sessionId = "sess_refire";
    const hostKey = `acp-fake-agent--${sessionId}`;
    const path = join(worktree, EDITED_FILE);

    // Act
    handshake(h, sessionId, main);
    h.capture.offer("a2c", editUpdate(sessionId, path, { status: "pending" }));
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        kind: "edit",
        status: "in_progress",
        locations: [{ path }],
      }),
    );
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        kind: "edit",
        status: "completed",
        locations: [{ path }],
      }),
    );
    await h.capture.settle();

    // Assert: one fire, one target — not three fires
    const state = await readSessionState(h.home, hostKey);
    expect(state?.editToolFires).toBe(1);
    expect(state?.targetsCapturedCount).toBe(1);
    expect(state?.seenTargets).toEqual([EDITED_FILE]);
  });

  test("a repeated edit row carrying NO tool-call id still ticks once", async () => {
    // Arrange: the fire is keyed on `toolCallId`, so the test above no longer
    // exercises `isNewToolCall` at all — the id dedupe answers first, and the
    // discriminator could be hard-wired to `true` with every guard still
    // green (mutation-check measured exactly that). A row with NO id is
    // non-conformant but must still answer, and there the announce-row rule
    // is the only thing left to tell one edit from its own restatement.
    const { main, worktree } = await repoWithWorktree("acp-noid");
    await writeRepoFile(worktree, EDITED_FILE, "export const a = 1;\n");
    const h = await harnessAt("acp-noid", main);
    const sessionId = "sess_noid";
    const hostKey = `acp-fake-agent--${sessionId}`;
    const path = join(worktree, EDITED_FILE);

    // Act: an announce and the same call restated — neither carries an id
    handshake(h, sessionId, main);
    h.capture.offer(
      "a2c",
      editUpdate(sessionId, path, { toolCallId: undefined, status: "pending" }),
    );
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        kind: "edit",
        status: "completed",
        locations: [{ path }],
      }),
    );
    await h.capture.settle();

    // Assert: the restatement is not a second edit
    const state = await readSessionState(h.home, hostKey);
    expect(state?.editToolFires).toBe(1);
    expect(state?.targetsCapturedCount).toBe(1);
    expect(state?.seenTargets).toEqual([EDITED_FILE]);
  });

  test("an edit announced with no kind still books its fire", async () => {
    // Arrange: `ToolCall.kind` is OPTIONAL on the announce row (the ACP schema
    // defaults it to "other"), so an agent may legitimately say
    // `tool_call {status: "pending"}` first and reveal `kind: "edit"` plus the
    // locations on the FOLLOWING `tool_call_update`. Counting the fire on the
    // announce ROW rather than on the tool CALL booked zero fires for such an
    // agent — every drop counted, `isCaptureSilentlyDead` unreachable for the
    // life of the session, doctor printing `0 edit-tool fires → 0 targets`
    // as a PASS. Same shape after a `session/load` resume whose announce row
    // the proxy never saw.
    const { main } = await repoWithWorktree("acp-nokind");
    const loose = await mkdtemp(join(tmpdir(), "cx-acp-nokind-"));
    cleanups.push(loose);
    await writeFile(join(loose, "x.ts"), "export const c = 3;\n", "utf8");
    const h = await harnessAt("acp-nokind", main);
    const sessionId = "sess_nokind";
    const hostKey = `acp-fake-agent--${sessionId}`;

    // Act
    handshake(h, sessionId, main);
    for (let index = 0; index < DOCTOR_CAPTURE_SILENT_FIRES_WARN; index += 1) {
      h.capture.offer(
        "a2c",
        toolCallUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: `call_${String(index)}`,
          status: "pending",
        }),
      );
      h.capture.offer(
        "a2c",
        toolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: `call_${String(index)}`,
          kind: "edit",
          status: "completed",
          locations: [{ path: join(loose, "x.ts") }],
        }),
      );
    }
    await h.capture.settle();

    // Assert: one fire per tool CALL — the WARN threshold is reachable
    const state = await readSessionState(h.home, hostKey);
    expect(state?.editToolFires).toBe(DOCTOR_CAPTURE_SILENT_FIRES_WARN);
    expect(state?.outsideRootDrops).toBe(DOCTOR_CAPTURE_SILENT_FIRES_WARN);
    expect(state?.targetsCapturedCount).toBe(0);
    expect(state?.lastPostToolUseTool).toBe("edit");
  });
});

describe("ACP drops that must stay drops, now counted (#17)", () => {
  test("a file in a linked worktree of a DIFFERENT connected repo is a foreign drop", async () => {
    // Arrange
    const { main } = await repoWithWorktree("acp-foreign");
    const other = await repoWithWorktree("acp-foreign-web", "git@github.com:acme/web.git");
    await writeRepoFile(other.worktree, "src/app.ts", "export const b = 2;\n");
    const h = await harnessAt("acp-foreign", main);
    const sessionId = "sess_foreign";
    const hostKey = `acp-fake-agent--${sessionId}`;

    // Act
    handshake(h, sessionId, main);
    h.capture.offer("a2c", editUpdate(sessionId, join(other.worktree, "src/app.ts")));
    await h.capture.settle();

    // Assert: FOREIGN, not outside-root, and the fire is still visible
    const state = await readSessionState(h.home, hostKey);
    expect(state?.seenTargets).toEqual([]);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(state?.outsideRootDrops).toBe(0);
    expect(state?.editToolFires).toBe(1);
    expect(state?.targetsCapturedCount).toBe(0);
    expect(
      state?.knownWorktreeRoots.some((entry) => entry.repoId === "github.com/acme/web"),
    ).toBe(true);
  });

  test("a loose file under no connected root is an outside-root drop", async () => {
    // Arrange
    const { main } = await repoWithWorktree("acp-outside");
    const loose = await mkdtemp(join(tmpdir(), "cx-acp-loose-"));
    cleanups.push(loose);
    await writeFile(join(loose, "x.ts"), "export const c = 3;\n", "utf8");
    const h = await harnessAt("acp-outside", main);
    const sessionId = "sess_outside";
    const hostKey = `acp-fake-agent--${sessionId}`;

    // Act
    handshake(h, sessionId, main);
    h.capture.offer("a2c", editUpdate(sessionId, join(loose, "x.ts")));
    await h.capture.settle();

    // Assert: THE trap this suite exists for — the counters must be written
    // even though nothing was captured, which is precisely the case the old
    // `if (captured.length === 0) return` skipped.
    const state = await readSessionState(h.home, hostKey);
    expect(state?.outsideRootDrops).toBe(1);
    expect(state?.foreignRepoDrops).toBe(0);
    expect(state?.editToolFires).toBe(1);
    expect(state?.targetsCapturedCount).toBe(0);
    expect(state?.lastEditedPathResolvedAgainst).toBeNull();
  });

  test("a worktree checked out before the config was committed is OUTSIDE-root, not foreign", async () => {
    // Arrange: the walk requires the COMMITTED config at the worktree's own
    // root. An unresolvable root is not evidence of a second repo — pinned so
    // nobody later "fixes" this into a foreign drop.
    const main = await makeRepo("acp-preconfig", { remote: REMOTE });
    const before = join(await mkdtemp(join(tmpdir(), "cx-acp-wt-pre-")), "old");
    await git(main, ["worktree", "add", before, "HEAD"]);
    await writeFile(
      join(main, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: hub.hubUrl }, null, 2)}\n`,
      "utf8",
    );
    await git(main, ["add", "."]);
    await git(main, ["commit", "-m", "config"]);
    cleanups.push(main, join(before, ".."));
    await writeRepoFile(before, EDITED_FILE, "export const a = 1;\n");
    const h = await harnessAt("acp-preconfig", main);
    const sessionId = "sess_preconfig";

    // Act
    handshake(h, sessionId, main);
    h.capture.offer("a2c", editUpdate(sessionId, join(before, EDITED_FILE)));
    await h.capture.settle();

    // Assert
    const state = await readSessionState(h.home, `acp-fake-agent--${sessionId}`);
    expect(state?.outsideRootDrops).toBe(1);
    expect(state?.foreignRepoDrops).toBe(0);
  });
});

describe("what an ACP NON-edit tool call may and may not book", () => {
  test("in-repo READS cannot mask the WARN for edits that all drop", async () => {
    // Arrange: the shape only this host can produce — a non-edit tool call
    // carrying `locations`. ACP feeds `captureTargets` for EVERY tool_call
    // kind, so three in-repo reads used to book three targets while
    // `editToolFires` counted only edits: `isCaptureSilentlyDead` (fires >=
    // DOCTOR_CAPTURE_SILENT_FIRES_WARN AND targets === 0) then could not fire
    // again for the life of the session, and doctor printed the H1 silence as
    // a PASS.
    const { main } = await repoWithWorktree("acp-mask");
    const other = await repoWithWorktree("acp-mask-web", "git@github.com:acme/web.git");
    await writeRepoFile(other.worktree, "src/app.ts", "export const b = 2;\n");
    for (const name of ["src/r1.ts", "src/r2.ts", "src/r3.ts"]) {
      await writeRepoFile(main, name, "export const r = 1;\n");
    }
    const h = await harnessAt("acp-mask", main);
    const sessionId = "sess_mask";
    const hostKey = `acp-fake-agent--${sessionId}`;
    handshake(h, sessionId, main);

    // Act: three in-repo reads, then DOCTOR_CAPTURE_SILENT_FIRES_WARN edits
    // into a linked worktree of a DIFFERENT repo — every one of them drops
    for (const [index, name] of ["src/r1.ts", "src/r2.ts", "src/r3.ts"].entries()) {
      h.capture.offer(
        "a2c",
        editUpdate(sessionId, join(main, name), {
          toolCallId: `read_${index}`,
          kind: "read",
        }),
      );
    }
    for (let index = 0; index < DOCTOR_CAPTURE_SILENT_FIRES_WARN; index += 1) {
      h.capture.offer(
        "a2c",
        editUpdate(sessionId, join(other.worktree, "src/app.ts"), {
          toolCallId: `edit_${index}`,
        }),
      );
    }
    await h.capture.settle();

    // Assert: the reads' targets landed in the spool (they are work context),
    // and NONE of them became evidence that edit capture is alive
    const state = await readSessionState(h.home, hostKey);
    expect(h.capture.counters().targets).toBe(3);
    expect(state?.seenTargets.length).toBe(3);
    expect(state?.editToolFires).toBe(DOCTOR_CAPTURE_SILENT_FIRES_WARN);
    expect(state?.targetsCapturedCount).toBe(0);
    expect(state?.foreignRepoDrops).toBe(DOCTOR_CAPTURE_SILENT_FIRES_WARN);
  });

  test("a READ of another repo raises no drop counter at all", async () => {
    // Arrange: doctor WARNs machine-wide the moment a drop counter moves, and
    // its remedy is "open the other repo as its own workspace/session" —
    // advice a session that has edited nothing has not earned. On Claude the
    // matcher makes this impossible (Bash carries no file_path); here it is
    // one `kind: "read"` with `locations`.
    const { main } = await repoWithWorktree("acp-readdrop");
    const other = await repoWithWorktree("acp-readdrop-web", "git@github.com:acme/web.git");
    await writeRepoFile(other.worktree, "src/app.ts", "export const b = 2;\n");
    const loose = await mkdtemp(join(tmpdir(), "cx-acp-readloose-"));
    cleanups.push(loose);
    await writeFile(join(loose, "x.ts"), "export const c = 3;\n", "utf8");
    const h = await harnessAt("acp-readdrop", main);
    const sessionId = "sess_readdrop";
    const hostKey = `acp-fake-agent--${sessionId}`;

    // Act
    handshake(h, sessionId, main);
    h.capture.offer(
      "a2c",
      editUpdate(sessionId, join(other.worktree, "src/app.ts"), {
        toolCallId: "read_foreign",
        kind: "read",
      }),
    );
    h.capture.offer(
      "a2c",
      editUpdate(sessionId, join(loose, "x.ts"), {
        toolCallId: "read_loose",
        kind: "read",
      }),
    );
    await h.capture.settle();

    // Assert
    const state = await readSessionState(h.home, hostKey);
    expect(state?.foreignRepoDrops).toBe(0);
    expect(state?.outsideRootDrops).toBe(0);
    expect(state?.editToolFires).toBe(0);
    expect(state?.targetsCapturedCount).toBe(0);
  });
});

describe("the ACP session's worktree-root cache", () => {
  test("an UNRESOLVABLE root is retried a bounded number of times, then stands", async () => {
    // Arrange: a directory that IS a connected root by the walk's rule (a
    // `.git` entry beside a readable `.crosscheck.json`) but whose identity
    // git cannot resolve. Three edits in it: with the in-memory cache fed back
    // to the resolver, the attempt budget is spent and STOPS at
    // MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS; without it, every edit re-resolves
    // and the recorded attempts never rise above one. That is the COUNT a
    // wall clock cannot make — and the reason the cache is not decoration.
    const { main } = await repoWithWorktree("acp-attempts");
    const broken = await mkdtemp(join(tmpdir(), "cx-acp-broken-"));
    cleanups.push(broken);
    await writeFile(join(broken, ".git"), "gitdir: /nowhere/at/all\n", "utf8");
    await writeFile(
      join(broken, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: hub.hubUrl }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(broken, "x.ts"), "export const c = 3;\n", "utf8");
    const h = await harnessAt("acp-attempts", main);
    const sessionId = "sess_attempts";

    // Act
    handshake(h, sessionId, main);
    for (let touch = 0; touch < 3; touch += 1) {
      h.capture.offer(
        "a2c",
        toolCallUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: `call_${String(touch)}`,
          kind: "edit",
          status: "in_progress",
          locations: [{ path: join(broken, "x.ts") }],
        }),
      );
    }
    await h.capture.settle();

    // Assert
    const state = await readSessionState(h.home, `acp-fake-agent--${sessionId}`);
    const entry = state?.knownWorktreeRoots.find((row) => row.repoId === null);
    expect(entry).toBeDefined();
    expect(entry?.attempts).toBe(MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS);
    expect(state?.outsideRootDrops).toBe(3);
    expect(state?.editToolFires).toBe(3);
  });

  test("a read-shaped tool call with no paths writes no state at all", async () => {
    // Arrange: no fire, no drop, no capture — the bookkeeping write moved out
    // from behind the early return, so this is the case that must NOT produce
    // an empty write on every observed line.
    const { main } = await repoWithWorktree("acp-quiet");
    const h = await harnessAt("acp-quiet", main);
    const sessionId = "sess_quiet";
    const hostKey = `acp-fake-agent--${sessionId}`;

    // Act
    handshake(h, sessionId, main);
    const before = await readSessionState(h.home, hostKey);
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_read",
        kind: "read",
        status: "completed",
      }),
    );
    await h.capture.settle();

    // Assert
    const after = await readSessionState(h.home, hostKey);
    expect(after?.editToolFires).toBe(0);
    expect(after?.targetsCapturedCount).toBe(0);
    expect(after?.lastPostToolUseTool).toBe(before?.lastPostToolUseTool ?? null);
  });
});
