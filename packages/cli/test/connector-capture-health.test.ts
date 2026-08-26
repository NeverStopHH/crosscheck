/**
 * `crosscheck status` and `crosscheck doctor` describe a CURSOR conversation
 * and an ACP session with the same honesty they describe a Claude session —
 * driven end to end, through the real connectors, not by hand-seeded state.
 *
 * The reader (connector-core/state/capture-health.ts) was always
 * connector-agnostic: it scans every `<home>/sessions/*.json` and reports per
 * host session key, so `cur-…` and `acp-…` sessions ALREADY appeared on both
 * surfaces. They appeared with zeros, because neither connector wrote the
 * counters — which is why `isCaptureSilentlyDead` (edit-tool fires ≥
 * DOCTOR_CAPTURE_SILENT_FIRES_WARN with no target) could never fire for
 * either host. RED ON MAIN: every assertion below that expects a non-zero
 * fire count, and every WARN, was a PASS with `0 edit-tool fires → 0 targets`.
 *
 * The host session key is what tells the connectors apart on these surfaces,
 * and it does so deterministically rather than by luck: doctor prints its
 * first 8 characters, and the keys are minted as `cur-<conversation>` and
 * `acp-<agent>--<session>` (connector-core/state/host-session-key.ts), so the
 * prefix is always visible in that window. The per-connector parity table in
 * README.md / docs/adapters/INSTALL.md promises exactly this much.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DOCTOR_CAPTURE_SILENT_FIRES_WARN } from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  acpHostSessionKey,
  cursorHostSessionKey,
} from "@crosscheck/connector-core/state/host-session-key.ts";
import {
  deriveSessionState,
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { runCursorHook } from "@crosscheck/connector-cursor";
import { createAcpCapture } from "@crosscheck/connector-acp";
import type { ObservedLine } from "@crosscheck/connector-acp";

import { runCli } from "../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const REMOTE = "git@github.com:acme/api.git";
/** Unreachable on purpose: every line below is a LOCAL fact. */
const DEAD_HUB_URL = "http://127.0.0.1:9";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const cliEnv = (home: string): Record<string, string> => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_DOCTOR_NO_PROBE: "1",
});

const hookEnv = (home: string): Env => ({
  ...cliEnv(home),
  CROSSCHECK_TIMEOUT_MS: "4000",
  CROSSCHECK_SSH_CANONICALIZE: "off",
});

const lineWith = (stdout: string, needle: string): string =>
  stdout.split("\n").find((entry) => entry.includes(needle)) ?? "";

const linesWith = (stdout: string, needle: string): readonly string[] =>
  stdout.split("\n").filter((entry) => entry.includes(needle));

