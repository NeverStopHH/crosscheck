/**
 * THE KEN TEST (trial finding #9): a scripted session whose cwd is a PARENT
 * directory of a connected repo — the Cursor-panel shape that cost a
 * teammate his visibility (~/dev workspace above ~/dev/monorepo) — editing
 * files inside the repo, against a real hub.
 *
 * On the pre-fix tree this whole session is invisible: cwd-based resolution
 * finds no repo at the workspace root and every hook exits silently. After
 * path-derived resolution the FIRST TOUCH of a file inside the connected
 * repo registers the session with the repo's own identity and captures the
 * target — while the inverse pins hold: SessionStart alone (no file to
 * derive from) still cannot register, and a file in an UNCONNECTED repo
 * next door stays silent forever, stored credentials or not. That last pin
 * is the trust rule (DESIGN.md §2.1) stated as a test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { runHook } from "../../src/index.ts";
import type { Env } from "../../src/index.ts";
import { saveConfig } from "@crosscheck/connector-core/config/config.ts";
import { renderRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { git, makeHome, makeRepo } from "../../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "e2e-admin-token";
/** Wide enough that a cold PGlite query never trips the fail-open budget. */
const TEST_TIMEOUT_MS = "4000";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let workspace: string;
let repo: string;
let secondRepo: string;
let scratch: string;
let home: string;
let env: Env;
const cleanups: string[] = [];

/** A real git repo inside the workspace, with one commit and a remote. */
const makeWorkspaceRepo = async (
  name: string,
  remote: string,
  isConnected: boolean,
): Promise<string> => {
  const root = join(workspace, name);
  await mkdir(root, { recursive: true });
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "dev@example.com"]);
  await git(root, ["config", "user.name", "Dev"]);
  await writeFile(join(root, "README.md"), "# fixture\n", "utf8");
  if (isConnected) {
    // What `crosscheck init` commits: the repo decides where it reports.
    await writeFile(
      join(root, ".crosscheck.json"),
      renderRepoConfig(hubUrl),
      "utf8",
    );
  }
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["remote", "add", "origin", remote]);
  return root;
};

