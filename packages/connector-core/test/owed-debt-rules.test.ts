/**
 * THE OWED WORK CONTEXT'S BOUND (review-2 round 7).
 *
 * - A debt the hub refuses OWED_WORK_CONTEXT_MAX_REFUSALS times, or
 *   past MAX_SPOOL_AGE_DAYS since its first refusal, is released — it and the
 *   records it pinned counted `owed_wc_refused` — and a pinned spool is
 *   skipped for the rest of the drain, never failing it (M3, P1).
 * - And the guards the round-6 review's mutations changed unnoticed (O1, O3,
 *   O4b, O5, O7, O8, O10, O11b).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY, OWED_WORK_CONTEXT_MAX_REFUSALS } from "../src/constants.ts";
import {
  readTextOrNull,
  repoKey,
  sessionSlug,
  sessionStatePath,
  spoolOwedWorkContextPath,
  spoolRefusedLivesPath,
} from "../src/config/paths.ts";
import { targetRecord, workContextRecord } from "../src/capture/records.ts";
import type { Producer } from "../src/capture/records.ts";
import type { HubContext } from "../src/http/client.ts";
import { endSession } from "../src/http/hub.ts";
import { endSessionFlow } from "../src/flows/end-session.ts";
import { sessionHealer } from "../src/flows/heal-session.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { appendRecords } from "../src/spool/append.ts";
import { writeCursorOffset } from "../src/spool/cursor.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import { flushSpool } from "../src/spool/flush.ts";
import { oweWorkContext, readOwedWorkContext, settleOwedWorkContext } from "../src/spool/owed-work-context.ts";
import { reapSpool } from "../src/spool/reap.ts";
import { recordRefusedLife } from "../src/spool/refused-lives.ts";
import { toLines } from "../src/spool/lines.ts";
import { readSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "owed-rules-admin";
const REPO_ID = "github.com/acme/api";
const BRANCH = "main";
const BASE_COMMIT = "0000000000000000000000000000000000000000";
const TIMEOUT_MS = 4000;
const BUDGET_MS = 3000;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let proxyUrl: string;
let apiKey: string;
let developerId: string;
/** The proxy's dials: refuse registers; refuse these lives' work contexts (a blank title). */
let refuseRegisters = false;
const refusedWorkContextsOf = new Set<string>();
const cleanups: string[] = [];

interface WireRecord {
  readonly kind: string;
  readonly body: { readonly id?: string; readonly sessionId?: string; readonly workContextId?: string; readonly title?: string };
}

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
  readonly clock: { ms: number };
}

const fixture = async (label: string): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const key = repoKey(proxyUrl, REPO_ID);
  const clock = { ms: Date.now() };
  return {
    home,
    repo,
    key,
    hostSessionKey: `acp-rules--${label}`,
    clock,
    hub: { hubUrl: proxyUrl, apiKey, timeoutMs: TIMEOUT_MS, home, repoKey: key, now: () => new Date(clock.ms) },
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
    now: fx.hub.now,
  });

const flushAsHook = async (fx: Fixture) => {
  const state = await readSessionState(fx.home, fx.hostSessionKey);
  if (state === null) throw new Error("no session state");
  return flushSpool(fx.hub, { sessionId: state.crosscheckSessionId, developerId, heal: healerFor(fx) }, BUDGET_MS);
};

const producerOf = (sessionId: string): Producer => ({ developerId, agentKind: "acp:test", sessionId });

const target = (sessionId: string, workContextId: string, file: string) =>
  targetRecord(workContextId, "file", file, producerOf(sessionId), new Date());

const targetsOf = async (workContextId: string): Promise<number> =>
  (await raw<{ n: number }>("select count(*)::int as n from work_context_targets where work_context_id = $1", [workContextId]))[0]
    ?.n ?? 0;

const owedOf = (fx: Fixture) => readOwedWorkContext(fx.home, fx.key, sessionSlug(fx.hostSessionKey));

const pending = async (fx: Fixture): Promise<number> =>
  (await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey))).lines.length;

/** A debt for a life of the fixture's host session, as a heal writes it. */
const owe = (fx: Fixture, sessionId: string, title: string = "Owed", status: string = "analyzing") =>
  oweWorkContext(fx.home, fx.key, sessionSlug(fx.hostSessionKey), {
    sessionId,
    record: workContextRecord({ workContextId: `wc_${sessionId}`, sessionId, title, status }, producerOf(sessionId), new Date()),
  });

/** A life whose register the hub refused and whose spooled work context an older connector spent. */
const lifeWithSpentWorkContext = async (fx: Fixture) => {
  refuseRegisters = true;
  const life = await register(fx);
  refuseRegisters = false;
  const spool = await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey));
  await writeCursorOffset(spool.dataPath, spool.cursorPath, spool.size, spool);
  return life;
};

