import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import {
  MAX_BRIEFING_CHARS,
  appendRecords,
  readSpoolLines,
  repoKey,
  runCli,
  runHook,
  runStatusline,
} from "../../src/index.ts";
import type { Env } from "../../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "e2e-admin-token";
const REPO_ID = "github.com/acme/api";
/** Wide enough that a cold PGlite query never trips the fail-open budget. */
const TEST_TIMEOUT_MS = "4000";

interface Developer {
  readonly developerId: string;
  readonly apiKey: string;
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
}

let db: Db;
let app: ReturnType<typeof createServer>;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let alice: Developer;
let bob: Developer;
let bobWorktree: string;
const cleanups: string[] = [];

const envFor = (home: string, apiKey: string, hub: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: hub,
  CROSSCHECK_API_KEY: apiKey,
  CROSSCHECK_TIMEOUT_MS: TEST_TIMEOUT_MS,
});

const createDeveloper = async (name: string, email: string): Promise<{
  readonly developerId: string;
  readonly apiKey: string;
}> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, email }),
  });
  const body = (await response.json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  return { developerId: body.data.developer.id, apiKey: body.data.apiKey };
};

const sessionStartPayload = (
  repo: string,
  sessionId: string,
  title?: string,
): string =>
  JSON.stringify({
    session_id: sessionId,
    cwd: repo,
    hook_event_name: "SessionStart",
    source: "startup",
    ...(title === undefined ? {} : { session_title: title }),
  });

