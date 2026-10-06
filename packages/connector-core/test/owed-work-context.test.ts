/**
 * THE WORK CONTEXT A HEAL OWES (review-2 round 6, HIGH-1).
 *
 * A heal that registers a life — the same id or the next — owes the hub that
 * life's work context: every record of the life names it, and the copy
 * spooled at registration may have been spent. The heal used to send it once,
 * ahead of its one re-send, and spool a second copy at the tail. When that
 * re-send failed — a 503, a timeout, no room left, or a full batch plus the
 * work context past the hub's batch limit — the next flush sent the backlog
 * with no work context ahead of it, and every record was refused as
 * `author_unknown` and spent: 100 of 100, 150 of 150, 3 of 3 with one 503.
 *
 * Now the debt is persisted beside the spool and paid by whichever flush
 * carries the life's records next, at the head of a batch sized one short of
 * the limit, until the hub takes it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { repoKey, sessionSlug, spoolOwedWorkContextPath } from "../src/config/paths.ts";
import { targetRecord, workContextRecord } from "../src/capture/records.ts";
import type { Producer } from "../src/capture/records.ts";
import type { HubContext } from "../src/http/client.ts";
import { endSessionFlow } from "../src/flows/end-session.ts";
import { sessionHealer } from "../src/flows/heal-session.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { appendRecords } from "../src/spool/append.ts";
import { writeCursorOffset } from "../src/spool/cursor.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import { flushSpool } from "../src/spool/flush.ts";
import { oweWorkContext } from "../src/spool/owed-work-context.ts";
import { reapSpool } from "../src/spool/reap.ts";
import { readSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "owed-admin";
const REPO_ID = "github.com/acme/api";
const BRANCH = "main";
const BASE_COMMIT = "0000000000000000000000000000000000000000";
const TIMEOUT_MS = 4000;
const BUDGET_MS = 3000;
/** A request timeout the held re-send outlasts. */
const SHORT_TIMEOUT_MS = 300;
const HOLD_PAST_TIMEOUT_MS = 600;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let proxyUrl: string;
let apiKey: string;
let developerId: string;
/** The proxy's dials: refuse every register; flap the Nth record delivery, or hold it past the timeout and drop it. */
let refuseRegisters = false;
let recordPosts = 0;
let flapRecordPostAt = -1;
let holdRecordPostAt = -1;
const cleanups: string[] = [];

const raw = async <T>(text: string, params: readonly unknown[] = []): Promise<readonly T[]> =>
  (
    await (db as unknown as { $client: { query: (q: string, p: readonly unknown[]) => Promise<{ rows: T[] }> } })
      .$client.query(text, params)
  ).rows;

interface Fixture {
  readonly home: string;
  readonly repo: string;
  readonly key: string;
  readonly hub: HubContext;
  readonly hostSessionKey: string;
}

const fixture = async (label: string, timeoutMs: number = TIMEOUT_MS): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const key = repoKey(proxyUrl, REPO_ID);
  return {
    home,
    repo,
    key,
    hostSessionKey: `acp-owed--${label}`,
    hub: { hubUrl: proxyUrl, apiKey, timeoutMs, home, repoKey: key, now: () => new Date() },
  };
};

const register = (fx: Fixture, hostSessionKey: string = fx.hostSessionKey) =>
  registerSessionFlow({
    home: fx.home,
    repoKey: fx.key,
    hub: fx.hub,
    agentKind: "acp:test",
    hostSessionKey,
    repoId: REPO_ID,
    repoRoot: fx.repo,
    branch: BRANCH,
    baseCommit: BASE_COMMIT,
    hubUrl: fx.hub.hubUrl,
    fallbackDeveloperId: developerId,
    title: fallbackWorkContextTitle(BRANCH, REPO_ID),
    status: "analyzing",
    now: new Date(),
    guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
  });

const healerFor = (fx: Fixture) =>
  sessionHealer({
    home: fx.home,
    repoKey: fx.key,
    hub: fx.hub,
    agentKind: "acp:test",
    hostSessionKey: fx.hostSessionKey,
    repoId: REPO_ID,
    branch: BRANCH,
    baseCommit: BASE_COMMIT,
    guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
    now: () => new Date(),
  });

