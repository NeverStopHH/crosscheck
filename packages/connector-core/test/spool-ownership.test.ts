/**
 * A FLUSH SENDS ONLY WHAT IS ITS OWN (spool/ownership.ts, review-2 round 7).
 *
 * A flush used to drain every host session's backlog under its own life, and
 * another live conversation's records went with it: refused because their own
 * life was not registered yet, or because the work context they were owed had
 * not reached the hub, and spent as the flusher's refusals. A hold on
 * "unregistered" lives patched one shape of it; an hour of silence released a
 * life still alive (P3), and a healing flusher re-sent an owed life's records
 * without its work context (P4, p4b). Now a flusher sends its own spool, an
 * ended conversation's and an abandoned one's — never another live one's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, symlink, utimes, writeFile } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { MAX_SPOOL_AGE_DAYS, MINUTES_PER_HOUR, MS_PER_DAY, MS_PER_SECOND, SECONDS_PER_MINUTE } from "../src/constants.ts";
import { repoKey, sessionSlug, sessionStatePath } from "../src/config/paths.ts";
import { targetRecord } from "../src/capture/records.ts";
import type { Producer } from "../src/capture/records.ts";
import type { HubContext } from "../src/http/client.ts";
import { endSession } from "../src/http/hub.ts";
import { sessionHealer } from "../src/flows/heal-session.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { appendRecords } from "../src/spool/append.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import { flushSpool } from "../src/spool/flush.ts";
import { readSessionState, updateSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "ownership-admin";
const REPO_ID = "github.com/acme/api";
const BRANCH = "main";
const BASE_COMMIT = "0000000000000000000000000000000000000000";
const TIMEOUT_MS = 4000;
const BUDGET_MS = 3000;
const MINUTE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS;
/** Silences a live conversation can keep: none, past the hour doctor warns at, and six days. */
const LIVE_SILENCES_MS = [0, 61 * MINUTE_MS, 6 * MS_PER_DAY];
/** Past the bound session-reap deletes a state file on. */
const ABANDONED_MS = MAX_SPOOL_AGE_DAYS * MS_PER_DAY + HOUR_MS;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let proxyUrl: string;
let apiKey: string;
let developerId: string;
/** The proxy's dial: refuse every register. */
let refuseRegisters = false;
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

