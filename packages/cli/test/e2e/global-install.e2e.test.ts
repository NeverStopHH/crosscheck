/**
 * THE NICK TEST (finding #11): a fresh `git worktree` of a connected repo.
 * The checkout carries the committed .crosscheck.json, but
 * .claude/settings.json is per-machine and gitignored in that repo — so on
 * the pre-fix tree the new worktree was deaf: no project settings, no
 * hooks, silence, and the interim cure was hand-copying settings files.
 *
 * After `crosscheck init --global` the wiring lives in the USER settings
 * (~/.claude/settings.json), which Claude Code loads for every session on
 * the machine — so the worktree session registers with the hub through the
 * exact command string the global install wrote, spawned the way Claude
 * Code spawns hooks. RED ON MAIN by construction: `init --global` was an
 * unknown flag there, so the install step of this test exits 64 and the
 * spawn never happens.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { runCli } from "../../src/index.ts";
import { saveConfig } from "@crosscheck/connector-core/config/config.ts";
import { renderRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { git, makeRepo } from "../../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "e2e-admin-token";
/** Wide enough that a cold PGlite query never trips the fail-open budget. */
const TEST_TIMEOUT_MS = "4000";
const SESSION_ID = "worktree-uuid";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let home: string;
let mainCheckout: string;
let worktree: string;
const cleanups: string[] = [];

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
    body: JSON.stringify({ name: "Nick", email: "nick@example.com" }),
  });
  if (!response.ok) {
    throw new Error(
      `createDeveloper failed: ${String(response.status)} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { data: { apiKey: string } };

  home = await mkdtemp(join(tmpdir(), "cx-nick-home-"));
  cleanups.push(home);
  // What `crosscheck login` leaves behind. The hub url the SESSION uses
  // must come through the worktree's committed config (§2.1).
  await saveConfig(join(home, ".crosscheck"), {
    version: 1,
    hubUrl,
    apiKey: body.data.apiKey,
  });

  // The connected repo: .crosscheck.json COMMITTED, exactly what a
  // project-scoped init leaves in version control.
  mainCheckout = await makeRepo("nick-main", {
    remote: "git@github.com:acme/api.git",
  });
  cleanups.push(mainCheckout);
  await Bun.write(join(mainCheckout, ".crosscheck.json"), renderRepoConfig(hubUrl));
  await git(mainCheckout, ["add", ".crosscheck.json"]);
  await git(mainCheckout, ["commit", "-m", "connect repo"]);

  // The fresh worktree: committed config arrives with the checkout, the
  // per-machine .claude/settings.json does NOT.
  worktree = join(await mkdtemp(join(tmpdir(), "cx-worktrees-")), "feature");
  cleanups.push(dirname(worktree));
  await git(mainCheckout, ["worktree", "add", worktree, "HEAD"]);
});

afterAll(async () => {
  server.stop(true);
  await (db as unknown as { $client: { close: () => Promise<void> } }).$client
    .close()
    .catch(() => undefined);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("a fresh worktree under a global install", () => {
  test("registers through the user-scope wiring the install wrote", async () => {
    // Arrange: install the global wiring (sandboxed HOME)
    const env = {
      HOME: home,
      CROSSCHECK_HOME: join(home, ".crosscheck"),
      CROSSCHECK_TIMEOUT_MS: TEST_TIMEOUT_MS,
      // No `crosscheck` on this PATH: the launcher must fall back to the
      // durable absolute entry, which is what a real dev machine without a
      // global npm install gets.
      PATH: "",
    };
    const install = await runCli(["init", "--global"], env, worktree);
    expect(install.exitCode).toBe(0);

    // The worktree really is the Nick shape: committed config present,
    // project settings absent
    expect(await readFile(join(worktree, ".crosscheck.json"), "utf8")).toContain(
      hubUrl,
    );
    expect(await Bun.file(join(worktree, ".claude", "settings.json")).exists()).toBe(
      false,
    );

    // Act: spawn the EXACT SessionStart command the global install wrote,
    // the way Claude Code spawns hooks — sh -c, payload on stdin, cwd at
    // the worktree
    const settings = JSON.parse(
      await readFile(join(home, ".claude", "settings.json"), "utf8"),
    ) as {
      hooks: Record<string, readonly { hooks: readonly { command: string }[] }[]>;
    };
    const groups = settings.hooks["SessionStart"] ?? [];
    const command = groups[groups.length - 1]?.hooks[0]?.command;
    expect(command).toBeDefined();
    const proc = Bun.spawn({
      cmd: ["sh", "-c", String(command)],
      cwd: worktree,
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: SESSION_ID,
          cwd: worktree,
          hook_event_name: "SessionStart",
          source: "startup",
        }),
      ),
      stdout: "pipe",
      stderr: "ignore",
      env: {
        ...process.env,
        HOME: home,
        CROSSCHECK_HOME: join(home, ".crosscheck"),
        CROSSCHECK_TIMEOUT_MS: TEST_TIMEOUT_MS,
      },
    });
    const exitCode = await proc.exited;

    // Assert: the hook ran clean and the session is REGISTERED — state
    // file bound to the repo's identity, session row on the hub
    expect(exitCode).toBe(0);
    const state = await readSessionState(join(home, ".crosscheck"), SESSION_ID);
    expect(state?.repoId).toBe("github.com/acme/api");
    expect(state?.hubUrl).toBe(hubUrl);
    const sessions = await db.execute(
      sql`select id from agent_sessions where id = ${`cc_${SESSION_ID}`}`,
    );
    expect(sessions.rows).toHaveLength(1);
  });
});