const refusingWorkContexts = (records: readonly WireRecord[]): readonly WireRecord[] =>
  records.map((record) =>
    record.kind === "work_context" && refusedWorkContextsOf.has(record.body.sessionId ?? "")
      ? { ...record, body: { ...record.body, title: "" } }
      : record,
  );

const forward = async (request: Request, pathname: string, search: string): Promise<Response> => {
  const sent = (await request.json()) as { records: WireRecord[] };
  const records = refusingWorkContexts(sent.records);
  return fetch(`${hubUrl}${pathname}${search}`, { method: "POST", headers: request.headers, body: JSON.stringify({ ...sent, records }) });
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;
  proxy = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname, search } = new URL(request.url);
      if (request.method === "POST" && pathname === "/api/sessions" && refuseRegisters) {
        return Response.json({ ok: false, error: { code: "unavailable", message: "down" } }, { status: 503 });
      }
      if (request.method === "POST" && pathname === "/api/records") {
        return forward(request, pathname, search);
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
    body: JSON.stringify({ name: "Rules", email: "rules@example.com" }),
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

describe("a debt the hub refuses for good (M3, P1)", () => {
  test(`is released after ${String(OWED_WORK_CONTEXT_MAX_REFUSALS)} refusals: it and the records it pinned counted owed_wc_refused`, async () => {
    // Arrange: a life the hub never registered, whose work context it now refuses every time
    const fx = await fixture("released");
    const life = await lifeWithSpentWorkContext(fx);
    refusedWorkContextsOf.add(life.crosscheckSessionId);
    await appendRecords(
      fx.home,
      fx.key,
      fx.hostSessionKey,
      [target(life.crosscheckSessionId, life.workContextId, "src/a.ts"), target(life.crosscheckSessionId, life.workContextId, "src/b.ts")],
      new Date(),
    );

    // Act: one flush per refusal
    const refusals: number[] = [];
    for (let flush = 0; flush < OWED_WORK_CONTEXT_MAX_REFUSALS; flush += 1) {
      await flushAsHook(fx);
      refusals.push((await owedOf(fx))?.refusals ?? -1);
    }
    refusedWorkContextsOf.delete(life.crosscheckSessionId);

    // Assert: counted once each, the debt gone, the spool drained
    const counting = Array.from({ length: OWED_WORK_CONTEXT_MAX_REFUSALS - 1 }, (_, index) => index + 1);
    expect(refusals).toEqual([...counting, -1]);
    expect((await readDropDetail(fx.home, fx.key)).rejectedCauses).toEqual({ owed_wc_refused: 3 });
    expect(await owedOf(fx)).toBeNull();
    expect(await pending(fx)).toBe(0);
  });

  test("is released past MAX_SPOOL_AGE_DAYS from its first refusal, however few refusals", async () => {
    // Arrange: one refusal now
    const fx = await fixture("released-by-age");
    const life = await lifeWithSpentWorkContext(fx);
    refusedWorkContextsOf.add(life.crosscheckSessionId);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, [target(life.crosscheckSessionId, life.workContextId, "src/a.ts")], new Date());
    await flushAsHook(fx);
    const firstRefusal = await owedOf(fx);

    // Act: the next flush a week and a day later
    fx.clock.ms += (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY;
    await flushAsHook(fx);
    refusedWorkContextsOf.delete(life.crosscheckSessionId);

    // Assert
    expect(firstRefusal?.refusals).toBe(1);
    expect(await owedOf(fx)).toBeNull();
    expect((await readDropDetail(fx.home, fx.key)).rejectedCauses).toEqual({ owed_wc_refused: 2 });
  });

  test("pins its own spool for the rest of the drain only: an ended conversation's records behind it go", async () => {
    // Arrange: the pinned life, and an ended conversation whose edit waits on disk
    const fx = await fixture("skipped");
    const life = await lifeWithSpentWorkContext(fx);
    refusedWorkContextsOf.add(life.crosscheckSessionId);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, [target(life.crosscheckSessionId, life.workContextId, "src/a.ts")], new Date());
    const endedKey = `${fx.hostSessionKey}-ended`;
    const ended = await register(fx, endedKey);
    await appendRecords(fx.home, fx.key, endedKey, [target(ended.crosscheckSessionId, ended.workContextId, "src/ended.ts")], new Date());
    await rm(sessionStatePath(fx.home, endedKey), { force: true });

    // Act
    const outcome = await flushAsHook(fx);
    refusedWorkContextsOf.delete(life.crosscheckSessionId);

    // Assert: not a failed drain; the ended conversation's edit landed; the pinned one waits
    expect(outcome.outcome).toBe("flushed");
    expect(await targetsOf(ended.workContextId)).toBe(1);
    expect(await pending(fx)).toBe(1);
  });
});

