/**
 * D1 END TO END — the claim lands, the position does not, and the hub knows
 * which of the two happened.
 *
 * `mcp-seq.test.ts` pins the picker's boolean; this pins what an MCP tool DOES
 * with it against a real hub, because the whole decision is about what survives
 * a wrong guess: the record must arrive, and the hub must record `allocation_failed`
 * rather than a position it cannot trust.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer, readSessionCausalOrder } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { prepareMcp } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "mcp-seq-admin-token";
const REPO_ID = "github.com/acme/api";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const cleanups: string[] = [];

beforeAll(async () => {
  db = await createDb();
  const app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface Fixture {
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
  readonly sessionId: string;
}

/** One developer, one hub session, and N state files sharing ONE worktree. */
const setUp = async (label: string, siblings: number): Promise<Fixture> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: label, email: `${label}@example.com` }),
  });
  const account = (
    (await response.json()) as {
      data: { developer: { id: string }; apiKey: string };
    }
  ).data;
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);

  // The NEWEST state file is the one the picker returns, so it is the session
  // the tool writes to whether or not the pick was a guess.
  const chosen = `${label}-0-uuid`;
  const sessionId = `cc_${chosen}`;
  for (let index = 0; index < siblings; index += 1) {
    const key = `${label}-${String(index)}-uuid`;
    const id = `cc_${key}`;
    const startedAt = new Date(Date.now() - index * 60_000).toISOString();
    await fetch(`${hubUrl}/api/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id,
        agentKind: "claude-code",
        repo: REPO_ID,
        branch: "main",
        baseCommit: "a1b2c3d4",
        status: "analyzing",
      }),
    });
    await fetch(`${hubUrl}/api/records`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cx: "0.1",
        id: `env_${crypto.randomUUID()}`,
        ts: startedAt,
        producer: {
          developerId: account.developer.id,
          agentKind: "claude-code",
          sessionId: id,
        },
        kind: "work_context",
        body: {
          id: `wc_${id}`,
          sessionId: id,
          title: "Login 500s on staging",
          status: "analyzing",
          createdAt: startedAt,
        },
      }),
    });
    await writeSessionState(home, {
      hostSessionKey: key,
      crosscheckSessionId: id,
      workContextId: `wc_${id}`,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl,
      developerId: account.developer.id,
      startedAt,
      lastHeartbeatAt: startedAt,
      workContextTitle: "Login 500s on staging",
      workContextStatus: "analyzing",
      seqEpoch: EPOCH,
      eventSeq: 0,
    });
  }
  return {
    home,
    repo,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: account.apiKey,
    },
    sessionId,
  };
};

const publish = async (fixture: Fixture, body: string): Promise<string> => {
  const setup = await prepareMcp(fixture.env, fixture.repo);
  if (!setup.ok) {
    throw new Error(`prepareMcp failed: ${setup.message}`);
  }
  const tool = findTool("publish_claim");
  if (tool === undefined) {
    throw new Error("publish_claim is not registered");
  }
  const result = await tool.run(setup.ctx, {
    kind: "observation",
    body,
    confidence: 0.6,
  });
  return result.content.map((entry) => entry.text).join("\n");
};

/**
 * The hub's own public answer, not a peek at its rows: `readSessionCausalOrder`
 * is what spec 04's verdict and spec 06's timing will both call, so asserting
 * through it is asserting what a consumer will actually see.
 */
const orderOf = async (sessionId: string) =>
  readSessionCausalOrder(db, sessionId);

describe("D1 — an ambiguous session refuses the position, not the record", () => {
  test("one session in the worktree: the claim lands WITH a position", async () => {
    // Arrange
    const fixture = await setUp("mcpseqalone", 1);

    // Act
    const text = await publish(fixture, "the refresh path drops the retry header");

    // Assert
    expect(text).toContain("Recorded");
    const order = await orderOf(fixture.sessionId);
    expect(order.state).toBe("usable");
    expect(order.reason).toBe("sequenced");
    expect(order.epochs).toBe(1);
  });

  test("two sessions in one worktree: the claim lands WITHOUT one, and says why", async () => {
    // Arrange: two state files, one worktree, one hub — the shape the picker's
    // own header calls indistinguishable.
    const fixture = await setUp("mcpseqambig", 2);

    // Act
    const text = await publish(fixture, "the token cache is never invalidated");

    // Assert: the claim is NOT refused — the work survives.
    expect(text).toContain("Recorded");
    // ...and its position is withheld with a reason a consumer can read,
    // never guessed and never a silent null.
    const order = await orderOf(fixture.sessionId);
    expect(order.state).toBe("unsequenced");
    expect(order.reason).toBe("allocation_failed");
    expect(order.epochs).toBe(0);
  });

  test("an ambiguous call moves NO session's counter", async () => {
    // Arrange: the damage a guess does is not only to this record — taking a
    // position bumps the counter of a session that did not emit anything, so
    // every later position in THAT session is shifted by somebody else's work.
    const fixture = await setUp("mcpseqcounter", 2);
    const { readSessionState } = await import("../src/state/session-state.ts");

    // Act
    await publish(fixture, "a second finding entirely, on the same worktree");

    // Assert
    for (const index of [0, 1]) {
      const state = await readSessionState(
        fixture.home,
        `mcpseqcounter-${String(index)}-uuid`,
      );
      expect(state?.eventSeq).toBe(0);
    }
  });
});