beforeAll(async () => {
  db = await createDb();
  app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;

  const aliceAccount = await createDeveloper("Alice", "alice@example.com");
  const bobAccount = await createDeveloper("Bob", "bob@example.com");
  const aliceHome = await makeHome("alice");
  const bobHome = await makeHome("bob");
  // Different remote spellings on purpose: normalization must make them one repo.
  const aliceRepo = await makeRepo("alice", {
    remote: "git@github.com:acme/api.git",
  });
  const bobRepo = await makeRepo("bob", {
    remote: "https://github.com/Acme/API.git",
  });
  bobWorktree = `${bobRepo}-worktree`;
  await git(bobRepo, ["worktree", "add", "-b", "feat/side", bobWorktree]);

  alice = {
    ...aliceAccount,
    home: aliceHome,
    repo: aliceRepo,
    env: envFor(aliceHome, aliceAccount.apiKey, hubUrl),
  };
  bob = {
    ...bobAccount,
    home: bobHome,
    repo: bobRepo,
    env: envFor(bobHome, bobAccount.apiKey, hubUrl),
  };
  cleanups.push(aliceHome, bobHome, aliceRepo, bobRepo, bobWorktree);
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("two developers on one repo", () => {
  test("Alice's session registers and captures her edited file", async () => {
    // Arrange
    await writeRepoFile(alice.repo, "src/auth/token.ts", "export const a = 1;\n");

    // Act
    const briefing = await runHook(
      "session-start",
      sessionStartPayload(alice.repo, "a-uuid", "Login 500s on staging"),
      alice.env,
    );
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: "a-uuid",
        cwd: alice.repo,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: `${alice.repo}/src/auth/token.ts` },
        tool_response: {},
      }),
      alice.env,
    );

    // Assert
    expect(briefing).toBe("");
    const targets = await db.execute(
      sql`select kind, value from work_context_targets`,
    );
    expect(targets.rows).toEqual([
      { kind: "file", value: "src/auth/token.ts" },
    ]);
  });

  test("Bob's briefing names Alice and quotes her title, never himself", async () => {
    // Act
    const stdout = await runHook(
      "session-start",
      sessionStartPayload(bob.repo, "b-uuid", "Rate limiter drops burst traffic"),
      bob.env,
    );

    // Assert
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const context = parsed.hookSpecificOutput.additionalContext;
    expect(context).toContain("Alice");
    expect(context).toContain("«Login 500s on staging»");
    expect(context).not.toContain("Bob");
    expect(context).not.toContain("b-uuid");
    expect(context).not.toContain("Rate limiter");
    expect(context.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS);
  });

  test("Bob's second worktree does not appear in his own briefing", async () => {
    // Act
    await runHook(
      "session-start",
      sessionStartPayload(bobWorktree, "b-uuid-2"),
      bob.env,
    );
    const stdout = await runHook(
      "session-start",
      sessionStartPayload(bob.repo, "b-uuid-3"),
      bob.env,
    );

    // Assert
    const context = (
      JSON.parse(stdout) as {
        hookSpecificOutput: { additionalContext: string };
      }
    ).hookSpecificOutput.additionalContext;
    expect(context).toContain("Alice");
    expect(context).not.toContain("Bob");
    expect(context).not.toContain("feat/side");
  });

  test("both developers' work contexts land on the same normalized repo", async () => {
    // Act
    const response = await fetch(
      `${hubUrl}/api/work-contexts?repo=${encodeURIComponent(REPO_ID)}`,
      { headers: { Authorization: `Bearer ${alice.apiKey}` } },
    );
    const body = (await response.json()) as {
      data: { workContexts: { title: string }[] };
    };

    // Assert
    const titles = body.data.workContexts.map((context) => context.title);
    expect(titles).toContain("Login 500s on staging");
    expect(titles).toContain("Rate limiter drops burst traffic");
  });

  test("the statusline reports Alice as present on this repo", async () => {
    // Act
    const line = await runStatusline(
      JSON.stringify({ session_id: "b-uuid", cwd: bob.repo }),
      bob.env,
    );

    // Assert
    expect(line).toMatch(/^cx \d+ · /);
    expect(line).toContain("Alice");
    expect(line.length).toBeLessThanOrEqual(90);
  });

  test("a denylisted file never becomes a target", async () => {
    // Arrange
    await writeRepoFile(alice.repo, "bun.lock", "lockfile\n");

    // Act
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: "a-uuid",
        cwd: alice.repo,
        tool_name: "Write",
        tool_input: { file_path: `${alice.repo}/bun.lock` },
        tool_response: {},
      }),
      alice.env,
    );

    // Assert
    const targets = await db.execute(
      sql`select value from work_context_targets where kind = 'file'`,
    );
    expect(targets.rows.map((row) => row["value"])).toEqual([
      "src/auth/token.ts",
    ]);
  });

  test("a failing Bash command becomes a hashed error fingerprint", async () => {
    // Act
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: "a-uuid",
        cwd: alice.repo,
        tool_name: "Bash",
        tool_input: { command: "bun test" },
        tool_response: {
          exitCode: 1,
          stderr: [
            "TypeError: cannot read property 'sub' of undefined",
            `  at verifyToken (${alice.repo}/src/auth/verify.ts:88:3)`,
            "  at Object.<anonymous> (native)",
          ].join("\n"),
        },
      }),
      alice.env,
    );

    // Assert
    const targets = await db.execute(
      sql`select value from work_context_targets where kind = 'error_fingerprint'`,
    );
    expect(targets.rows).toHaveLength(1);
    expect(String(targets.rows[0]?.["value"])).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  test("session end closes the session and removes its state file", async () => {
    // Act
    const stdout = await runHook(
      "session-end",
      JSON.stringify({
        session_id: "a-uuid",
        cwd: alice.repo,
        hook_event_name: "SessionEnd",
        reason: "clear",
      }),
      alice.env,
    );

    // Assert
    expect(stdout).toBe("");
    const sessions = await db.execute(
      sql`select ended_at from agent_sessions where id = 'cc_a-uuid'`,
    );
    expect(sessions.rows[0]?.["ended_at"]).not.toBeNull();
  });
});