const fixture = async (label: string): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const key = repoKey(proxyUrl, REPO_ID);
  return {
    home,
    repo,
    key,
    hostSessionKey: `acp-own--${label}`,
    hub: { hubUrl: proxyUrl, apiKey, timeoutMs: TIMEOUT_MS, home, repoKey: key, now: () => new Date() },
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

const healerFor = (fx: Fixture, hostSessionKey: string) =>
  sessionHealer({
    home: fx.home,
    repoKey: fx.key,
    hub: fx.hub,
    agentKind: "acp:test",
    hostSessionKey,
    repoId: REPO_ID,
    branch: BRANCH,
    baseCommit: BASE_COMMIT,
    guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
    now: () => new Date(),
  });

/** The flush a hook of that host session makes: under the life its state names, with the healer. */
const flushAsHook = async (fx: Fixture, hostSessionKey: string = fx.hostSessionKey) => {
  const state = await readSessionState(fx.home, hostSessionKey);
  if (state === null) throw new Error("no session state");
  return flushSpool(fx.hub, { sessionId: state.crosscheckSessionId, developerId, heal: healerFor(fx, hostSessionKey) }, BUDGET_MS);
};

const producerOf = (sessionId: string): Producer => ({ developerId, agentKind: "acp:test", sessionId });

const edits = (life: { workContextId: string; crosscheckSessionId: string }, tag: string, n: number) =>
  Array.from({ length: n }, (_, index) =>
    targetRecord(life.workContextId, "file", `src/${tag}-${String(index)}.ts`, producerOf(life.crosscheckSessionId), new Date()),
  );

const landed = async (workContextId: string): Promise<number> =>
  (await raw<{ n: number }>("select count(*)::int as n from work_context_targets where work_context_id = $1", [workContextId]))[0]
    ?.n ?? 0;

const pending = async (fx: Fixture, hostSessionKey: string = fx.hostSessionKey): Promise<number> =>
  (await readSessionSpool(fx.home, fx.key, sessionSlug(hostSessionKey))).lines.length;

/** The conversation's state has said nothing — no heartbeat, no write — for `silentMs`. */
const silenceFor = async (fx: Fixture, silentMs: number): Promise<void> => {
  const since = new Date(Date.now() - silentMs);
  await updateSessionState(fx.home, fx.hostSessionKey, (fresh) => ({
    ...fresh,
    startedAt: since.toISOString(),
    lastHeartbeatAt: since.toISOString(),
  }));
  await utimes(sessionStatePath(fx.home, fx.hostSessionKey), since, since);
};

/** Another conversation in the same repo, flushing the repo's spool under its own life. */
const successorFlush = async (fx: Fixture): Promise<void> => {
  const other = await register(fx, `${fx.hostSessionKey}-other`);
  await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, BUDGET_MS);
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
    body: JSON.stringify({ name: "Owner", email: "owner@example.com" }),
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

describe("another live conversation's records", () => {
  test("stay on disk for their own conversation, however long it has been silent", async () => {
    for (const silentMs of LIVE_SILENCES_MS) {
      // Arrange: a registered conversation with two edits on disk, silent this long
      const fx = await fixture(`live-${String(silentMs)}`);
      const life = await register(fx);
      await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(life, "own", 2), new Date());
      await silenceFor(fx, silentMs);

      // Act: another conversation's flush, then its own
      const before = await pending(fx);
      await successorFlush(fx);
      const leftForOwner = await pending(fx);
      const landedForOther = await landed(life.workContextId);
      await flushAsHook(fx);

      // Assert: nothing sent for it, nothing spent; its own flush delivers both
      expect(leftForOwner).toBe(before);
      expect(landedForOther).toBe(0);
      expect(await landed(life.workContextId)).toBe(2);
      expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
    }
  });

  test("of a life whose register was refused stay for its own heal, an hour of silence or not (P3)", async () => {
    // Arrange: a register the hub refused, three edits, the conversation idle past an hour
    const fx = await fixture("unregistered");
    refuseRegisters = true;
    const life = await register(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(life, "idle", 3), new Date());
    refuseRegisters = false;
    await silenceFor(fx, 61 * MINUTE_MS);

    // Act
    await successorFlush(fx);
    const spent = (await readDropDetail(fx.home, fx.key)).byReason;
    await flushAsHook(fx);

    // Assert: the successor spent nothing; the life's own heal delivers all three
    expect(spent).toEqual({});
    expect(await landed(life.workContextId)).toBe(3);
  });

  test("of a conversation whose state will not parse wait until the file itself is silent past the bound (U19)", async () => {
    // Arrange: two edits on disk, the state file overwritten with what no reader parses
    const fx = await fixture("unreadable");
    const life = await register(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(life, "unreadable", 2), new Date());
    const statePath = sessionStatePath(fx.home, fx.hostSessionKey);
    await writeFile(statePath, "{ not json");

    // Act: a successor's flush while the file is fresh, then once it has been silent past the bound
    await successorFlush(fx);
    const landedWhileFresh = await landed(life.workContextId);
    const since = new Date(Date.now() - ABANDONED_MS);
    await utimes(statePath, since, since);
    await successorFlush(fx);

    // Assert: refusing to read the state handed nothing over; the silent file did
    expect(landedWhileFresh).toBe(0);
    expect(await landed(life.workContextId)).toBe(2);
  });

  test("of a conversation whose state cannot be looked at stay on disk: only a missing state is an ended one (review-2 round 8, L4)", async () => {
    // Arrange: two edits on disk; the state path answers with an error that is
    // not "no such file" (a link to itself, ELOOP — as EACCES or EIO would)
    const fx = await fixture("unstatable");
    const life = await register(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(life, "unstatable", 2), new Date());
    const statePath = sessionStatePath(fx.home, fx.hostSessionKey);
    await rm(statePath);
    await symlink(statePath, statePath);

    // Act
    await successorFlush(fx);

    // Assert: held for a writer that may be live — its work context and both edits still on disk
    expect(await landed(life.workContextId)).toBe(0);
    expect(await pending(fx)).toBe(3);
  });

  test("are never re-sent by a healing flusher, the owed life's work context with them (P4, p4b)", async () => {
    // Arrange: B, then A; the hub holds A's first life as ended and A's hook heals onto its next
    const fx = await fixture("moved-life");
    const bKey = `${fx.hostSessionKey}-b`;
    await register(fx, bKey);
    await flushAsHook(fx, bKey);
    const first = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, first.crosscheckSessionId);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(first, "first", 2), new Date());
    await flushAsHook(fx);
    const next = await readSessionState(fx.home, fx.hostSessionKey);
    if (next === null) throw new Error("no state");
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(next, "next", 3), new Date());
    // ...and B's own life is ended on the hub too: its flush heals
    const b = await readSessionState(fx.home, bKey);
    await endSession(fx.hub, b?.crosscheckSessionId ?? "");

    // Act: B's hook, then A's own
    await flushAsHook(fx, bKey);
    const leftForA = await pending(fx);
    const causesAfterB = (await readDropDetail(fx.home, fx.key)).rejectedCauses;
    await flushAsHook(fx);

    // Assert: B touched none of A's records; A's flush delivered its next life's three
    expect(next.crosscheckSessionId).toBe(`${first.crosscheckSessionId}~r1`);
    expect(leftForA).toBe(3);
    expect(causesAfterB).toEqual({ session_ended: 2 });
    expect(await landed(next.workContextId)).toBe(3);
  });
});