describe("what a refusal of the debt is", () => {
  test("a refusal of the session that sent it is the heal's, never counted against the debt", async () => {
    // Arrange: a debt open for the life; the hub ends that life, and refuses every register so no heal lands
    const fx = await fixture("own-refusal");
    const life = await register(fx);
    await flushAsHook(fx);
    await owe(fx, life.crosscheckSessionId);
    await endSession(fx.hub, life.crosscheckSessionId);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, [target(life.crosscheckSessionId, life.workContextId, "src/a.ts")], new Date());
    refuseRegisters = true;

    // Act
    await flushAsHook(fx);
    refuseRegisters = false;

    // Assert
    expect((await owedOf(fx))?.refusals).toBe(0);
  });

  test("a refusal of the debt's own life, one the hub never registered, counts against the debt (review-2 round 8, R7-M3)", async () => {
    // Arrange: everything delivered; a debt for a life of this conversation the hub never registered
    const fx = await fixture("author-unknown-debt");
    const life = await register(fx);
    await flushAsHook(fx);
    await owe(fx, `${life.crosscheckSessionId}~r9`);

    // Act: the lone debt goes, and the hub refuses it `author_unknown`
    await flushAsHook(fx);

    // Assert: not the producer's refusal, so the debt's own — counted toward its bound
    expect((await owedOf(fx))?.refusals).toBe(1);
  });

  test("a lone debt the hub refuses goes once per drain", async () => {
    // Arrange: everything delivered; a debt the hub refuses, nothing to carry it
    const fx = await fixture("lone-refused");
    const life = await register(fx);
    await flushAsHook(fx);
    await owe(fx, life.crosscheckSessionId);
    refusedWorkContextsOf.add(life.crosscheckSessionId);

    // Act
    await flushAsHook(fx);
    refusedWorkContextsOf.delete(life.crosscheckSessionId);

    // Assert: one refusal, the debt still open
    expect((await owedOf(fx))?.refusals).toBe(1);
  });
});

describe("a debt of a life the hub ended (review-2 round 7, found by the spool simulation)", () => {
  test("is settled as moot, never paid into the ended session", async () => {
    // Arrange: a debt for a life this connector knows the hub ended; the conversation is gone
    const fx = await fixture("moot");
    const life = await register(fx);
    await flushAsHook(fx);
    await owe(fx, life.crosscheckSessionId, "Moot", "blocked");
    await recordRefusedLife(fx.home, fx.key, life.crosscheckSessionId, new Date());
    await rm(sessionStatePath(fx.home, fx.hostSessionKey), { force: true });

    // Act: another conversation's flush
    const other = await register(fx, `${fx.hostSessionKey}-other`);
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, BUDGET_MS);

    // Assert: the debt is gone and the hub never got the copy
    const rows = await raw<{ title: string }>("select title from work_contexts where id = $1", [life.workContextId]);
    expect(await owedOf(fx)).toBeNull();
    expect(rows[0]?.title).not.toBe("Moot");
  });

  test("keeps its life open: the deferred end waits for the debt as it waits for records", async () => {
    // Arrange: everything delivered, the work context owed, SessionEnd deferred on it
    const fx = await fixture("end-waits");
    const life = await register(fx);
    await flushAsHook(fx);
    await owe(fx, life.crosscheckSessionId);
    await endSessionFlow({
      home: fx.home,
      repoKey: fx.key,
      hub: fx.hub,
      hostSessionKey: fx.hostSessionKey,
      crosscheckSessionId: life.crosscheckSessionId,
      developerId,
      flushBudgetMs: 0,
      now: () => new Date(),
    });

    // Act: SessionStart's reap with an ender
    await reapSpool(fx.home, fx.key, new Date(), async (sessionId, seq) =>
      (await endSession(fx.hub, sessionId, seq)).ok ? "ended" : "retry",
    );

    // Assert: the life is still open on the hub
    const rows = await raw<{ ended: boolean }>("select ended_at is not null as ended from agent_sessions where id = $1", [
      life.crosscheckSessionId,
    ]);
    expect(rows).toEqual([{ ended: false }]);
  });

  test("is written down once, however many refusals say the life ended", async () => {
    // Arrange
    const fx = await fixture("refused-once");

    // Act
    await recordRefusedLife(fx.home, fx.key, "cc_once", new Date());
    await recordRefusedLife(fx.home, fx.key, "cc_once", new Date());

    // Assert
    expect(toLines(await readTextOrNull(spoolRefusedLivesPath(fx.home, fx.key)))).toHaveLength(1);
  });
});