const flushAsHook = async (fx: Fixture): Promise<void> => {
  const state = await readSessionState(fx.home, fx.hostSessionKey);
  if (state === null) throw new Error("no session state");
  await flushSpool(fx.hub, { sessionId: state.crosscheckSessionId, developerId, heal: healerFor(fx) }, BUDGET_MS);
};

const producerOf = (sessionId: string): Producer => ({ developerId, agentKind: "acp:test", sessionId });

const targets = (life: { workContextId: string; crosscheckSessionId: string }, n: number, tag: string) =>
  Array.from({ length: n }, (_, index) =>
    targetRecord(
      life.workContextId,
      "file",
      `src/${tag}-${String(index).padStart(3, "0")}.ts`,
      producerOf(life.crosscheckSessionId),
      new Date(),
    ),
  );

const targetsOf = async (workContextId: string): Promise<number> =>
  (await raw<{ n: number }>("select count(*)::int as n from work_context_targets where work_context_id = $1", [workContextId]))[0]
    ?.n ?? 0;

const isOwed = async (fx: Fixture): Promise<boolean> =>
  Bun.file(spoolOwedWorkContextPath(fx.home, fx.key, sessionSlug(fx.hostSessionKey))).exists();

/** An unregistered life whose spooled work context an older connector's flush spent. */
const lifeWithSpentWorkContext = async (fx: Fixture) => {
  refuseRegisters = true;
  const life = await register(fx);
  refuseRegisters = false;
  const spool = await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey));
  await writeCursorOffset(spool.dataPath, spool.cursorPath, spool.size, spool);
  return life;
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;
  proxy = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname, search } = new URL(request.url);
      if (request.method === "POST" && pathname === "/api/records") {
        recordPosts += 1;
        if (recordPosts === flapRecordPostAt) {
          return Response.json({ ok: false, error: { code: "unavailable", message: "flap" } }, { status: 503 });
        }
        if (recordPosts === holdRecordPostAt) {
          // Answered after the client gave up, and never forwarded: lost.
          await Bun.sleep(HOLD_PAST_TIMEOUT_MS);
          return Response.json({ ok: false, error: { code: "unavailable", message: "late" } }, { status: 503 });
        }
      }
      if (request.method === "POST" && pathname === "/api/sessions" && refuseRegisters) {
        return Response.json({ ok: false, error: { code: "unavailable", message: "down" } }, { status: 503 });
      }
      return fetch(`${hubUrl}${pathname}${search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" ? undefined : await request.arrayBuffer(),
      });
    },
  });
  proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Owed", email: "owed@example.com" }),
  });
  const body = (await response.json()) as { data: { developer: { id: string }; apiKey: string } };
  apiKey = body.data.apiKey;
  developerId = body.data.developer.id;
});

afterAll(async () => {
  proxy.stop(true);
  server.stop(true);
  await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close().catch(() => undefined);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("the work context a heal owes", () => {
  for (const n of [100, 150]) {
    test(`reaches the hub ahead of a backlog of ${String(n)} records, and every one lands`, async () => {
      // Arrange: a full re-send plus the work context is past the hub's batch limit
      const fx = await fixture(`backlog-${String(n)}`);
      const life = await lifeWithSpentWorkContext(fx);
      await appendRecords(fx.home, fx.key, fx.hostSessionKey, targets(life, n, "t"), new Date());

      // Act: the flush whose walk heals, and the next ones
      for (let flush = 0; flush < 3; flush += 1) {
        await flushAsHook(fx);
      }

      // Assert
      expect(await targetsOf(life.workContextId)).toBe(n);
      expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
      expect(await isOwed(fx)).toBe(false);
    });
  }

  test("is still owed when the heal's re-send meets a 503, and the next flush pays it", async () => {
    // Arrange
    const fx = await fixture("flap");
    const life = await lifeWithSpentWorkContext(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, targets(life, 3, "flap"), new Date());
    flapRecordPostAt = recordPosts + 2;

    // Act: the refused batch, the walk, the re-send the hub drops — then two flushes
    await flushAsHook(fx);
    const owedAfterFlap = await isOwed(fx);
    flapRecordPostAt = -1;
    await flushAsHook(fx);
    await flushAsHook(fx);

    // Assert
    expect(owedAfterFlap).toBe(true);
    expect(await targetsOf(life.workContextId)).toBe(3);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
  });

  test("is still owed when the heal's re-send times out, and the next flush pays it", async () => {
    // Arrange: a request timeout the re-send outlasts
    const fx = await fixture("timeout", SHORT_TIMEOUT_MS);
    const life = await lifeWithSpentWorkContext(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, targets(life, 3, "slow"), new Date());
    holdRecordPostAt = recordPosts + 2;

    // Act
    await flushAsHook(fx);
    holdRecordPostAt = -1;
    await Bun.sleep(HOLD_PAST_TIMEOUT_MS);
    await flushAsHook(fx);
    await flushAsHook(fx);

    // Assert
    expect(await targetsOf(life.workContextId)).toBe(3);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
  });

  test("outlives SessionEnd: the end defers, and a successor pays it ahead of the life's records", async () => {
    // Arrange: a healed life with its records on disk and the work context owed
    const fx = await fixture("outlives-end");
    const life = await lifeWithSpentWorkContext(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, targets(life, 2, "end"), new Date());
    flapRecordPostAt = recordPosts + 2;
    await flushAsHook(fx);
    flapRecordPostAt = -1;

    // Act: SessionEnd with no room to drain, then another conversation's flush
    const ended = await endSessionFlow({
      home: fx.home,
      repoKey: fx.key,
      hub: fx.hub,
      hostSessionKey: fx.hostSessionKey,
      crosscheckSessionId: life.crosscheckSessionId,
      developerId,
      flushBudgetMs: 0,
      now: () => new Date(),
    });
    const other = await register(fx, `${fx.hostSessionKey}-other`);
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, BUDGET_MS);

    // Assert
    expect(ended.ended).toBe(false);
    expect(await targetsOf(life.workContextId)).toBe(2);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
    expect(await isOwed(fx)).toBe(false);
  });

  test("stays owed while the hub refuses it, and the life's own records wait with it", async () => {
    // Arrange: a registered life whose spooled work context was spent, and a
    // debt the hub's schema refuses (an empty title)
    const fx = await fixture("refused-debt");
    const life = await register(fx);
    const spool = await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey));
    await writeCursorOffset(spool.dataPath, spool.cursorPath, spool.size, spool);
    await oweWorkContext(fx.home, fx.key, sessionSlug(fx.hostSessionKey), {
      sessionId: life.crosscheckSessionId,
      record: workContextRecord(
        { workContextId: life.workContextId, sessionId: life.crosscheckSessionId, title: "", status: "analyzing" },
        producerOf(life.crosscheckSessionId),
        new Date(),
      ),
    });
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, targets(life, 1, "pinned"), new Date());

    // Act
    await flushAsHook(fx);

    // Assert: refused for the work context it is owed, so kept, not spent
    expect((await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey))).lines.length).toBe(1);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
    expect(await isOwed(fx)).toBe(true);
  });

  test("goes when nothing will ever pay it: no live session, no spool", async () => {
    // Arrange: a debt left by a host session that ended with no records on disk
    const fx = await fixture("orphan-debt");
    const slug = sessionSlug("acp-owed--gone");
    await oweWorkContext(fx.home, fx.key, slug, {
      sessionId: "cc_acp-owed--gone",
      record: workContextRecord(
        { workContextId: "wc_cc_acp-owed--gone", sessionId: "cc_acp-owed--gone", title: "t", status: "analyzing" },
        producerOf("cc_acp-owed--gone"),
        new Date(),
      ),
    });

    // Act
    await reapSpool(fx.home, fx.key, new Date());

    // Assert
    expect(await Bun.file(spoolOwedWorkContextPath(fx.home, fx.key, slug)).exists()).toBe(false);
  });
});
