/**
 * LOSS-8 (docs/1.0/loss-accounting.md §7): every session call carries the
 * report — register, heartbeat and end — and a clean machine still sends a
 * report of zero, because an all-zero report is a statement and an absent
 * one is not (§4.7).
 *
 * The hub here records what it was SENT and answers what the flows need;
 * whether a real hub stores it is packages/server/test/coverage-losses.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { repoKey, sessionSlug } from "../src/config/paths.ts";
import { endSessionFlow } from "../src/flows/end-session.ts";
import { heartbeatMaybe } from "../src/flows/heartbeat.ts";
import { registerSessionFlow } from "../src/flows/register-session.ts";
import type { HubContext } from "../src/http/client.ts";
import { recordDrop } from "../src/spool/drops.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const NOW = new Date("2026-09-20T10:00:00.000Z");
const DROP_AT = new Date("2026-09-19T10:00:00.000Z");
const GENEROUS_BUDGET_MS = 3000;

interface Call {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

const calls: Call[] = [];
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const cleanups: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ path: pathname, body });
      if (pathname === "/api/sessions") {
        return Response.json({ ok: true, data: { session: { id: body["id"], developerId: "dev_1" } } });
      }
      if (pathname === "/api/records") {
        const records = (body["records"] as unknown[] | undefined) ?? [];
        return Response.json({
          ok: true,
          data: { accepted: records.length, duplicates: 0, ignored: 0, rejected: 0 },
        });
      }
      return Response.json({ ok: true, data: {} });
    },
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const hubFor = (home: string, key: string): HubContext => ({
  hubUrl,
  apiKey: "key",
  timeoutMs: 4000,
  home,
  repoKey: key,
  now: () => NOW,
});

const fixture = async (label: string): Promise<{ home: string; repo: string; key: string }> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  return { home, repo, key: repoKey(hubUrl, REPO_ID) };
};

const lossesOf = (path: string, sinceIndex: number): Record<string, unknown> | undefined => {
  const call = calls.slice(sinceIndex).find((entry) => entry.path === path || entry.path.endsWith(path));
  return call?.body["losses"] as Record<string, unknown> | undefined;
};

const runAllThree = async (fx: { home: string; repo: string; key: string }, hostSessionKey: string) => {
  const hub = hubFor(fx.home, fx.key);
  const from = calls.length;
  const registered = await registerSessionFlow({
    home: fx.home,
    repoKey: fx.key,
    hub,
    agentKind: "acp:test",
    hostSessionKey,
    repoId: REPO_ID,
    repoRoot: fx.repo,
    branch: "main",
    baseCommit: "0000000000000000000000000000000000000000",
    hubUrl,
    fallbackDeveloperId: null,
    title: "main @ api",
    status: "analyzing",
    now: NOW,
    guarantees: [],
  });
  await heartbeatMaybe({
    hub,
    crosscheckSessionId: registered.crosscheckSessionId,
    lastHeartbeatAt: null,
    now: NOW,
  });
  await endSessionFlow({
    home: fx.home,
    repoKey: fx.key,
    hub,
    hostSessionKey,
    crosscheckSessionId: registered.crosscheckSessionId,
    developerId: registered.developerId,
    flushBudgetMs: GENEROUS_BUDGET_MS,
    now: () => NOW,
  });
  return { from, sessionId: registered.crosscheckSessionId };
};

describe("LOSS-8: every session call carries the report", () => {
  test("a ledger with a loss reaches register, heartbeat and end", async () => {
    // Arrange
    const fx = await fixture("losses-carried");
    await recordDrop(fx.home, fx.key, sessionSlug("earlier-session"), 3, "expired", DROP_AT);

    // Act
    const { from, sessionId } = await runAllThree(fx, "host-carried");

    // Assert
    for (const path of ["/api/sessions", `/${sessionId}/heartbeat`, `/${sessionId}/end`]) {
      const losses = lossesOf(path, from);
      expect(losses, path).toBeDefined();
      expect(losses?.["total"], path).toBe(3);
      expect((losses?.["kinds"] as Record<string, number>)["spool_expired"], path).toBe(3);
      expect(losses?.["newestAt"], path).toBe(DROP_AT.toISOString());
    }
  });

  test("a clean machine still sends a report of zero on every call", async () => {
    // Arrange
    const fx = await fixture("losses-zero");

    // Act
    const { from, sessionId } = await runAllThree(fx, "host-zero");

    // Assert
    for (const path of ["/api/sessions", `/${sessionId}/heartbeat`, `/${sessionId}/end`]) {
      const losses = lossesOf(path, from);
      expect(losses, path).toEqual({ total: 0, kinds: {}, oldestAt: null, newestAt: null });
    }
  });
});