describe("hub down", () => {
  const DEAD_PORT = 1;
  let deadEnv: Env;
  let deadKey: string;

  beforeAll(() => {
    deadEnv = envFor(bob.home, bob.apiKey, `http://127.0.0.1:${DEAD_PORT}`);
    deadKey = repoKey(`http://127.0.0.1:${DEAD_PORT}`, REPO_ID);
  });

  test("every hook exits silently and the spool keeps the unsent records", async () => {
    // Act
    const started = await runHook(
      "session-start",
      sessionStartPayload(bob.repo, "offline-uuid", "Offline investigation"),
      deadEnv,
    );
    const captured = await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: "offline-uuid",
        cwd: bob.repo,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: `${bob.repo}/src/limiter.ts` },
        tool_response: {},
      }),
      deadEnv,
    );
    const ended = await runHook(
      "session-end",
      JSON.stringify({ session_id: "offline-uuid", cwd: bob.repo }),
      deadEnv,
    );

    // Assert
    expect([started, captured, ended]).toEqual(["", "", ""]);
    const lines = await readSpoolLines(bob.home, deadKey);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.join("\n")).toContain("src/limiter.ts");
  });

  /**
   * The round trip the spool exists for, driven through the real hook entry
   * points against the real server: records stranded while the hub was
   * unreachable have to reach it once it answers again.
   *
   * The offline session id is chosen so its spool file sorts AFTER the live
   * session's. Flushing in filename order delivered the live session's own
   * record on every hook and never advanced the backlog, which left the
   * developer's offline work to age out and be discarded.
   */
  test("delivers records spooled offline once the hub answers again", async () => {
    // Arrange: a session that started while the hub was up, so its work context
    // exists, and a hub that then stops answering mid-session
    let isReachable = true;
    const flaky = Bun.serve({
      port: 0,
      fetch: (request) =>
        isReachable
          ? app.fetch(request)
          : new Response("service unavailable", { status: 503 }),
    });
    const flakyUrl = `http://127.0.0.1:${flaky.port}`;
    const flakyEnv = envFor(bob.home, bob.apiKey, flakyUrl);
    const flakyKey = repoKey(flakyUrl, REPO_ID);
    const offlineSession = "zz-offline-uuid";
    const liveSession = "aa-live-uuid";

    await runHook(
      "session-start",
      sessionStartPayload(bob.repo, offlineSession, "Offline work"),
      flakyEnv,
    );
    isReachable = false;
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: offlineSession,
        cwd: bob.repo,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: `${bob.repo}/src/offline-only.ts` },
        tool_response: {},
      }),
      flakyEnv,
    );
    const spooledOffline = await readSpoolLines(bob.home, flakyKey);

    // Act: the hub comes back, and a DIFFERENT session runs one SessionStart.
    // Its slug sorts FIRST, so filename order would serve it and never the
    // backlog — the shape that stranded offline work indefinitely.
    isReachable = true;
    await runHook(
      "session-start",
      sessionStartPayload(bob.repo, liveSession, "Back online"),
      flakyEnv,
    );

    // Assert: the offline backlog reached the hub, not just the live session's
    const targets = await db.execute(
      sql`select value from work_context_targets where value = 'src/offline-only.ts'`,
    );
    expect(spooledOffline.length).toBeGreaterThanOrEqual(1);
    expect(targets.rows).toHaveLength(1);
    expect(await readSpoolLines(bob.home, flakyKey)).toHaveLength(0);
    flaky.stop(true);
  });

  test("doctor reports the unreachable hub and a deep spool", async () => {
    // Arrange: 201 pending records is the documented WARN threshold.
    await appendRecords(
      bob.home,
      deadKey,
      "offline-uuid",
      Array.from({ length: 201 }, (_unused, index) => ({
        cx: "0.1",
        id: `env_backlog_${index}`,
        ts: new Date().toISOString(),
        producer: {
          developerId: bob.developerId,
          agentKind: "claude-code",
          sessionId: "cc_offline-uuid",
        },
        kind: "target",
        body: { workContextId: "wc_x", kind: "file", value: `src/f${index}.ts` },
      })),
      new Date(),
    );

    // Act
    const result = await runCli(["doctor"], deadEnv, bob.repo);

    // Assert
    expect(result.stdout).toContain("FAIL  hub reachable");
    expect(result.stdout).toContain("WARN  spool depth");
    expect(result.exitCode).toBe(2);
  });
});