describe("the guards the round-6 mutations changed unnoticed", () => {
  test("a settle never deletes the debt of another work context (O1)", async () => {
    // Arrange: the debt on disk is for a newer life than the one being settled
    const fx = await fixture("o1");
    const life = await register(fx);
    await owe(fx, `${life.crosscheckSessionId}~r1`);

    // Act
    await settleOwedWorkContext(fx.home, fx.key, sessionSlug(fx.hostSessionKey), life.workContextId);

    // Assert
    expect((await owedOf(fx))?.sessionId).toBe(`${life.crosscheckSessionId}~r1`);
  });

  test("a debt the hub answers duplicate is settled (O3)", async () => {
    // Arrange: the hub already holds the work context exactly as owed
    const fx = await fixture("o3");
    const life = await register(fx);
    await flushAsHook(fx);
    const state = await readSessionState(fx.home, fx.hostSessionKey);
    await owe(fx, life.crosscheckSessionId, state?.workContextTitle ?? "", "analyzing");
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, [target(life.crosscheckSessionId, life.workContextId, "src/a.ts")], new Date());

    // Act
    await flushAsHook(fx);

    // Assert
    expect(await owedOf(fx)).toBeNull();
    expect(await targetsOf(life.workContextId)).toBe(1);
  });

  test("a debt the hub refuses is not settled, nor counted as a refused record, when the records behind it land (O4b, O5)", async () => {
    // Arrange: the work context is on the hub; the debt for it is refused
    const fx = await fixture("o5");
    const life = await register(fx);
    await flushAsHook(fx);
    await owe(fx, life.crosscheckSessionId);
    refusedWorkContextsOf.add(life.crosscheckSessionId);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, [target(life.crosscheckSessionId, life.workContextId, "src/a.ts")], new Date());

    // Act
    await flushAsHook(fx);
    refusedWorkContextsOf.delete(life.crosscheckSessionId);

    // Assert: still owed, one refusal on it; the edit landed; nothing in the ledger
    expect((await owedOf(fx))?.refusals).toBe(1);
    expect(await targetsOf(life.workContextId)).toBe(1);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
  });

  test("an owed life's record refused for another reason is counted, not pinned (O7)", async () => {
    // Arrange: an open debt the hub refuses, and a record of the life the hub refuses on its own merits
    const fx = await fixture("o7");
    const life = await register(fx);
    await flushAsHook(fx);
    await owe(fx, life.crosscheckSessionId);
    refusedWorkContextsOf.add(life.crosscheckSessionId);
    const valid = target(life.crosscheckSessionId, life.workContextId, "src/a.ts");
    const malformed = { ...valid, body: { workContextId: life.workContextId, kind: "file", value: "" } };
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, [malformed], new Date());

    // Act
    await flushAsHook(fx);
    refusedWorkContextsOf.delete(life.crosscheckSessionId);

    // Assert
    expect(await pending(fx)).toBe(0);
    expect((await readDropDetail(fx.home, fx.key)).byReason["rejected"]).toBe(1);
  });

  test("another life's author_unknown refusal is counted while a debt is open (O8)", async () => {
    // Arrange: a debt for the life the state names; ahead of it, a record of a life the hub never heard of
    const fx = await fixture("o8");
    const life = await register(fx);
    await flushAsHook(fx);
    await owe(fx, life.crosscheckSessionId);
    refusedWorkContextsOf.add(life.crosscheckSessionId);
    const ghost = `${life.crosscheckSessionId}~r9`;
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, [target(ghost, `wc_${ghost}`, "src/ghost.ts")], new Date());

    // Act
    await flushAsHook(fx);
    refusedWorkContextsOf.delete(life.crosscheckSessionId);

    // Assert: the ghost's record is spent, and counted for what it is
    expect(await pending(fx)).toBe(0);
    expect((await readDropDetail(fx.home, fx.key)).rejectedCauses).toEqual({ author_unknown: 1 });
  });

  test("reap keeps a live session's debt though its spool file is gone (O10)", async () => {
    // Arrange: a live state, a debt, no spool data file
    const fx = await fixture("o10");
    const life = await register(fx);
    await owe(fx, life.crosscheckSessionId);
    const spool = await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey));
    await rm(spool.dataPath, { force: true });

    // Act
    await reapSpool(fx.home, fx.key, new Date());

    // Assert
    expect(await Bun.file(spoolOwedWorkContextPath(fx.home, fx.key, sessionSlug(fx.hostSessionKey))).exists()).toBe(true);
  });

  test("SessionEnd defers while a work context is owed for the life it ends (O11b)", async () => {
    // Arrange: everything delivered, the life's work context still owed
    const fx = await fixture("o11b");
    const life = await register(fx);
    await flushAsHook(fx);
    await owe(fx, life.crosscheckSessionId);

    // Act: an end with no room to pay it
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

    // Assert
    expect(ended).toMatchObject({ undelivered: 1, ended: false });
  });
});