/** A repo with a COMMITTED config plus one linked worktree carrying it too. */
const repoWithWorktree = async (
  label: string,
): Promise<{ main: string; worktree: string; home: string }> => {
  const main = await makeRepo(label, { remote: REMOTE });
  await writeFile(
    join(main, ".crosscheck.json"),
    `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
    "utf8",
  );
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "config"]);
  const worktree = join(await mkdtemp(join(tmpdir(), `cx-cch-${label}-`)), "feature");
  await git(main, ["worktree", "add", worktree, "HEAD"]);
  const home = await makeHome(label);
  paths.push(main, join(worktree, ".."), home);
  return { main, worktree, home };
};

const seedSession = async (
  home: string,
  repoRoot: string,
  hostSessionKey: string,
): Promise<void> => {
  await writeSessionState(home, {
    ...deriveSessionState({
      hostSessionKey,
      repoId: REPO_ID,
      repoRoot,
      hubUrl: DEAD_HUB_URL,
      developerId: "dev_self",
      startedAt: new Date().toISOString(),
    }),
    lastHeartbeatAt: new Date().toISOString(),
  });
};

// ── Cursor ──────────────────────────────────────────────────────────────────

const CONVERSATION_ID = "conv-health";
const CURSOR_KEY = cursorHostSessionKey(CONVERSATION_ID);

const cursorEdit = (workspaceRoot: string, absoluteFile: string): string =>
  JSON.stringify({
    conversation_id: CONVERSATION_ID,
    hook_event_name: "afterFileEdit",
    cursor_version: "3.13.25",
    workspace_roots: [workspaceRoot],
    file_path: absoluteFile,
    edits: [{ old_string: "a", new_string: "b" }],
  });

describe("a cursor conversation on the capture surfaces", () => {
  test("PASS: status and doctor print the fires, the targets and the resolved root", async () => {
    // Arrange: a conversation at checkout A that edits two files in worktree B
    const { main, worktree, home } = await repoWithWorktree("cch-cur-pass");
    await writeRepoFile(worktree, "src/one.ts", "export const a = 1;\n");
    await writeRepoFile(worktree, "src/two.ts", "export const b = 2;\n");
    await seedSession(home, main, CURSOR_KEY);

    // Act
    await runCursorHook(
      "afterFileEdit",
      cursorEdit(main, join(worktree, "src/one.ts")),
      hookEnv(home),
    );
    await runCursorHook(
      "afterFileEdit",
      cursorEdit(main, join(worktree, "src/two.ts")),
      hookEnv(home),
    );
    const status = await runCli(["status"], cliEnv(home), main);
    const doctor = await runCli(["doctor"], cliEnv(home), main);

    // Assert
    const line = lineWith(doctor.stdout, "  capture  ");
    expect(line).toContain("PASS  capture");
    expect(line).toContain(CURSOR_KEY.slice(0, 8));
    expect(line).toContain("2 edit-tool fires → 2 targets");
    expect(line).toContain("last tool afterFileEdit");
    expect(line).toContain("last edited path resolved: yes");
    expect(status.stdout).toContain("targets: 2 captured by 1 open session");
  });

  test("WARN: edits keep firing into a foreign repo and the capture check says so", async () => {
    // Arrange: every edit lands in a linked worktree of a DIFFERENT connected
    // repo — captured nowhere, counted as foreign
    const { main, home } = await repoWithWorktree("cch-cur-warn");
    const other = await makeRepo("cch-cur-warn-web", {
      remote: "git@github.com:acme/web.git",
    });
    await writeFile(
      join(other, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await git(other, ["add", "."]);
    await git(other, ["commit", "-m", "config"]);
    paths.push(other);
    await writeRepoFile(other, "src/app.ts", "export const b = 2;\n");
    await seedSession(home, main, CURSOR_KEY);

    // Act
    for (let fire = 0; fire < DOCTOR_CAPTURE_SILENT_FIRES_WARN; fire += 1) {
      await runCursorHook(
        "afterFileEdit",
        cursorEdit(main, join(other, "src/app.ts")),
        hookEnv(home),
      );
    }
    const doctor = await runCli(["doctor"], cliEnv(home), main);

    // Assert
    const state = await readSessionState(home, CURSOR_KEY);
    expect(state?.editToolFires).toBe(DOCTOR_CAPTURE_SILENT_FIRES_WARN);
    expect(state?.targetsCapturedCount).toBe(0);
    const line = lineWith(doctor.stdout, "  capture  ");
    expect(line).toContain("WARN  capture");
    expect(line).toContain(CURSOR_KEY.slice(0, 8));
    expect(line).toContain(
      `${String(DOCTOR_CAPTURE_SILENT_FIRES_WARN)} edit-tool fires → 0 targets`,
    );
    expect(line).toContain("last edited path resolved: no");
    expect(line).toContain("foreign-repo");
  });
});

// ── ACP ─────────────────────────────────────────────────────────────────────

const ACP_SESSION_ID = "sess_health";
const ACP_KEY = acpHostSessionKey("fake-agent", ACP_SESSION_ID);

const wireLine = (value: unknown): ObservedLine => ({
  kind: "line",
  text: JSON.stringify(value),
  parsedOk: true,
  bytes: 0,
  atEof: false,
});

const acpEditLine = (absolutePath: string, id: number): ObservedLine =>
  wireLine({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `call_${String(id)}`,
        kind: "edit",
        status: "in_progress",
        locations: [{ path: absolutePath }],
      },
    },
  });

const acpHandshake = (
  capture: ReturnType<typeof createAcpCapture>,
  cwd: string,
): void => {
  capture.offer(
    "c2a",
    wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
  );
  capture.offer(
    "a2c",
    wireLine({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1, agentInfo: { name: "fake-agent", version: "1.0.0" } },
    }),
  );
  capture.offer(
    "c2a",
    wireLine({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } }),
  );
  capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 2, result: { sessionId: ACP_SESSION_ID } }));
};

const acpCapture = (home: string): ReturnType<typeof createAcpCapture> =>
  createAcpCapture({
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: DEAD_HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: "1000",
    },
    logger: {
      path: "/dev/null",
      line: () => undefined,
      writeFailures: () => 0,
      droppedLines: () => 0,
      flush: () => Promise.resolve(),
    },
  });

describe("an ACP session on the capture surfaces", () => {
  test("PASS: status and doctor print the fires, the targets and the resolved root", async () => {
    // Arrange
    const { main, worktree, home } = await repoWithWorktree("cch-acp-pass");
    await writeRepoFile(worktree, "src/one.ts", "export const a = 1;\n");
    await writeRepoFile(worktree, "src/two.ts", "export const b = 2;\n");
    const capture = acpCapture(home);

    // Act
    acpHandshake(capture, main);
    capture.offer("a2c", acpEditLine(join(worktree, "src/one.ts"), 1));
    capture.offer("a2c", acpEditLine(join(worktree, "src/two.ts"), 2));
    await capture.settle();
    const status = await runCli(["status"], cliEnv(home), main);
    const doctor = await runCli(["doctor"], cliEnv(home), main);

    // Assert
    const line = lineWith(doctor.stdout, "  capture  ");
    expect(line).toContain("PASS  capture");
    expect(line).toContain(ACP_KEY.slice(0, 8));
    expect(line).toContain("2 edit-tool fires → 2 targets");
    expect(line).toContain("last tool edit");
    expect(line).toContain("last edited path resolved: yes");
    expect(status.stdout).toContain("targets: 2 captured by 1 open session");
  });

  test("WARN: edits keep firing into files under no connected root", async () => {
    // Arrange: loose files, outside every checkout of this repo
    const { main, home } = await repoWithWorktree("cch-acp-warn");
    const loose = await mkdtemp(join(tmpdir(), "cx-cch-loose-"));
    paths.push(loose);
    await writeFile(join(loose, "x.ts"), "export const c = 3;\n", "utf8");
    const capture = acpCapture(home);

    // Act
    acpHandshake(capture, main);
    for (let fire = 0; fire < DOCTOR_CAPTURE_SILENT_FIRES_WARN; fire += 1) {
      capture.offer("a2c", acpEditLine(join(loose, "x.ts"), fire));
    }
    await capture.settle();
    const doctor = await runCli(["doctor"], cliEnv(home), main);

    // Assert
    const state = await readSessionState(home, ACP_KEY);
    expect(state?.editToolFires).toBe(DOCTOR_CAPTURE_SILENT_FIRES_WARN);
    expect(state?.targetsCapturedCount).toBe(0);
    expect(state?.outsideRootDrops).toBe(DOCTOR_CAPTURE_SILENT_FIRES_WARN);
    const line = lineWith(doctor.stdout, "  capture  ");
    expect(line).toContain("WARN  capture");
    expect(line).toContain(ACP_KEY.slice(0, 8));
    expect(line).toContain("outside-root drop");
    expect(line).toContain("last edited path resolved: no");
  });

  test("both connectors' sessions are told apart on one machine", async () => {
    // Arrange: one home, one repo, a cursor conversation AND an acp session —
    // the shape a developer running both actually has. The doctor line's
    // 8-character key window carries the host prefix by construction.
    const { main, worktree, home } = await repoWithWorktree("cch-both");
    await writeRepoFile(worktree, "src/one.ts", "export const a = 1;\n");
    await seedSession(home, main, CURSOR_KEY);
    const capture = acpCapture(home);

    // Act
    await runCursorHook(
      "afterFileEdit",
      cursorEdit(main, join(worktree, "src/one.ts")),
      hookEnv(home),
    );
    acpHandshake(capture, main);
    capture.offer("a2c", acpEditLine(join(worktree, "src/one.ts"), 1));
    await capture.settle();
    const doctor = await runCli(["doctor"], cliEnv(home), main);

    // Assert
    const lines = linesWith(doctor.stdout, "  capture  ");
    expect(lines.some((line) => line.includes("cur-conv"))).toBe(true);
    expect(lines.some((line) => line.includes("acp-fake"))).toBe(true);
    expect(lines.every((line) => line.includes("1 edit-tool fire → 1 target"))).toBe(true);
  });
});
