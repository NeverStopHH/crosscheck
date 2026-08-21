/**
 * Trial finding #15 through the REAL hooks: a session in a detached worktree
 * uploads a title a teammate can read — the branch whose tip it sits on, or
 * `detached@<sha> · <commit subject>` — instead of `detached@<sha> @ repo`.
 * Both title sites are driven: SessionStart, and PostToolUse's state-less
 * recovery (hooks installed mid-session). A dead hub keeps every record in
 * the spool, where the test reads the uploaded title back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runGit } from "@crosscheck/connector-core/git/git.ts";
import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "detached-title-uuid";
/** Port 1 refuses instantly: an unreachable hub without the wait. */
const DEAD_HUB_URL = "http://127.0.0.1:1";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

interface Fixture {
  readonly worktree: string;
  readonly home: string;
  readonly env: Env;
  readonly key: string;
  readonly sha: string;
}

/** A detached worktree of the repo, optionally moved off the branch tip. */
const fixture = async (label: string, subject?: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  const worktree = `${repo}-wt`;
  paths.push(repo, home, worktree);
  await git(repo, ["worktree", "add", "--detach", worktree]);
  if (subject !== undefined) {
    await git(worktree, ["commit", "--allow-empty", "-m", subject]);
  }
  const sha = await runGit(["rev-parse", "--short", "HEAD"], worktree);
  if (sha === null) {
    throw new Error("fixture worktree did not resolve");
  }
  return {
    worktree,
    home,
    sha,
    key: repoKey(DEAD_HUB_URL, REPO_ID),
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: DEAD_HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

interface SpooledWorkContext {
  readonly kind: string;
  readonly body: { readonly title?: string };
}

const spooledTitles = async (fix: Fixture): Promise<readonly string[]> =>
  (await readSpoolLines(fix.home, fix.key))
    .map((line) => JSON.parse(line) as SpooledWorkContext)
    .filter((record) => record.kind === "work_context")
    .map((record) => record.body.title ?? "");

const sessionStartPayload = (fix: Fixture, title?: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: fix.worktree,
    hook_event_name: "SessionStart",
    source: "startup",
    ...(title === undefined ? {} : { session_title: title }),
  });

describe("a detached worktree session uploads a readable title", () => {
  test("SessionStart on a worktree at the branch tip titles it by the branch", async () => {
    // Arrange
    const fix = await fixture("tip");

    // Act
    await runHook("session-start", sessionStartPayload(fix), fix.env);

    // Assert: `git worktree add --detach` left HEAD on main's tip
    expect(await spooledTitles(fix)).toEqual(["main @ api"]);
  });

  test("SessionStart off the branch tip carries the sha and the commit subject", async () => {
    // Arrange
    const fix = await fixture("subject", "fix: refresh 500s after key rotation");

    // Act
    await runHook("session-start", sessionStartPayload(fix), fix.env);

    // Assert: never the bare `detached@<sha> @ api` a teammate learns nothing from
    expect(await spooledTitles(fix)).toEqual([
      `detached@${fix.sha} · fix: refresh 500s after key rotation @ api`,
    ]);
  });

  test("a Claude session_title still wins over the derivation", async () => {
    const fix = await fixture("session-title", "fix: refresh 500s after key rotation");

    await runHook(
      "session-start",
      sessionStartPayload(fix, "Rate limiter drops burst traffic"),
      fix.env,
    );

    expect(await spooledTitles(fix)).toEqual(["Rate limiter drops burst traffic"]);
  });

  test("PostToolUse recovery (no state file) derives the same title once", async () => {
    // Arrange: hooks installed mid-session — no SessionStart ever ran here
    const fix = await fixture("recovery", "feat: limiter tokens per tenant");
    const file = await writeRepoFile(fix.worktree, "src/limiter.ts", "export const a = 1;\n");

    // Act
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fix.worktree,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: file },
        tool_response: {},
      }),
      fix.env,
    );

    // Assert
    expect(await spooledTitles(fix)).toEqual([
      `detached@${fix.sha} · feat: limiter tokens per tenant @ api`,
    ]);
  });
});