beforeAll(async () => {
  db = await createDb();
  const app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;

  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Ken", email: "ken@example.com" }),
  });
  // Named failure over an unreadable one (suite-stability finding).
  if (!response.ok) {
    throw new Error(
      `createDeveloper failed: ${String(response.status)} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { data: { apiKey: string } };

  workspace = await mkdtemp(join(tmpdir(), "cx-workspace-"));
  home = await mkdtemp(join(tmpdir(), "cx-ken-home-"));
  cleanups.push(workspace, home);
  repo = await makeWorkspaceRepo("monorepo", "git@github.com:acme/api.git", true);
  secondRepo = await makeWorkspaceRepo("webapp", "git@github.com:acme/web.git", true);
  scratch = await makeWorkspaceRepo("scratch", "git@github.com:ken/scratch.git", false);

  // What `crosscheck login` leaves behind: hub url + api key in the HOME
  // config. Deliberately NOT env credentials for the hub url — the hub the
  // session reports to must come through the committed repo config exactly
  // as the trust rule states.
  await saveConfig(home, { version: 1, hubUrl, apiKey: body.data.apiKey });
  env = {
    CROSSCHECK_HOME: home,
    CROSSCHECK_TIMEOUT_MS: TEST_TIMEOUT_MS,
  };
});

afterAll(async () => {
  server.stop(true);
  // Release the PGlite WASM instance (suite-stability finding).
  await (db as unknown as { $client: { close: () => Promise<void> } }).$client
    .close()
    .catch(() => undefined);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

const postToolUsePayload = (sessionId: string, filePath: string): string =>
  JSON.stringify({
    session_id: sessionId,
    cwd: workspace,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: filePath },
    tool_response: {},
  });

describe("a session whose cwd is the PARENT of a connected repo", () => {
  test("SessionStart at the workspace root cannot register — no file to derive from", async () => {
    // Act
    const stdout = await runHook(
      "session-start",
      JSON.stringify({
        session_id: "ken-uuid",
        cwd: workspace,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      env,
    );

    // Assert: silence, and nothing on the hub
    expect(stdout).toBe("");
    const sessions = await db.execute(sql`select id from agent_sessions`);
    expect(sessions.rows).toEqual([]);
  });

  test("the first touch of a file INSIDE the repo registers and captures (the Ken test)", async () => {
    // Arrange
    await mkdir(join(repo, "src", "auth"), { recursive: true });
    await writeFile(join(repo, "src", "auth", "token.ts"), "export const a = 1;\n", "utf8");

    // Act: the hook fires with the PARENT cwd — invisible on the old tree
    const stdout = await runHook(
      "post-tool-use",
      postToolUsePayload("ken-uuid", join(repo, "src", "auth", "token.ts")),
      env,
    );

    // Assert: visible, with the REPO's identity — not the workspace's
    expect(stdout).toBe("");
    const sessions = await db.execute(
      sql`select id, repo, branch from agent_sessions where id = 'cc_ken-uuid'`,
    );
    expect(sessions.rows).toEqual([
      { id: "cc_ken-uuid", repo: "github.com/acme/api", branch: "main" },
    ]);
    const targets = await db.execute(
      sql`select kind, value from work_context_targets`,
    );
    expect(targets.rows).toEqual([
      { kind: "file", value: "src/auth/token.ts" },
    ]);
  });

  test("a second connected repo in the same session: first wins, the foreign touch is dropped and counted", async () => {
    // Arrange
    await mkdir(join(secondRepo, "src"), { recursive: true });
    await writeFile(join(secondRepo, "src", "app.ts"), "export const b = 2;\n", "utf8");

    // Act: same session id, file in the OTHER connected repo
    const stdout = await runHook(
      "post-tool-use",
      postToolUsePayload("ken-uuid", join(secondRepo, "src", "app.ts")),
      env,
    );

    // Assert: the session stays bound to the first repo; nothing of the
    // foreign repo was captured under it, and the drop was counted.
    expect(stdout).toBe("");
    const sessions = await db.execute(
      sql`select repo from agent_sessions where id = 'cc_ken-uuid'`,
    );
    expect(sessions.rows).toEqual([{ repo: "github.com/acme/api" }]);
    const targets = await db.execute(
      sql`select value from work_context_targets`,
    );
    expect(targets.rows).toEqual([{ value: "src/auth/token.ts" }]);
    const state = await readSessionState(home, "ken-uuid");
    expect(state?.repoId).toBe("github.com/acme/api");
    expect(state?.foreignRepoDrops).toBe(1);
  });

  test("the NEXT prompt after the late registration carries the briefing — once", async () => {
    // Arrange: a teammate whose live session gives Ken's briefing substance.
    // Mona registers the ordinary way, from her own clone of the same repo.
    const response = await fetch(`${hubUrl}/api/developers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Mona", email: "mona@example.com" }),
    });
    if (!response.ok) {
      throw new Error(
        `createDeveloper failed: ${String(response.status)} ${await response.text()}`,
      );
    }
    const mona = (await response.json()) as { data: { apiKey: string } };
    const monaHome = await makeHome("mona");
    const monaRepo = await makeRepo("mona", { remote: "git@github.com:acme/api.git" });
    cleanups.push(monaHome, monaRepo);
    await runHook(
      "session-start",
      JSON.stringify({
        session_id: "mona-uuid",
        cwd: monaRepo,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      {
        CROSSCHECK_HOME: monaHome,
        CROSSCHECK_HUB_URL: hubUrl,
        CROSSCHECK_API_KEY: mona.data.apiKey,
        CROSSCHECK_TIMEOUT_MS: TEST_TIMEOUT_MS,
      },
    );

    // Act: Ken prompts from the WORKSPACE root — no repo at cwd, no file
    // paths to derive one from. His session registered LATE (the first-touch
    // test above), so SessionStart never briefed him.
    const stdout = await runHook(
      "user-prompt-submit",
      JSON.stringify({
        session_id: "ken-uuid",
        cwd: workspace,
        hook_event_name: "UserPromptSubmit",
        prompt: "does the token refresh path still fail for anyone else",
      }),
      env,
    );

    // Assert: the briefing arrived — parent-workspace sessions lose nothing
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const context = parsed.hookSpecificOutput.additionalContext;
    expect(context).toContain("Teammate sessions active now:");
    expect(context).toContain("Mona");
    const state = await readSessionState(home, "ken-uuid");
    expect(state?.briefingPending).toBe(false);

    // Act again: the debt is spent — no second briefing, ever
    const second = await runHook(
      "user-prompt-submit",
      JSON.stringify({
        session_id: "ken-uuid",
        cwd: workspace,
        hook_event_name: "UserPromptSubmit",
        prompt: "does the token refresh path still fail for anyone else",
      }),
      env,
    );
    expect(second).not.toContain("Teammate sessions active now:");
  });

  test("the inverse pin: a file in an UNCONNECTED repo stays silent forever", async () => {
    // Arrange: stored credentials exist (home config), the scratch repo has
    // a git boundary but NO committed .crosscheck.json
    await mkdir(join(scratch, "src"), { recursive: true });
    await writeFile(join(scratch, "src", "notes.ts"), "// private\n", "utf8");

    // Act
    const stdout = await runHook(
      "post-tool-use",
      postToolUsePayload("ken-scratch-uuid", join(scratch, "src", "notes.ts")),
      env,
    );

    // Assert: no session, no state, no capture — silence is the contract
    expect(stdout).toBe("");
    const sessions = await db.execute(
      sql`select id from agent_sessions where id like '%ken-scratch%'`,
    );
    expect(sessions.rows).toEqual([]);
    const targets = await db.execute(
      sql`select value from work_context_targets where value like '%notes%'`,
    );
    expect(targets.rows).toEqual([]);
    expect(await readSessionState(home, "ken-scratch-uuid")).toBeNull();
  });
});
