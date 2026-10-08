/**
 * A Cursor sessionStart that lost its briefing says so (2026-10-08) — the
 * Claude runner's rule (connector-claude test/briefing-omission-hook.test.ts)
 * on this host's output, through the real runner. Silent where the briefing
 * would have been silent anyway: a background agent's is suppressed by
 * design, and no other event's answer is a briefing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { runCursorHookWith } from "../src/runner.ts";
import { deliveredAdditionalContext } from "../src/inject/output.ts";
import { briefingSkippedLine } from "@crosscheck/connector-core/briefing/omission.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  briefingOmissionsPath,
  readBriefingOmissions,
} from "@crosscheck/connector-core/state/briefing-omissions.ts";
import {
  AFTER_FILE_EDIT_INPUT,
  SESSION_START_INPUT,
  SESSION_START_INPUT_BACKGROUND,
} from "./fixtures/cursor-contract/payloads.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const DEAD_HUB_URL = "http://127.0.0.1:1";
/** sessionStart's budget is SESSION_START_BUDGET_RATIO (2.5) × this. */
const RESOLVING_TIMEOUT_MS = "250";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const fixture = async (label: string): Promise<{ readonly repo: string; readonly home: string; readonly env: Env }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: DEAD_HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: RESOLVING_TIMEOUT_MS,
      CROSSCHECK_SSH_CANONICALIZE: "off",
    },
  };
};

const neverSettles = (): Promise<string> => new Promise<string>(() => {});

describe("a Cursor sessionStart that lost its briefing says so", () => {
  test("the budget winning leaves one line, and doctor's count", async () => {
    // Arrange
    const { repo, home, env } = await fixture("cursor-omit-budget");

    // Act
    const out = await runCursorHookWith(
      "sessionStart",
      neverSettles,
      JSON.stringify({ ...SESSION_START_INPUT, workspace_roots: [repo] }),
      env,
    );

    // Assert
    expect(deliveredAdditionalContext(out)).toBe(briefingSkippedLine("budget"));
    expect((await readBriefingOmissions(home, repoKey(DEAD_HUB_URL, REPO_ID), new Date())).byReason.budget).toBe(1);
  });

  test("a handler that throws leaves one line, and doctor's count", async () => {
    // Arrange
    const { repo, home, env } = await fixture("cursor-omit-error");

    // Act
    const out = await runCursorHookWith(
      "sessionStart",
      () => Promise.reject(new Error("the briefing broke")),
      JSON.stringify({ ...SESSION_START_INPUT, workspace_roots: [repo] }),
      env,
    );

    // Assert
    expect(deliveredAdditionalContext(out)).toBe(briefingSkippedLine("error"));
    expect((await readBriefingOmissions(home, repoKey(DEAD_HUB_URL, REPO_ID), new Date())).byReason.error).toBe(1);
  });

  test("a background agent's cut sessionStart stays the no-op — its briefing is suppressed by design", async () => {
    // Arrange
    const { repo, home, env } = await fixture("cursor-omit-background");

    // Act
    const out = await runCursorHookWith(
      "sessionStart",
      neverSettles,
      JSON.stringify({ ...SESSION_START_INPUT_BACKGROUND, workspace_roots: [repo] }),
      env,
    );

    // Assert
    expect(out).toBe("{}");
    expect(await Bun.file(briefingOmissionsPath(home)).exists()).toBe(false);
  });

  test("an event whose answer is no briefing stays the no-op when cut", async () => {
    // Arrange
    const { repo, home, env } = await fixture("cursor-omit-edit");

    // Act
    const out = await runCursorHookWith(
      "afterFileEdit",
      neverSettles,
      JSON.stringify({ ...AFTER_FILE_EDIT_INPUT, workspace_roots: [repo], file_path: join(repo, "src/a.ts") }),
      env,
    );

    // Assert
    expect(out).toBe("{}");
    expect(await Bun.file(briefingOmissionsPath(home)).exists()).toBe(false);
  });
});
