import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
/** Port 1 refuses instantly: an unreachable hub without the wait. */
const DEAD_HUB_URL = "http://127.0.0.1:1";
const TIMEOUT_MS = "2000";

const paths: string[] = [];

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly env: Env;
}

const fixture = async (label: string): Promise<Fixture> => {
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
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    },
  };
};

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

interface SpooledRecord {
  readonly kind: string;
  readonly body: { readonly title?: string };
}

describe("post-tool-use without a prior session-start", () => {
  test("spools the work context before its targets when the hub is down", async () => {
    // Arrange: hooks installed mid-session, hub unreachable
    const { repo, home, env } = await fixture("recover");
    await writeRepoFile(repo, "src/limiter.ts", "export const a = 1;\n");

    // Act
    const stdout = await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: "recover-uuid",
        cwd: repo,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: `${repo}/src/limiter.ts` },
        tool_response: {},
      }),
      env,
    );

    // Assert
    expect(stdout).toBe("");
    const records = (
      await readSpoolLines(home, repoKey(DEAD_HUB_URL, REPO_ID))
    ).map((line) => JSON.parse(line) as SpooledRecord);
    expect(records[0]?.kind).toBe("work_context");
    expect(records.map((record) => record.kind)).toContain("target");
  });

  test("derives the recovered title from the repo id, not the checkout path", async () => {
    // Arrange
    const { repo, home, env } = await fixture("title");
    await writeRepoFile(repo, "src/limiter.ts", "export const a = 1;\n");

    // Act
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: "title-uuid",
        cwd: repo,
        tool_name: "Edit",
        tool_input: { file_path: `${repo}/src/limiter.ts` },
        tool_response: {},
      }),
      env,
    );

    // Assert
    const lines = await readSpoolLines(home, repoKey(DEAD_HUB_URL, REPO_ID));
    const workContext = JSON.parse(lines[0] ?? "{}") as SpooledRecord;
    expect(workContext.body.title).toBe("main @ api");
  });
});