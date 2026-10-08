/**
 * A SESSIONSTART THAT LOST ITS BRIEFING SAYS SO (2026-10-08), through the
 * real runner (`runHookWith`).
 *
 * Before this, every way a briefing could be lost ended in the same "":
 * the budget race winning (booked as a capture loss, never told to the
 * person), the handler throwing (caught, booked nowhere), the hub reads not
 * answering (fail open to nothing). An empty session looked exactly like a
 * quiet repo, which is the pilot failure's shape — the person is told
 * nothing, and nothing says why. Now the session gets one line, and the
 * omission is booked for `doctor`.
 *
 * Still silent where it must be: a checkout no connected repo owns — under a
 * user-level install the hooks fire in every directory — and a briefing that
 * was empty because there was nothing to say.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoKey } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { runHookWith } from "../src/hooks/runner.ts";
import { briefingSkippedLine } from "@crosscheck/connector-core/briefing/omission.ts";
import {
  briefingOmissionsPath,
  readBriefingOmissions,
} from "@crosscheck/connector-core/state/briefing-omissions.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:1";
/** SessionStart's budget is SESSION_START_BUDGET_RATIO (2.5) × this. */
const RESOLVING_TIMEOUT_MS = "250";
/** Under one git spawn, so the budget wins before repo identity resolves. */
const UNRESOLVED_TIMEOUT_MS = "1";
/** Long enough that no budget in this file can wait out a single git spawn. */
const SLOW_GIT_SECONDS = 1;
const RUN_HOOK_IN_CHILD = join(import.meta.dir, "fixtures", "run-hook-in-child.ts");

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const fixture = async (
  label: string,
  timeoutMs: string,
): Promise<{ readonly repo: string; readonly home: string; readonly env: Env }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: timeoutMs,
      CROSSCHECK_SSH_CANONICALIZE: "off",
    },
  };
};

const startPayload = (cwd: string): string =>
  JSON.stringify({ session_id: "omission-uuid", cwd, hook_event_name: "SessionStart", source: "startup" });

const contextOf = (stdout: string): string =>
  stdout.length === 0
    ? ""
    : ((JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
        ?.additionalContext ?? "");

const neverSettles = (): Promise<string> => new Promise<string>(() => {});

/** A never-settling SessionStart in a child whose `git` answers only after SLOW_GIT_SECONDS. */
const runCutSessionStart = async (stdin: string, env: Env): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-slow-git-"));
  paths.push(dir);
  const realGit = Bun.which("git");
  if (realGit === null) {
    throw new Error("git is not on PATH");
  }
  await writeFile(join(dir, "git"), `#!/bin/sh\nsleep ${String(SLOW_GIT_SECONDS)}\nexec "${realGit}" "$@"\n`, {
    mode: 0o755,
  });
  const child = Bun.spawn({
    cmd: [process.execPath, RUN_HOOK_IN_CHILD, "session-start", stdin, JSON.stringify(env)],
    env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) {
    throw new Error(`the hook child failed: ${await new Response(child.stderr).text()}`);
  }
  return stdout;
};

describe("a SessionStart that lost its briefing says so", () => {
  test("the budget winning the race leaves one line, and doctor's count", async () => {
    // Arrange
    const { repo, home, env } = await fixture("omit-budget", RESOLVING_TIMEOUT_MS);

    // Act
    const stdout = await runHookWith("session-start", neverSettles, startPayload(repo), env);

    // Assert
    expect(contextOf(stdout)).toBe(briefingSkippedLine("budget"));
    const omissions = await readBriefingOmissions(home, repoKey(HUB_URL, REPO_ID), new Date());
    expect(omissions.byReason.budget).toBe(1);
  });

  test("a handler that throws leaves one line, and doctor's count", async () => {
    // Arrange
    const { repo, home, env } = await fixture("omit-error", RESOLVING_TIMEOUT_MS);
    const throws = (): Promise<string> => Promise.reject(new Error("the briefing broke"));

    // Act
    const stdout = await runHookWith("session-start", throws, startPayload(repo), env);

    // Assert: the line names no internal detail, only that it happened.
    expect(contextOf(stdout)).toBe(briefingSkippedLine("error"));
    expect(contextOf(stdout)).not.toContain("the briefing broke");
    const omissions = await readBriefingOmissions(home, repoKey(HUB_URL, REPO_ID), new Date());
    expect(omissions.byReason.error).toBe(1);
  });

  test("a briefing empty because there was nothing to say stays silent", async () => {
    // Arrange
    const { repo, home, env } = await fixture("omit-none", RESOLVING_TIMEOUT_MS);

    // Act
    const stdout = await runHookWith("session-start", () => Promise.resolve(""), startPayload(repo), env);

    // Assert
    expect(stdout).toBe("");
    expect(await Bun.file(briefingOmissionsPath(home)).exists()).toBe(false);
  });

  test("a checkout no connected repo owns stays silent even when the budget is cut", async () => {
    // Arrange: a plain directory, no .git anywhere above it — a user-level
    // install fires here too, and a line in every directory would be noise.
    const { home, env } = await fixture("omit-unconnected", UNRESOLVED_TIMEOUT_MS);
    const outside = await makeHome("omit-outside");
    paths.push(outside);

    // Act
    const stdout = await runCutSessionStart(startPayload(outside), env);

    // Assert
    expect(stdout).toBe("");
    expect(await Bun.file(briefingOmissionsPath(home)).exists()).toBe(false);
  });

  test("a connected repo cut before its identity resolved still says so, charged to every repo", async () => {
    // Arrange
    const { repo, home, env } = await fixture("omit-unresolved", UNRESOLVED_TIMEOUT_MS);

    // Act
    const stdout = await runCutSessionStart(startPayload(repo), env);

    // Assert
    expect(contextOf(stdout)).toBe(briefingSkippedLine("budget"));
    expect((await readBriefingOmissions(home, "any-other-repo-key", new Date())).byReason.budget).toBe(1);
  });
});
