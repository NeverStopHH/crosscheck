/**
 * THE HOLD ON AN UNREGISTERED LIFE ENDS (review-2 round 6, HIGH-2).
 *
 * A successor flush leaves the records of a live life the hub has not
 * registered on disk (spool/held-lives.ts). The `unregistered` mark that
 * decides it could stick for good: a register the hub committed but answered
 * too late reads as refused, and then the life's own accepted flushes and its
 * 2xx heartbeats left the mark standing — while "live" meant only that the
 * state file existed. A host that exited without SessionEnd left a corpse
 * whose backlog was held for seven days and then counted `expired`: of four
 * edits, one landed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, utimes } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import {
  DOCTOR_ZOMBIE_STATE_WARN_HOURS,
  MINUTES_PER_HOUR,
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
} from "../src/constants.ts";
import { repoKey, sessionStatePath } from "../src/config/paths.ts";
import { targetRecord } from "../src/capture/records.ts";
import type { Producer } from "../src/capture/records.ts";
import type { HubContext } from "../src/http/client.ts";
import { heartbeatMaybe } from "../src/flows/heartbeat.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { appendRecords } from "../src/spool/append.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { flushSpool } from "../src/spool/flush.ts";
import { readSessionState, updateSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "hold-admin";
const REPO_ID = "github.com/acme/api";
const BRANCH = "main";
const BASE_COMMIT = "0000000000000000000000000000000000000000";
const TIMEOUT_MS = 4000;
const BUDGET_MS = 3000;
/** A register timeout the hub's late answer outlasts. */
const SHORT_TIMEOUT_MS = 300;
const LATE_ANSWER_MS = 800;
const HOUR_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let proxyUrl: string;
let apiKey: string;
let developerId: string;
/** The proxy's dial: commit the register on the hub, answer after the client gave up. */
let answerRegistersLate = false;
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
    hostSessionKey: `acp-hold--${label}`,
    hub: { hubUrl: proxyUrl, apiKey, timeoutMs: TIMEOUT_MS, home, repoKey: key, now: () => new Date() },
  };
};

const register = (fx: Fixture, hostSessionKey: string = fx.hostSessionKey, hub: HubContext = fx.hub) =>
  registerSessionFlow({
    home: fx.home,
    repoKey: fx.key,
    hub,
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

const producerOf = (sessionId: string): Producer => ({ developerId, agentKind: "acp:test", sessionId });

const edits = (life: { workContextId: string; crosscheckSessionId: string }, tag: string, n: number) =>
  Array.from({ length: n }, (_, index) =>
    targetRecord(life.workContextId, "file", `src/${tag}-${String(index)}.ts`, producerOf(life.crosscheckSessionId), new Date()),
  );

const landed = async (workContextId: string): Promise<number> =>
  (await raw<{ n: number }>("select count(*)::int as n from work_context_targets where work_context_id = $1", [workContextId]))[0]
    ?.n ?? 0;

const markUnregistered = (fx: Fixture): Promise<boolean> =>
  updateSessionState(fx.home, fx.hostSessionKey, (fresh) => ({ ...fresh, unregistered: true }));

const isMarked = async (fx: Fixture): Promise<boolean> =>
  (await readSessionState(fx.home, fx.hostSessionKey))?.unregistered === true;

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
      const forward = async () =>
        fetch(`${hubUrl}${pathname}${search}`, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" ? undefined : await request.arrayBuffer(),
        });
      if (request.method === "POST" && pathname === "/api/sessions" && answerRegistersLate) {
        const answer = await forward();
        await Bun.sleep(LATE_ANSWER_MS);
        return answer;
      }
      return forward();
    },
  });
  proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Hold", email: "hold@example.com" }),
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

describe("the unregistered mark", () => {
  test("is cleared by a record the hub accepted from the life itself (RS5-C)", async () => {
    // Arrange: a life the hub holds, marked unregistered all the same
    const fx = await fixture("cleared-by-flush");
    const life = await register(fx);
    await markUnregistered(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(life, "own", 1), new Date());

    // Act: its own flush, then more edits and a host that dies without SessionEnd
    await flushSpool(fx.hub, { sessionId: life.crosscheckSessionId, developerId }, BUDGET_MS);
    const markedAfterOwnFlush = await isMarked(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(life, "crash", 3), new Date());
    await successorFlush(fx);

    // Assert: nothing held, nothing expired
    expect(markedAfterOwnFlush).toBe(false);
    expect(await landed(life.workContextId)).toBe(4);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
  });

  test("is cleared by a heartbeat the hub answered", async () => {
    // Arrange
    const fx = await fixture("cleared-by-beat");
    const life = await register(fx);
    await markUnregistered(fx);

    // Act
    await heartbeatMaybe({
      hub: fx.hub,
      hostSessionKey: fx.hostSessionKey,
      crosscheckSessionId: life.crosscheckSessionId,
      lastHeartbeatAt: null,
      now: new Date(),
    });

    // Assert
    expect(await isMarked(fx)).toBe(false);
  });

  test("set by a register the hub committed but answered too late, is cleared by the life's own flush (RS5-C2)", async () => {
    // Arrange: the register lands on the hub; its answer outlasts the timeout
    const fx = await fixture("late-answer");
    answerRegistersLate = true;
    const life = await register(fx, fx.hostSessionKey, { ...fx.hub, timeoutMs: SHORT_TIMEOUT_MS });
    answerRegistersLate = false;
    await Bun.sleep(LATE_ANSWER_MS);
    const markedAtStart = await isMarked(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(life, "own", 2), new Date());

    // Act: its own flush, more edits, and the successor
    await flushSpool(fx.hub, { sessionId: life.crosscheckSessionId, developerId }, BUDGET_MS);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(life, "crash", 3), new Date());
    await successorFlush(fx);

    // Assert
    expect(markedAtStart).toBe(true);
    expect(await landed(life.workContextId)).toBe(5);
  });
});

describe("a life whose state has gone silent", () => {
  test("is not held, whatever its mark says", async () => {
    // Arrange: a marked life whose host stopped saying anything an hour and more ago
    const fx = await fixture("silent");
    const life = await register(fx);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, edits(life, "own", 2), new Date());
    await markUnregistered(fx);
    const silentSince = new Date(Date.now() - (DOCTOR_ZOMBIE_STATE_WARN_HOURS + 1) * HOUR_MS);
    await updateSessionState(fx.home, fx.hostSessionKey, (fresh) => ({
      ...fresh,
      startedAt: silentSince.toISOString(),
      lastHeartbeatAt: silentSince.toISOString(),
    }));
    await utimes(sessionStatePath(fx.home, fx.hostSessionKey), silentSince, silentSince);

    // Act
    await successorFlush(fx);

    // Assert
    expect(await landed(life.workContextId)).toBe(2);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
  });
});
