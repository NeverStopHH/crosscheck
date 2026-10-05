/**
 * `crosscheck status` groups a teammate's live sessions by TOPIC, with the
 * same grouping the briefing runs (connector-core briefing/topic-group.ts):
 * it printed one line per SESSION, so a teammate live in six subagent and
 * worktree sessions took six lines, three of them the same branch. A real hub
 * over PGlite, two teammates: Ken with one session, Nick with six on four
 * branches, heartbeats pinned so the order is the test's and not the clock's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";

import { createDb, createServer } from "@crosscheck/server";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "status-topics-admin";
const REPO_ID = "github.com/acme/api";

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let home: string;
let repo: string;
let readerKey: string;

const createDeveloper = async (name: string, email: string): Promise<string> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, email }),
  });
  const body = (await response.json()) as { data: { apiKey: string } };
  return body.data.apiKey;
};

const registerSession = async (
  apiKey: string,
  id: string,
  branch: string,
  status: string,
): Promise<void> => {
  await fetch(`${hubUrl}/api/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id, agentKind: "claude-code", repo: REPO_ID, branch, baseCommit: "a1b2c3d4", status }),
  });
};

/** Nick's six live sessions, freshest first: [id, branch, status, seconds ago]. */
const NICK_SESSIONS: readonly (readonly [string, string, string, number])[] = [
  ["cc_nick_a1", "feat/a", "analyzing", 10],
  ["cc_nick_a2", "feat/a", "implementing", 20],
  ["cc_nick_a3", "feat/a", "analyzing", 30],
  ["cc_nick_b", "feat/b", "analyzing", 40],
  ["cc_nick_c", "feat/c", "analyzing", 50],
  ["cc_nick_d", "feat/d", "analyzing", 60],
];

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  home = await makeHome("status-topics");
  repo = await makeRepo("status-topics", { remote: "git@github.com:acme/api.git" });
  readerKey = await createDeveloper("Reader", "reader@example.com");
  const kenKey = await createDeveloper("Ken", "ken@example.com");
  const nickKey = await createDeveloper("Nick", "nick@example.com");
  await registerSession(kenKey, "cc_ken", "feat/auth", "analyzing");
  for (const [id, branch, status] of NICK_SESSIONS) {
    await registerSession(nickKey, id, branch, status);
  }
  // Pin every heartbeat inside the presence TTL, in the order the test reads.
  await db.execute(sql`UPDATE agent_sessions SET last_heartbeat_at = now() - interval '5 seconds' WHERE id = 'cc_ken'`);
  for (const [id, , , secondsAgo] of NICK_SESSIONS) {
    await db.execute(
      sql`UPDATE agent_sessions SET last_heartbeat_at = now() - make_interval(secs => ${secondsAgo}) WHERE id = ${id}`,
    );
  }
});

afterAll(async () => {
  server.stop(true);
  await Promise.all([home, repo].map((path) => rm(path, { recursive: true, force: true })));
});

const teammateBlock = async (): Promise<readonly string[]> => {
  const result = await runCli(
    ["status"],
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: readerKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    repo,
  );
  const lines = result.stdout.split("\n");
  const start = lines.indexOf("teammates:");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !line.startsWith("  "));
  return end === -1 ? rest : rest.slice(0, end);
};

describe("crosscheck status teammates, grouped by topic", () => {
  test("one teammate is one entry, their sessions grouped by branch and the rest counted", async () => {
    const block = await teammateBlock();

    expect(block).toEqual([
      "  - Ken · feat/auth · analyzing",
      "  - Nick · 4 topics, 6 sessions",
      "    feat/a · implementing · 3 sessions",
      "    feat/b · analyzing",
      "    feat/c · analyzing",
      "    … and 1 more topic",
    ]);
  });
});
