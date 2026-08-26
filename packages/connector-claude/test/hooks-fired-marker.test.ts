/**
 * The hooks-fired marker (trial finding M2): the only evidence on the machine
 * that a hook has actually RUN.
 *
 * Every hook check in `doctor` was textual before this — it read
 * `.claude/settings.json` and reported what it said — so a launcher that
 * stopped resolving, an agent older than the wiring, or a `CROSSCHECK_DISABLED`
 * in the agent's environment all read PASS. This runs the REAL hook entry
 * point (`runHook`) against a throwaway hub and asserts the file it leaves
 * behind, including the two states where a hook deliberately records nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { runHook } from "../src/index.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { readHooksFired } from "@crosscheck/connector-core/state/fired-markers.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "fired-marker-uuid";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

/** Answers everything with an empty ok envelope — the hook must not need more. */
const acceptingHub = (): string => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        ok: true,
        data: {
          session: { id: `cc_${SESSION_ID}`, developerId: "dev_1" },
          sessions: [],
          workContexts: [],
          absences: [],
          drafts: [],
          matches: [],
          candidates: [],
          accepted: 0,
          duplicates: 0,
          ignored: 0,
          rejected: 0,
        },
      }),
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const fixture = async (): Promise<{
  readonly repo: string;
  readonly home: string;
  readonly hubUrl: string;
  readonly env: Record<string, string>;
}> => {
  const repo = await makeRepo("fired-marker", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("fired-marker");
  paths.push(repo, home);
  const hubUrl = acceptingHub();
  return {
    repo,
    home,
    hubUrl,
    env: {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
  };
};

const editPayload = (repo: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    tool_name: "Edit",
    tool_input: { file_path: join(repo, "README.md") },
  });

describe("hooks-fired marker", () => {
  test("a real post-tool-use fire is recorded under its own name", async () => {
    // Arrange
    const { repo, home, hubUrl, env } = await fixture();

    // Act
    await runHook("post-tool-use", editPayload(repo), env);

    // Assert
    const fired = await readHooksFired(home, repoKey(hubUrl, REPO_ID));
    expect(Object.keys(fired)).toContain("post-tool-use");
    expect(Number.isNaN(Date.parse(fired["post-tool-use"] ?? ""))).toBe(false);
  });

  test("two different events accumulate rather than overwrite", async () => {
    // Arrange
    const { repo, home, hubUrl, env } = await fixture();

    // Act
    await runHook(
      "session-start",
      JSON.stringify({ session_id: SESSION_ID, cwd: repo }),
      env,
    );
    await runHook("post-tool-use", editPayload(repo), env);

    // Assert
    const fired = await readHooksFired(home, repoKey(hubUrl, REPO_ID));
    expect(Object.keys(fired).sort()).toEqual(["post-tool-use", "session-start"]);
  });

  test("a disabled connector records nothing — silence is not a fire", async () => {
    // Arrange
    const { repo, home, hubUrl, env } = await fixture();

    // Act
    await runHook("post-tool-use", editPayload(repo), {
      ...env,
      CROSSCHECK_DISABLED: "1",
    });

    // Assert
    const fired = await readHooksFired(home, repoKey(hubUrl, REPO_ID));
    expect(Object.keys(fired)).toEqual([]);
  });

  test("a hook that resolves no reportable repo records nothing", async () => {
    // Arrange: a cwd that is not a git repo at all
    const { home, hubUrl, env } = await fixture();
    const elsewhere = await makeHome("fired-marker-elsewhere");
    paths.push(elsewhere);

    // Act
    await runHook(
      "post-tool-use",
      JSON.stringify({ session_id: SESSION_ID, cwd: elsewhere, tool_name: "Edit", tool_input: {} }),
      env,
    );

    // Assert
    const fired = await readHooksFired(home, repoKey(hubUrl, REPO_ID));
    expect(Object.keys(fired)).toEqual([]);
  });
});