describe("a conversation re-bound to another repo (review-2 round 8, M2, probe r7-rebind)", () => {
  test("has its records in this repo sent by this repo's next flusher: it never flushes this repo again", async () => {
    // Arrange: X captured in this repo, then is resumed from another checkout, which re-binds its state
    const fx = await fixture("rebound");
    const x = await register(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(x, "before-rebind", 1), new Date());
    const otherRepo = "github.com/acme/web";
    const otherKey = repoKey(proxyUrl, otherRepo);
    await registerSessionFlow({
      home: fx.home,
      repoKey: otherKey,
      hub: { ...fx.hub, repoKey: otherKey },
      agentKind: "acp:test",
      hostSessionKey: fx.hostSessionKey,
      repoId: otherRepo,
      repoRoot: fx.repo,
      branch: BRANCH,
      baseCommit: BASE_COMMIT,
      hubUrl: proxyUrl,
      fallbackDeveloperId: developerId,
      title: fallbackWorkContextTitle(BRANCH, otherRepo),
      status: "analyzing",
      now: new Date(),
      guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
    });

    // Act: another conversation's flush of this repo
    await successorFlush(fx);

    // Assert: X's records here went, nothing spent
    expect(await pending(fx)).toBe(0);
    expect(await landed(x.workContextId)).toBe(1);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
  });
});

describe("a conversation that is over", () => {
  test("has its records sent by the next flusher once its state is gone (ended)", async () => {
    // Arrange: two edits on disk, the state gone — SessionEnd ran, or reap took a corpse
    const fx = await fixture("ended");
    const life = await register(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(life, "ended", 2), new Date());
    await rm(sessionStatePath(fx.home, fx.hostSessionKey), { force: true });

    // Act
    await successorFlush(fx);

    // Assert
    expect(await landed(life.workContextId)).toBe(2);
    expect(await pending(fx)).toBe(0);
  });

  test("has its records sent by the next flusher once its state is silent past the reap bound (abandoned)", async () => {
    // Arrange
    const fx = await fixture("abandoned");
    const life = await register(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(life, "abandoned", 2), new Date());
    await silenceFor(fx, ABANDONED_MS);

    // Act
    await successorFlush(fx);

    // Assert
    expect(await landed(life.workContextId)).toBe(2);
    expect(await pending(fx)).toBe(0);
  });
});
