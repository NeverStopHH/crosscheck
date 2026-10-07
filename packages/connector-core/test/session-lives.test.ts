/**
 * THE LIVES OF ONE HOST SESSION WHEN THE HUB DOES NOT ANSWER AS EXPECTED
 * (adversarial review of the resumed-session branch, 2026-10-06).
 *
 * Each describe below began as a review probe that reproduced a defect against
 * a real in-memory hub: an end that never reached the hub, a register slower
 * than its timeout, two healers racing, a heal with no room left. A proxy in
 * front of the hub turns those dials; everything else is the shipped flows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createDb, createServer, readSessionCausalOrder } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "../src/constants.ts";
import { repoKey, sessionEpochPathForSlug, sessionSlug, sessionStatePath, spoolDir } from "../src/config/paths.ts";
import { commitEvidenceRecord } from "../src/capture/commit-evidence.ts";
import { targetRecord, withProducer, workContextRecord } from "../src/capture/records.ts";
import type { Producer } from "../src/capture/records.ts";
import { seqAt, withSeq } from "../src/capture/seq.ts";
import type { HubContext } from "../src/http/client.ts";
import { endSession, postRecords, registerSession } from "../src/http/hub.ts";
import { endSessionFlow } from "../src/flows/end-session.ts";
import { sessionHealer } from "../src/flows/heal-session.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { appendRecords } from "../src/spool/append.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { flushSpool } from "../src/spool/flush.ts";
import type { SessionRefusal } from "../src/spool/flush-heal.ts";
import { reapSpool } from "../src/spool/reap.ts";
import { readUnclosedSummary } from "../src/spool/unclosed.ts";
import {
  allocateSeq,
  readSessionState,
  sessionStateLockPath,
  updateSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import { withLock } from "../src/spool/lock.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "lives-admin";
const REPO_ID = "github.com/acme/api";
const BRANCH = "main";
const BASE_COMMIT = "0000000000000000000000000000000000000000";
const TIMEOUT_MS = 4000;
const BUDGET_MS = 3000;
/** How much older a backlog is made so the oldest-first drain takes it first. */
const OLDER_MS = 60_000;
/** A walk slow enough that a parallel flush lands while it is in flight. */
const WALK_DELAY_MS = 300;
/** How long the slow walk is given to stamp its attempt before the flush. */
const WALK_HEAD_START_MS = 30;
/** Enough delay that two concurrent healers overlap. */
const RACE_DELAY_MS = 50;
/** Any position: the point is that it is withheld when another life delivers it. */
const COMMIT_POSITION = 7;
/**
 * How long a test holds the state lock against a walk's switch: past the
 * switch's own patience (SESSION_STATE_LOCK_RETRIES × the retry delay,
 * 400 ms), so the switch finds the lock busy.
 */
const LOCK_PAST_PATIENCE_MS = 900;
/** Past the switch's patience, inside the retirement's: the retirement gets the lock. */
const LOCK_FREES_FOR_RETIREMENT_MS = 600;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let proxyUrl: string;
let apiKey: string;
let developerId: string;
/** The proxy's dials. */
let refuseRegisters = false;
let refuseRecords = false;
let refuseEnds = false;
let registerDelayMs = 0;
/** One answer per register, in arrival order, ahead of the dials above: a race's script. */
let registerScript: readonly ("slow" | "refused")[] = [];
const registerIds: string[] = [];
const cleanups: string[] = [];

/** The hub's own rows, read through PGlite: this package has no drizzle edge. */
const raw = async <T>(text: string, params: readonly unknown[] = []): Promise<readonly T[]> =>
  (
    await (db as unknown as { $client: { query: (q: string, p: readonly unknown[]) => Promise<{ rows: T[] }> } })
      .$client.query(text, params)
  ).rows;

interface Fixture {
  readonly home: string;
  readonly repo: string;
  readonly key: string;
  /** Straight to the hub. */
  readonly hub: HubContext;
  /** Through the proxy and its dials. */
  readonly proxied: HubContext;
  readonly hostSessionKey: string;
}

const fixture = async (label: string): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const key = repoKey(hubUrl, REPO_ID);
  const base = { apiKey, timeoutMs: TIMEOUT_MS, home, repoKey: key, now: () => new Date() };
  return {
    home,
    repo,
    key,
    hostSessionKey: `acp-lives--${label}`,
    hub: { ...base, hubUrl },
    proxied: { ...base, hubUrl: proxyUrl },
  };
};

const register = (fx: Fixture, hub: HubContext = fx.hub, hostSessionKey: string = fx.hostSessionKey) =>
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
    hubUrl: hub.hubUrl,
    fallbackDeveloperId: developerId,
    title: fallbackWorkContextTitle(BRANCH, REPO_ID),
    status: "analyzing",
    now: new Date(),
    guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
  });

const healerFor = (fx: Fixture, hub: HubContext = fx.hub) =>
  sessionHealer({
    home: fx.home,
    repoKey: fx.key,
    hub,
    agentKind: "acp:test",
    hostSessionKey: fx.hostSessionKey,
    repoId: REPO_ID,
    branch: BRANCH,
    baseCommit: BASE_COMMIT,
    guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
    now: () => new Date(),
  });

const flushAsHook = async (fx: Fixture, hub: HubContext = fx.hub): Promise<void> => {
  const state = await readSessionState(fx.home, fx.hostSessionKey);
  if (state === null) throw new Error("no session state");
  await flushSpool(hub, { sessionId: state.crosscheckSessionId, developerId, heal: healerFor(fx, hub) }, BUDGET_MS);
};

const endViaFlow = async (fx: Fixture, hub: HubContext = fx.hub) => {
  const state = await readSessionState(fx.home, fx.hostSessionKey);
  if (state === null) throw new Error("no session state");
  return endSessionFlow({
    home: fx.home,
    repoKey: fx.key,
    hub,
    hostSessionKey: fx.hostSessionKey,
    crosscheckSessionId: state.crosscheckSessionId,
    developerId,
    flushBudgetMs: BUDGET_MS,
    now: () => new Date(),
  });
};

/** SessionStart's maintenance reap, with the deferred ender it hands it. */
const reapAsSessionStart = (fx: Fixture): Promise<unknown> =>
  reapSpool(fx.home, fx.key, new Date(), async (crosscheckSessionId, seq) =>
    (await endSession(fx.hub, crosscheckSessionId, seq)).ok ? "ended" : "retry",
  );

const producerOf = (sessionId: string): Producer => ({ developerId, agentKind: "acp:test", sessionId });

/** What a capture hook does: build from the state file, position from its counter. */
const captureTarget = async (fx: Fixture, file: string): Promise<void> => {
  const state = await readSessionState(fx.home, fx.hostSessionKey);
  if (state === null) throw new Error("no session state");
  const seq = seqAt(await allocateSeq(fx.home, fx.hostSessionKey, 1), 0);
  await appendRecords(
    fx.home,
    fx.key,
    fx.hostSessionKey,
    [withSeq(targetRecord(state.workContextId, "file", file, producerOf(state.crosscheckSessionId), new Date()), seq)],
    new Date(),
  );
};

const targetsOf = async (workContextId: string): Promise<readonly string[]> =>
  (
    await raw<{ value: string }>(
      "select value from work_context_targets where work_context_id = $1 order by value",
      [workContextId],
    )
  ).map((row) => row.value);

const isEnded = async (sessionId: string): Promise<boolean | undefined> =>
  (await raw<{ ended: boolean }>("select ended_at is not null as ended from agent_sessions where id = $1", [sessionId]))[0]
    ?.ended;

const stateOf = (fx: Fixture) => readSessionState(fx.home, fx.hostSessionKey);

/** The statuses of the work-context records waiting in the conversation's spool. */
const spooledStatuses = async (fx: Fixture): Promise<readonly unknown[]> =>
  (await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey))).lines
    .map((line) => JSON.parse(line) as { kind: string; body: { status?: unknown } })
    .filter((record) => record.kind === "work_context")
    .map((record) => record.body.status);

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;
  proxy = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname, search } = new URL(request.url);
      const body = request.method === "GET" ? undefined : await request.arrayBuffer();
      if (request.method === "POST" && pathname === "/api/sessions") {
        registerIds.push((JSON.parse(new TextDecoder().decode(body)) as { id: string }).id);
        const scripted = registerScript[0];
        registerScript = registerScript.slice(1);
        if (refuseRegisters || scripted === "refused") {
          return Response.json({ ok: false, error: { code: "unavailable", message: "down" } }, { status: 503 });
        }
        if (scripted === "slow") {
          await Bun.sleep(WALK_DELAY_MS);
        }
        if (registerDelayMs > 0) {
          await Bun.sleep(registerDelayMs);
        }
      }
      if (request.method === "POST" && pathname === "/api/records" && refuseRecords) {
        return Response.json({ ok: false, error: { code: "unavailable", message: "down" } }, { status: 503 });
      }
      if (request.method === "POST" && pathname.endsWith("/end") && refuseEnds) {
        return Response.json({ ok: false, error: { code: "unavailable", message: "down" } }, { status: 503 });
      }
      return fetch(`${hubUrl}${pathname}${search}`, { method: request.method, headers: request.headers, body });
    },
  });
  proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Lives", email: "lives@example.com" }),
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

describe("a resume after a SessionEnd whose end never reached the hub (review P2)", () => {
  test("starts the next life above the ended one, and the reap still ends the old one", async () => {
    // Arrange: a life with a delivered edit, ended by the host while the hub refused the end
    const fx = await fixture("end-lost");
    const first = await register(fx);
    await captureTarget(fx, "src/life0.ts");
    await flushAsHook(fx);
    refuseEnds = true;
    const ended = await endViaFlow(fx, fx.proxied);
    refuseEnds = false;
    expect(ended.ended).toBe(false);

    // Act: the resume registers BEFORE the reap, as Claude's SessionStart does
    const resumed = await register(fx);
    await captureTarget(fx, "src/life1.ts");
    await flushAsHook(fx);
    await reapAsSessionStart(fx);

    // Assert: a new life, the old one ended by its marker, each with one epoch
    expect(resumed.crosscheckSessionId).toBe(`${first.crosscheckSessionId}~r1`);
    expect(await isEnded(first.crosscheckSessionId)).toBe(true);
    expect(await readSessionCausalOrder(db, first.crosscheckSessionId)).toMatchObject({ state: "usable", epochs: 1 });
    expect(await readSessionCausalOrder(db, resumed.crosscheckSessionId)).toMatchObject({
      state: "usable",
      epochs: 1,
    });
    expect(await targetsOf(first.workContextId)).toEqual(["src/life0.ts"]);
    expect(await targetsOf(resumed.workContextId)).toEqual(["src/life1.ts"]);
  });
});

const flushAs = async (fx: Fixture, hostSessionKey: string, hub: HubContext = fx.hub): Promise<void> => {
  const state = await readSessionState(fx.home, hostSessionKey);
  if (state === null) throw new Error("no session state");
  await flushSpool(hub, { sessionId: state.crosscheckSessionId, developerId, heal: healerFor({ ...fx, hostSessionKey }, hub) }, BUDGET_MS);
};

describe("a register that does not land never leaves a life on an ended id (review P1, P7)", () => {
  test("a re-fire whose register fails keeps the live life", async () => {
    // Arrange: life 0 ended by SessionEnd, the conversation resumed on ~r1
    const fx = await fixture("refire-down");
    await register(fx);
    await endViaFlow(fx);
    const resumed = await register(fx);
    await captureTarget(fx, "src/before-refire.ts");
    await flushAsHook(fx);

    // Act: /compact re-fires SessionStart while the hub refuses registers
    refuseRegisters = true;
    const refire = await register(fx, fx.proxied);
    refuseRegisters = false;
    await captureTarget(fx, "src/after-refire.ts");
    await flushAsHook(fx);

    // Assert: still ~r1, and both edits are in it
    expect(refire.crosscheckSessionId).toBe(resumed.crosscheckSessionId);
    expect((await stateOf(fx))?.crosscheckSessionId).toBe(resumed.crosscheckSessionId);
    expect(await targetsOf(resumed.workContextId)).toEqual(["src/after-refire.ts", "src/before-refire.ts"]);
  });

  test("a resume whose register fails takes the next life's id, and the heal registers it as itself", async () => {
    // Arrange
    const fx = await fixture("resume-down");
    const first = await register(fx);
    await endViaFlow(fx);

    // Act: the resume's register does not land; the next flush reaches the hub
    refuseRegisters = true;
    const resumed = await register(fx, fx.proxied);
    refuseRegisters = false;
    await captureTarget(fx, "src/resumed.ts");
    await flushAsHook(fx);

    // Assert
    const next = `${first.crosscheckSessionId}~r1`;
    expect(resumed.crosscheckSessionId).toBe(next);
    expect(await isEnded(next)).toBe(false);
    expect(await targetsOf(`wc_${next}`)).toEqual(["src/resumed.ts"]);
  });

  /**
   * An ENDED conversation's pending edit — the only other conversation's
   * records a flusher sends (spool/ownership.ts) — OLDER than anything of this
   * one, so it drains first.
   */
  const otherBacklog = async (fx: Fixture): Promise<{ readonly host: string; readonly workContextId: string }> => {
    const host = `${fx.hostSessionKey}-other`;
    const other = await register(fx, fx.hub, host);
    await flushAs(fx, host);
    await appendRecords(
      fx.home,
      fx.key,
      host,
      [targetRecord(other.workContextId, "file", "src/other.ts", producerOf(other.crosscheckSessionId), new Date(Date.now() - OLDER_MS))],
      new Date(),
    );
    await rm(sessionStatePath(fx.home, host), { force: true });
    return { host, workContextId: other.workContextId };
  };

  /** A third, live conversation's flush — whoever comes next for an ended conversation's records. */
  const successorFlush = async (fx: Fixture): Promise<void> => {
    const host = `${fx.hostSessionKey}-successor`;
    await register(fx, fx.hub, host);
    await flushAs(fx, host);
  };

  test("a refused flusher that cannot heal leaves another conversation's records on disk", async () => {
    // Arrange: this conversation ended by the hub, a hub that refuses every
    // register so no heal can land, and the other conversation's older edit
    const fx = await fixture("other-at-stake");
    const other = await otherBacklog(fx);
    const life = await register(fx);
    await endSession(fx.hub, life.crosscheckSessionId);

    // Act: this conversation's flush, refused and unhealable; then a live successor's
    refuseRegisters = true;
    await flushAs(fx, fx.hostSessionKey, fx.proxied);
    refuseRegisters = false;
    const spent = (await readDropDetail(fx.home, fx.key)).byReason["rejected"] ?? 0;
    await successorFlush(fx);

    // Assert: nothing was spent under the refused producer, and the edit landed
    expect(spent).toBe(0);
    expect(await targetsOf(other.workContextId)).toEqual(["src/other.ts"]);
  });

  test("a refused drain with no healer leaves another conversation's records on disk too", async () => {
    // Arrange
    const fx = await fixture("other-no-healer");
    const other = await otherBacklog(fx);
    const life = await register(fx);
    await endSession(fx.hub, life.crosscheckSessionId);

    // Act: a drain under the refused session with no healer — SessionEnd's
    await flushSpool(fx.hub, { sessionId: life.crosscheckSessionId, developerId }, BUDGET_MS);
    const spent = (await readDropDetail(fx.home, fx.key)).byReason["rejected"] ?? 0;
    await successorFlush(fx);

    // Assert
    expect(spent).toBe(0);
    expect(await targetsOf(other.workContextId)).toEqual(["src/other.ts"]);
  });
});

/**
 * A producer-filed record of the refused life, positioned the way SessionStart
 * positions it — re-sendable under the next life, with that position withheld.
 */
const commitEvidenceOf = (sessionId: string): Record<string, unknown> =>
  withSeq(
    commitEvidenceRecord(
      REPO_ID,
      [{ name: "Dev", email: "dev@example.com", latestCommitAt: new Date().toISOString(), commitCount: 1 }],
      producerOf(sessionId),
      new Date(),
    ),
    { epoch: crypto.randomUUID(), n: COMMIT_POSITION },
  );

const observedUnder = async (prefix: string): Promise<readonly { session_id: string; seq_reason: string }[]> =>
  raw("select session_id, seq_reason from session_events where kind = 'commit.observed' and session_id like $1", [
    `${prefix}%`,
  ]);

describe("the heal never throws away what it should re-send (review P4, P5, P6)", () => {
  test("a heal handed no room spends no cooldown, and the next flush heals and re-sends", async () => {
    // Arrange: an ended life, and a heartbeat refused at the end of a spent hook
    const fx = await fixture("no-room");
    const life = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, life.crosscheckSessionId);
    registerIds.length = 0;

    // Act
    const spent = await healerFor(fx, fx.proxied)(
      { sessionId: life.crosscheckSessionId, cause: "session_ended" },
      Date.now(),
    );
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, [commitEvidenceOf(life.crosscheckSessionId)], new Date());
    await flushAsHook(fx, fx.proxied);

    // Assert: no walk without room, then one walk straight to the next rung
    const next = `${life.crosscheckSessionId}~r1`;
    expect(spent).toEqual({ outcome: "pending" });
    expect(registerIds).toEqual([next]);
    expect((await stateOf(fx))?.crosscheckSessionId).toBe(next);
    expect(await observedUnder(life.crosscheckSessionId)).toEqual([
      { session_id: next, seq_reason: "foreign_session_delivery" },
    ]);
    expect((await readDropDetail(fx.home, fx.key)).byReason["rejected"] ?? 0).toBe(0);
  });

  test("a flush refused while a sibling's walk is in flight keeps its batch for the healed life", async () => {
    // Arrange: an ended life with a producer-filed record waiting
    const fx = await fixture("in-flight");
    const life = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, life.crosscheckSessionId);
    await appendRecords(fx.home, fx.key, fx.hostSessionKey, [commitEvidenceOf(life.crosscheckSessionId)], new Date());

    // Act: a heartbeat's walk is slow; a parallel hook's flush is refused meanwhile
    registerDelayMs = WALK_DELAY_MS;
    const walking = healerFor(fx, fx.proxied)(
      { sessionId: life.crosscheckSessionId, cause: "session_ended" },
      Date.now() + BUDGET_MS,
    );
    await Bun.sleep(WALK_HEAD_START_MS);
    await flushAsHook(fx);
    const walked = await walking;
    registerDelayMs = 0;
    await flushAsHook(fx);

    // Assert: the record waited and went under the healed life
    const next = `${life.crosscheckSessionId}~r1`;
    expect(walked).toMatchObject({ outcome: "healed", refusedSessionId: life.crosscheckSessionId, sessionId: next });
    expect(await observedUnder(life.crosscheckSessionId)).toEqual([
      { session_id: next, seq_reason: "foreign_session_delivery" },
    ]);
    expect((await readDropDetail(fx.home, fx.key)).byReason["rejected"] ?? 0).toBe(0);
  });

  test("two healers racing land on one life, and neither answers a dead end", async () => {
    // Arrange
    const fx = await fixture("race");
    const life = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, life.crosscheckSessionId);
    registerDelayMs = RACE_DELAY_MS;

    // Act
    const refusal = { sessionId: life.crosscheckSessionId, cause: "session_ended" } as const;
    const results = await Promise.all([
      healerFor(fx, fx.proxied)(refusal, Date.now() + BUDGET_MS),
      healerFor(fx, fx.proxied)(refusal, Date.now() + BUDGET_MS),
    ]);
    registerDelayMs = 0;

    // Assert: one next life on the hub and in the state; every answer is it, or "wait"
    const next = `${life.crosscheckSessionId}~r1`;
    const lives = await raw<{ id: string }>("select id from agent_sessions where id like $1 order by id", [
      `${life.crosscheckSessionId}%`,
    ]);
    expect(lives.map((row) => row.id)).toEqual([life.crosscheckSessionId, next]);
    expect((await stateOf(fx))?.crosscheckSessionId).toBe(next);
    expect(results.some((result) => result.outcome === "healed")).toBe(true);
    for (const result of results) {
      expect(result.outcome === "pending" || (result.outcome === "healed" && result.sessionId === next)).toBe(true);
    }
  });

  test("a heal that loses the switch to a SessionStart on the very life it registered leaves it open (review-2 round 7)", async () => {
    // Arrange: an ended life; a heal's walk in flight against a slow hub
    const fx = await fixture("lost-to-refire");
    const life = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, life.crosscheckSessionId);
    registerDelayMs = WALK_DELAY_MS;
    const walking = healerFor(fx, fx.proxied)(
      { sessionId: life.crosscheckSessionId, cause: "session_ended" },
      Date.now() + BUDGET_MS,
    );
    await Bun.sleep(WALK_HEAD_START_MS);

    // Act: a SessionStart re-fire climbs to the same next life and switches the state first
    await register(fx);
    const walked = await walking;
    registerDelayMs = 0;

    // Assert: both answers are the one next life, and it is open
    const next = `${life.crosscheckSessionId}~r1`;
    expect((await stateOf(fx))?.crosscheckSessionId).toBe(next);
    expect(walked).toMatchObject({ outcome: "healed", sessionId: next });
    expect(await isEnded(next)).toBe(false);
  });
});

describe("coverage right after a heal never reads a loss as observed (review P3)", () => {
  test("the heal's register carries the records the refusal just cost", async () => {
    // Arrange: a live life ended by the hub, and an edit captured after the end
    const fx = await fixture("loss-carried");
    const life = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, life.crosscheckSessionId);
    await captureTarget(fx, "src/lost.ts");

    // Act: the flush refused for its own session heals it
    await flushAsHook(fx);

    // Assert: the next life's row reports the loss from its very first word
    const next = `${life.crosscheckSessionId}~r1`;
    const rows = await raw<{ loss_total: number }>("select loss_total from agent_sessions where id = $1", [next]);
    expect(rows[0]?.loss_total).toBe(1);
    expect((await readDropDetail(fx.home, fx.key)).byReason["rejected"]).toBe(1);
  });
});

describe("a heal racing a SessionEnd (review finding 6)", () => {
  test("ends the life it registered too late, and the next resume starts above it", async () => {
    // Arrange: a life the hub ended, a heal's walk in flight against a slow hub
    const fx = await fixture("heal-vs-end");
    const life = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, life.crosscheckSessionId);
    registerDelayMs = WALK_DELAY_MS;
    const walking = healerFor(fx, fx.proxied)(
      { sessionId: life.crosscheckSessionId, cause: "session_ended" },
      Date.now() + BUDGET_MS,
    );
    await Bun.sleep(WALK_HEAD_START_MS);

    // Act: SessionEnd deletes the state while the walk registers the next life
    await endViaFlow(fx);
    await walking;
    registerDelayMs = 0;
    const resumed = await register(fx);
    await captureTarget(fx, "src/after-resume.ts");
    await flushAsHook(fx);

    // Assert: the late life is closed, the resume is a fresh one, both orders whole
    const late = `${life.crosscheckSessionId}~r1`;
    expect(await isEnded(late)).toBe(true);
    expect(resumed.crosscheckSessionId).toBe(`${life.crosscheckSessionId}~r2`);
    for (const id of [late, resumed.crosscheckSessionId]) {
      expect((await readSessionCausalOrder(db, id)).epochs).toBe(1);
    }
    expect(await targetsOf(resumed.workContextId)).toEqual(["src/after-resume.ts"]);
  });
});

describe("a heal asked from a hook in another repo (review finding 7)", () => {
  test("binds the next life to the session's repo, and spools its work context there", async () => {
    // Arrange: a session bound to acme/api, ended by the hub; the hook that
    // heals it resolved a different repo (a Stop with no foreign-repo guard)
    const fx = await fixture("foreign-hook");
    const life = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, life.crosscheckSessionId);
    const foreignRepoId = "github.com/acme/web";
    const foreignKey = repoKey(hubUrl, foreignRepoId);
    const healer = sessionHealer({
      home: fx.home,
      repoKey: foreignKey,
      hub: { ...fx.hub, repoKey: foreignKey },
      agentKind: "acp:test",
      hostSessionKey: fx.hostSessionKey,
      repoId: foreignRepoId,
      branch: BRANCH,
      baseCommit: BASE_COMMIT,
      guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
      now: () => new Date(),
    });

    // Act
    const healed = await healer({ sessionId: life.crosscheckSessionId, cause: "session_ended" }, Date.now() + BUDGET_MS);
    await captureTarget(fx, "src/after-heal.ts");
    await flushAsHook(fx);

    // Assert: the hub binds the next life to the session's repo, where its
    // owed work context was paid ahead of the next edit
    const next = `${life.crosscheckSessionId}~r1`;
    expect(healed).toMatchObject({ outcome: "healed", refusedSessionId: life.crosscheckSessionId, sessionId: next });
    const rows = await raw<{ repo: string }>("select repo from agent_sessions where id = $1", [next]);
    expect(rows).toEqual([{ repo: REPO_ID }]);
    const contexts = await raw<{ id: string }>("select id from work_contexts where session_id = $1", [next]);
    expect(contexts).toEqual([{ id: `wc_${next}` }]);
  });
});

/**
 * TWO DEFERRED ENDS OF ONE CONVERSATION (review-2 finding 3). The marker was
 * one per HOST session, so the resumed life's SessionEnd wrote over the one
 * its predecessor left: that life was never ended from this machine, its
 * `session.ended` position was lost, and no count ever said so.
 */
const pendingEnds = async (fx: Fixture): Promise<readonly string[]> =>
  (await readdir(spoolDir(fx.home, fx.key))).filter(
    (name) => name.endsWith(".pending-end") || name.endsWith(".pending-life"),
  );

/**
 * What a reap from before per-life markers lists (connector-core 0.10.0,
 * spool/reap.ts pendingEndSlugs): every `.pending-end` file, its whole stem
 * read as a host session's slug. A proxy started before an upgrade runs it.
 */
const slugsAnOlderReapLists = async (fx: Fixture): Promise<readonly string[]> =>
  (await readdir(spoolDir(fx.home, fx.key)))
    .filter((name) => name.endsWith(".pending-end"))
    .map((name) => name.slice(0, -".pending-end".length));

describe("a resumed life's end beside a deferred end before it", () => {
  test("each life keeps its own marker, and the next reap ends the earlier one", async () => {
    // Arrange: life K's end deferred — its last edit undelivered, the hub
    // refusing records and ends — then the resumed life's edit
    const fx = await fixture("two-ends");
    const k = await register(fx);
    await captureTarget(fx, "src/k.ts");
    await flushAsHook(fx);
    refuseRecords = true;
    refuseEnds = true;
    await captureTarget(fx, "src/k-late.ts");
    await endViaFlow(fx, fx.proxied);
    const r1 = await register(fx, fx.proxied);
    await captureTarget(fx, "src/r1.ts");
    refuseRecords = false;
    refuseEnds = false;

    // Act: the resumed life's own end, then the next SessionStart's reap
    const endR1 = await endViaFlow(fx);
    await reapAsSessionStart(fx);

    // Assert: both lives ended, each at the position its own end took
    expect(endR1.ended).toBe(true);
    expect(await isEnded(k.crosscheckSessionId)).toBe(true);
    const ends = await raw<{ session_id: string; seq_reason: string }>(
      "select session_id, seq_reason from session_events where kind = 'session.ended' and session_id like $1 order by session_id",
      [`${k.crosscheckSessionId}%`],
    );
    expect(ends).toEqual([
      { session_id: k.crosscheckSessionId, seq_reason: "sequenced" },
      { session_id: r1.crosscheckSessionId, seq_reason: "sequenced" },
    ]);
    expect(await targetsOf(k.workContextId)).toEqual(["src/k-late.ts", "src/k.ts"]);
    expect(await pendingEnds(fx)).toEqual([]);
  });

  test("ends that never land age out into the unclosed count, one per life", async () => {
    // Arrange: both lives' ends deferred while the hub refuses records and ends
    const fx = await fixture("two-ends-aged");
    await register(fx);
    refuseRecords = true;
    refuseEnds = true;
    await captureTarget(fx, "src/k.ts");
    await endViaFlow(fx, fx.proxied);
    await register(fx, fx.proxied);
    await captureTarget(fx, "src/r1.ts");
    await endViaFlow(fx, fx.proxied);
    refuseRecords = false;
    refuseEnds = false;

    // Act: a sweep past the age bound
    await reapSpool(fx.home, fx.key, new Date(Date.now() + (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY));

    // Assert: what doctor's `unclosed sessions` line reads
    expect((await readUnclosedSummary(fx.home, fx.key)).sessions).toBe(2);
    expect(await pendingEnds(fx)).toEqual([]);
  });

  test("a later life's deferred end waits for the conversation's backlog, then lands", async () => {
    // Arrange: life 0 ended; the resumed life's end deferred with its edit on disk
    const fx = await fixture("later-marker");
    const k = await register(fx);
    await endViaFlow(fx);
    const r1 = await register(fx);
    await captureTarget(fx, "src/r1.ts");
    refuseRecords = true;
    await endViaFlow(fx, fx.proxied);
    refuseRecords = false;

    // Act: a reap while the backlog is still on disk, then the next life's flush and reap
    await reapAsSessionStart(fx);
    const whileOnDisk = await isEnded(r1.crosscheckSessionId);
    await register(fx);
    await flushAsHook(fx);
    await reapAsSessionStart(fx);

    // Assert
    expect(r1.crosscheckSessionId).toBe(`${k.crosscheckSessionId}~r1`);
    expect(whileOnDisk).toBe(false);
    expect(await isEnded(r1.crosscheckSessionId)).toBe(true);
    expect(await targetsOf(r1.workContextId)).toEqual(["src/r1.ts"]);
    expect(await pendingEnds(fx)).toEqual([]);
  });

  test("a host session whose slug holds `.r` keeps its whole slug in a later life's marker (K1)", async () => {
    // Arrange: a host key with `.r` in it; life 0 ended; the resumed life's
    // end deferred with its edit on disk
    const fx = await fixture("dotted.repo");
    await register(fx);
    await endViaFlow(fx);
    const r1 = await register(fx);
    await captureTarget(fx, "src/dotted.ts");
    refuseRecords = true;
    await endViaFlow(fx, fx.proxied);
    refuseRecords = false;

    // Act: a reap while the edit is on disk
    await reapAsSessionStart(fx);

    // Assert: the marker was read against the right spool, so the end waits
    expect(await pendingEnds(fx)).toEqual([`${sessionSlug(fx.hostSessionKey)}.r1.pending-life`]);
    expect(await isEnded(r1.crosscheckSessionId)).toBe(false);
  });

  test("a later life's marker is no name an older connector's reap lists (review-2 MEDIUM-2)", async () => {
    // Arrange: life 0 ended; the resumed life's end deferred with its edit on disk
    const fx = await fixture("older-reap");
    await register(fx);
    await endViaFlow(fx);
    await register(fx);
    await captureTarget(fx, "src/r1.ts");
    refuseRecords = true;
    await endViaFlow(fx, fx.proxied);
    refuseRecords = false;

    // Act
    const listed = await slugsAnOlderReapLists(fx);

    // Assert: that reap finds no marker to end the life from — it read a later
    // life's `<slug>@r1.pending-end` as a slug with no spool, saw nothing
    // pending, and ended the life while `<slug>.jsonl` still held its edit
    expect(listed).toEqual([]);
    expect(await pendingEnds(fx)).toEqual([`${sessionSlug(fx.hostSessionKey)}.r1.pending-life`]);
  });

  test("a stray round-4 marker `<slug>@r1.pending-end` waits for its slug's backlog, then lands (review-2 round 6, LOW-2)", async () => {
    // Arrange: life 0 ended; the resumed life's edit on disk, its deferred end
    // in the spelling one build of this branch wrote
    const fx = await fixture("stray-marker");
    await register(fx);
    await endViaFlow(fx);
    const r1 = await register(fx);
    await captureTarget(fx, "src/r1.ts");
    const stray = join(spoolDir(fx.home, fx.key), `${sessionSlug(fx.hostSessionKey)}@r1.pending-end`);
    await writeFile(stray, `${JSON.stringify({ crosscheckSessionId: r1.crosscheckSessionId, at: new Date().toISOString() })}\n`);
    await rm(sessionStatePath(fx.home, fx.hostSessionKey), { force: true });

    // Act: a reap while the edit waits, then a successor's flush and reap
    await reapAsSessionStart(fx);
    const whileOnDisk = await isEnded(r1.crosscheckSessionId);
    const other = await register(fx, fx.hub, `${fx.hostSessionKey}-other`);
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, BUDGET_MS);
    await reapAsSessionStart(fx);

    // Assert
    expect(whileOnDisk).toBe(false);
    expect(await isEnded(r1.crosscheckSessionId)).toBe(true);
    expect(await targetsOf(r1.workContextId)).toEqual(["src/r1.ts"]);
    expect(await Bun.file(stray).exists()).toBe(false);
  });
});

/**
 * A HEAL THAT LANDS INSIDE SessionEnd's WINDOW (review-2 finding 2).
 * SessionEnd read life K at its start and deleted the state unconditionally
 * at its end; a heal that moved the state to K's next life in between was
 * left open on the hub with no state file naming it, so the next resume
 * landed on it under a fresh epoch and split its order.
 */
describe("a heal that moves the state while SessionEnd runs", () => {
  test("SessionEnd ends the healed life too, and the next resume starts above it", async () => {
    // Arrange: SessionEnd has read life K; a heal then moves the state on
    const fx = await fixture("heal-in-end");
    const k = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, k.crosscheckSessionId);
    const healed = await healerFor(fx)({ sessionId: k.crosscheckSessionId, cause: "session_ended" }, Date.now() + BUDGET_MS);

    // Act: the end of the life SessionEnd read, then a resume
    await endSessionFlow({
      home: fx.home,
      repoKey: fx.key,
      hub: fx.hub,
      hostSessionKey: fx.hostSessionKey,
      crosscheckSessionId: k.crosscheckSessionId,
      developerId,
      flushBudgetMs: BUDGET_MS,
      now: () => new Date(),
    });
    const resumed = await register(fx);
    await captureTarget(fx, "src/after-resume.ts");
    await flushAsHook(fx);
    // ...and SessionStart's reap: the healed life's end waited for the work
    // context it was owed (spool/owed-work-context.ts), deferred to its marker
    await reapAsSessionStart(fx);

    // Assert: the healed life closed, the resume a fresh one, both orders whole
    const healedLife = `${k.crosscheckSessionId}~r1`;
    expect(healed).toMatchObject({ outcome: "healed", refusedSessionId: k.crosscheckSessionId, sessionId: healedLife });
    expect(await isEnded(healedLife)).toBe(true);
    expect(resumed.crosscheckSessionId).toBe(`${k.crosscheckSessionId}~r2`);
    for (const id of [healedLife, resumed.crosscheckSessionId]) {
      expect(await readSessionCausalOrder(db, id)).toMatchObject({ state: "usable", epochs: 1 });
    }
    expect(await targetsOf(resumed.workContextId)).toEqual(["src/after-resume.ts"]);
    expect(await pendingEnds(fx)).toEqual([]);
  });
});

/**
 * A SessionEnd BETWEEN A HEAL'S SWITCH AND ITS RE-SEND (review-2 LOW-4,
 * round 6). The heal switches the state to the next life and owes its work
 * context in one locked step (flows/heal-session.ts); the flush that asked
 * for the heal then re-sends its refused batch under that life. A SessionEnd
 * landing in between found the new life, counted an empty backlog and ended
 * it — and the re-send under an ended life was refused as a late write,
 * another conversation's backlog with it. The owed work context counts as
 * undelivered, so that SessionEnd defers, and the re-send lands.
 */
describe("a SessionEnd between a heal's switch and its re-send", () => {
  test("defers the healed life's end, and the re-send under it lands", async () => {
    // Arrange: life K delivered, then an ended conversation's backlog on disk,
    // both conversations' lives ended by the hub
    const fx = await fixture("end-before-resend");
    const k = await register(fx);
    await flushAsHook(fx);
    const otherHost = `${fx.hostSessionKey}-other`;
    const other = await register(fx, fx.hub, otherHost);
    await appendRecords(
      fx.home,
      fx.key,
      otherHost,
      [targetRecord(other.workContextId, "file", "src/other.ts", producerOf(other.crosscheckSessionId), new Date())],
      new Date(),
    );
    await rm(sessionStatePath(fx.home, otherHost), { force: true });
    await endSession(fx.hub, k.crosscheckSessionId);
    await endSession(fx.hub, other.crosscheckSessionId);
    const healed = await healerFor(fx)({ sessionId: k.crosscheckSessionId, cause: "session_ended" }, Date.now() + BUDGET_MS);
    const healedLife = `${k.crosscheckSessionId}~r1`;

    // Act: SessionEnd of the life it read, then the heal's re-send under the healed life
    const ended = await endSessionFlow({
      home: fx.home,
      repoKey: fx.key,
      hub: fx.hub,
      hostSessionKey: fx.hostSessionKey,
      crosscheckSessionId: k.crosscheckSessionId,
      developerId,
      flushBudgetMs: 0,
      now: () => new Date(),
    });
    await flushSpool(fx.hub, { sessionId: healedLife, developerId }, BUDGET_MS);

    // Assert: the end waited, and the backlog went under a life still open
    expect(healed).toMatchObject({ outcome: "healed", sessionId: healedLife });
    expect(ended.ended).toBe(false);
    expect(await targetsOf(other.workContextId)).toEqual(["src/other.ts"]);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
  });
});

/**
 * THE EDGES OF SessionEnd's COMPARED DELETE (review-2 LOW-6): a deferred end
 * of a life a heal moved the state to, and a state lock that stays busy.
 */
describe("SessionEnd at the edges", () => {
  const endLife = (fx: Fixture, crosscheckSessionId: string, flushBudgetMs: number) =>
    endSessionFlow({
      home: fx.home,
      repoKey: fx.key,
      hub: fx.hub,
      hostSessionKey: fx.hostSessionKey,
      crosscheckSessionId,
      developerId,
      flushBudgetMs,
      now: () => new Date(),
    });

  test("with no room to deliver, defers the healed life's end too, and the next resume starts above it (M8)", async () => {
    // Arrange: SessionEnd has read life K; a heal moved the state to K~r1
    const fx = await fixture("deferred-healed");
    const k = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, k.crosscheckSessionId);
    await healerFor(fx)({ sessionId: k.crosscheckSessionId, cause: "session_ended" }, Date.now() + BUDGET_MS);
    const healedLife = `${k.crosscheckSessionId}~r1`;

    // Act: the end with no budget to drain, then a resume, its flush and its reap
    const ended = await endLife(fx, k.crosscheckSessionId, 0);
    const markers = await pendingEnds(fx);
    const resumed = await register(fx);
    await flushAsHook(fx);
    await reapAsSessionStart(fx);

    // Assert: both lives deferred, each from its own marker; the resume above both
    expect(ended.ended).toBe(false);
    expect(markers).toContain(`${sessionSlug(fx.hostSessionKey)}.r1.pending-life`);
    expect(resumed.crosscheckSessionId).toBe(`${k.crosscheckSessionId}~r2`);
    expect(await isEnded(healedLife)).toBe(true);
    expect(await readSessionCausalOrder(db, healedLife)).toMatchObject({ state: "usable", epochs: 1 });
  });

  test("whose state lock stays busy still deletes the state (M11)", async () => {
    // Arrange
    const fx = await fixture("busy-close");
    const life = await register(fx);
    await flushAsHook(fx);

    // Act: the whole end runs while another holder keeps the state's lock
    await withLock(sessionStateLockPath(fx.home, fx.hostSessionKey), null, async () => {
      await endLife(fx, life.crosscheckSessionId, BUDGET_MS);
      return null;
    });

    // Assert: no state file left to pin the spool
    expect(await stateOf(fx)).toBeNull();
  });
});

/**
 * A HEAL WHOSE SWITCH MEETS A BUSY STATE LOCK (review-2 round 6, MEDIUM-1).
 * The switch answered a plain no; the heal took it for a lost race, found the
 * state still on the refused id — the very life a same-id heal had just
 * registered — and retired it: the live life ended on the hub, and its first
 * window was refused as late writes (RS5-B, RS5-B2).
 */
describe("a heal whose state switch meets a busy lock", () => {
  /** Runs the heal while another holder keeps the state's lock past the switch's patience. */
  const healUnderBusyLock = async (
    fx: Fixture,
    sessionId: string,
    holdMs: number = LOCK_PAST_PATIENCE_MS,
    cause: SessionRefusal["cause"] = "session_unknown",
  ): Promise<unknown> => {
    let healing: Promise<unknown> = Promise.resolve();
    await withLock(sessionStateLockPath(fx.home, fx.hostSessionKey), false, async () => {
      healing = healerFor(fx, fx.proxied)({ sessionId, cause }, Date.now() + BUDGET_MS);
      await Bun.sleep(holdMs);
      return true;
    });
    return healing;
  };

  test("retires nothing, and the next walk lands on the life it registered (review-2 round 7, O27)", async () => {
    // Arrange: a life the hub ended; the lock frees after the switch gave up,
    // in time for anything that would still want it
    const fx = await fixture("busy-then-free");
    const life = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, life.crosscheckSessionId);
    const refusal = { sessionId: life.crosscheckSessionId, cause: "session_ended" } as const;

    // Act: the walk the busy lock defers, then the next one
    const deferred = await healUnderBusyLock(fx, life.crosscheckSessionId, LOCK_FREES_FOR_RETIREMENT_MS, refusal.cause);
    const next = `${life.crosscheckSessionId}~r1`;
    const endedAfterBusy = await isEnded(next);
    const healed = await healerFor(fx, fx.proxied)(refusal, Date.now() + BUDGET_MS);

    // Assert: the life the busy walk registered stayed open and is the one the next walk lands on; no third life
    const lives = await raw<{ id: string }>("select id from agent_sessions where id like $1 order by id", [
      `${life.crosscheckSessionId}%`,
    ]);
    expect(deferred).toEqual({ outcome: "pending" });
    expect(endedAfterBusy).toBe(false);
    expect(healed).toMatchObject({ outcome: "healed", sessionId: next });
    expect(lives.map((row) => row.id)).toEqual([life.crosscheckSessionId, next]);
    expect(await isEnded(next)).toBe(false);
  });

  test("answers pending and leaves the life the state names open (RS5-B)", async () => {
    // Arrange: a life whose register did not land, an edit of it on disk
    const fx = await fixture("busy-swap");
    refuseRegisters = true;
    const life = await register(fx, fx.proxied);
    refuseRegisters = false;
    await captureTarget(fx, "src/busy.ts");

    // Act
    const healed = await healUnderBusyLock(fx, life.crosscheckSessionId);

    // Assert
    expect(healed).toEqual({ outcome: "pending" });
    expect((await stateOf(fx))?.crosscheckSessionId).toBe(life.crosscheckSessionId);
    expect(await isEnded(life.crosscheckSessionId)).toBe(false);
  });

  test("the next flush heals the life, and its first window lands (RS5-B2)", async () => {
    // Arrange
    const fx = await fixture("busy-swap-window");
    refuseRegisters = true;
    const life = await register(fx, fx.proxied);
    refuseRegisters = false;
    for (const file of ["src/w1.ts", "src/w2.ts", "src/w3.ts"]) {
      await captureTarget(fx, file);
    }

    // Act: the heal the busy lock defers, then the next hook's flush
    await healUnderBusyLock(fx, life.crosscheckSessionId);
    await flushAsHook(fx);

    // Assert: no cooldown spent on it, nothing ended, every edit landed
    expect((await stateOf(fx))?.crosscheckSessionId).toBe(life.crosscheckSessionId);
    expect(await targetsOf(life.workContextId)).toEqual(["src/w1.ts", "src/w2.ts", "src/w3.ts"]);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
  });
});

/**
 * TWO SHAPES THE SPOOL SIMULATION FOUND (test/spool-simulation.test.ts,
 * review-2 round 7): a SessionStart re-fire put back the status set_intent had
 * set (seed 10, I4), and a SessionStart whose ladder climbed past a life the
 * hub had ended let that life's records be filed into it after its end (seed
 * 8, I2) — the heal withholds such records, the ladder did not.
 */
describe("a SessionStart killed between its register and its state (review-2 round 7, found by the spool simulation)", () => {
  test("is followed by one that keeps the epoch the hub filed session.started under", async () => {
    // Arrange: the hub holds the life's session.started under epoch E; only the reservation names E
    const fx = await fixture("reserved-epoch");
    const epoch = crypto.randomUUID();
    const lifeId = `cc_${fx.hostSessionKey}`;
    await registerSession(fx.hub, {
      id: lifeId,
      agentKind: "acp:test",
      repo: REPO_ID,
      branch: BRANCH,
      baseCommit: BASE_COMMIT,
      status: "analyzing",
      seq: { epoch, n: 0 },
    });
    const reservation = sessionEpochPathForSlug(fx.home, sessionSlug(fx.hostSessionKey));
    await mkdir(dirname(reservation), { recursive: true });
    await writeFile(reservation, `${JSON.stringify({ epoch })}\n`);

    // Act: the next SessionStart, and an edit
    const life = await register(fx);
    await captureTarget(fx, "src/after-reservation.ts");
    await flushAsHook(fx);

    // Assert: one epoch on the hub, and the reservation spent
    expect(life.crosscheckSessionId).toBe(lifeId);
    expect((await stateOf(fx))?.seqEpoch).toBe(epoch);
    expect(await readSessionCausalOrder(db, lifeId)).toMatchObject({ state: "usable", epochs: 1 });
    expect(await Bun.file(sessionEpochPathForSlug(fx.home, sessionSlug(fx.hostSessionKey))).exists()).toBe(false);
  });

  test("is followed by one that keeps that epoch even while the state lock stays busy (review-2 round 8, L2)", async () => {
    // Arrange: the same, the reservation the only thing naming E
    const fx = await fixture("reserved-epoch-busy");
    const epoch = crypto.randomUUID();
    await registerSession(fx.hub, {
      id: `cc_${fx.hostSessionKey}`,
      agentKind: "acp:test",
      repo: REPO_ID,
      branch: BRANCH,
      baseCommit: BASE_COMMIT,
      status: "analyzing",
      seq: { epoch, n: 0 },
    });
    const reservation = sessionEpochPathForSlug(fx.home, sessionSlug(fx.hostSessionKey));
    await mkdir(dirname(reservation), { recursive: true });
    await writeFile(reservation, `${JSON.stringify({ epoch })}\n`);

    // Act: the next SessionStart decides and publishes past a lock another holder keeps
    await withLock(sessionStateLockPath(fx.home, fx.hostSessionKey), null, async () => {
      await register(fx);
      return null;
    });

    // Assert: the fallback wrote the reserved epoch, not a fresh mint
    expect((await stateOf(fx))?.seqEpoch).toBe(epoch);
  });
});

describe("a SessionStart that re-fires inside a live conversation", () => {
  test("keeps the status set_intent set since, on the hub and in the state", async () => {
    // Arrange: a live life whose status set_intent moved to `blocked`
    const fx = await fixture("refire-status");
    const life = await register(fx);
    await flushAsHook(fx);
    const intent = withProducer(
      workContextRecord(
        { workContextId: life.workContextId, sessionId: life.crosscheckSessionId, title: "Mine", status: "blocked" },
        producerOf(life.crosscheckSessionId),
        new Date(),
      ),
      developerId,
      life.crosscheckSessionId,
    );
    await postRecords(fx.hub, [intent]);
    await updateSessionState(fx.home, fx.hostSessionKey, (fresh) => ({ ...fresh, workContextStatus: "blocked" }));

    // Act: compact, resume or clear fires SessionStart again; its hook flushes
    await register(fx);
    await flushAsHook(fx);

    // Assert
    const rows = await raw<{ status: string }>("select status from work_contexts where id = $1", [life.workContextId]);
    expect(rows).toEqual([{ status: "blocked" }]);
    expect((await stateOf(fx))?.workContextStatus).toBe("blocked");
  });

  test("keeps a status set_intent writes while its register is in flight (review-2 round 8, L1)", async () => {
    // Arrange: a live life; the re-fire's register is slow
    const fx = await fixture("refire-status-in-flight");
    const life = await register(fx, fx.proxied);
    await flushAsHook(fx, fx.proxied);
    registerDelayMs = WALK_DELAY_MS;

    // Act: SessionStart fires again; set_intent writes `blocked` while its register is out
    const refire = register(fx, fx.proxied);
    await Bun.sleep(WALK_HEAD_START_MS);
    await updateSessionState(fx.home, fx.hostSessionKey, (fresh) => ({
      ...fresh,
      workContextTitle: "Set by intent",
      workContextStatus: "blocked",
    }));
    await refire;
    registerDelayMs = 0;
    const spooled = await spooledStatuses(fx);
    await flushAsHook(fx, fx.proxied);

    // Assert: the re-fire's state, the work context it spooled — the copy a
    // send without the life's state files as-is — and the hub carry it
    expect(spooled).toEqual(["blocked"]);
    const rows = await raw<{ status: string }>("select status from work_contexts where id = $1", [life.workContextId]);
    expect(rows).toEqual([{ status: "blocked" }]);
    expect((await stateOf(fx))?.workContextStatus).toBe("blocked");
    expect((await stateOf(fx))?.workContextTitle).toBe("Set by intent");
  });

  test("keeps a status set_intent writes after its register is back, before it publishes (review-2 round 8, L1)", async () => {
    // Arrange: a live life; the re-fire's register is slow
    const fx = await fixture("refire-status-at-publish");
    await register(fx, fx.proxied);
    await flushAsHook(fx, fx.proxied);
    registerDelayMs = WALK_DELAY_MS;

    // Act: SessionStart fires again; set_intent holds the state lock across
    // the register's return, and writes `blocked` under it
    const refire = register(fx, fx.proxied);
    await Bun.sleep(WALK_HEAD_START_MS);
    await withLock(sessionStateLockPath(fx.home, fx.hostSessionKey), false, async () => {
      await Bun.sleep(WALK_DELAY_MS + RACE_DELAY_MS);
      const held = await stateOf(fx);
      if (held !== null) {
        await writeSessionState(fx.home, { ...held, workContextTitle: "Set by intent", workContextStatus: "blocked" });
      }
      return true;
    });
    await refire;
    registerDelayMs = 0;

    // Assert: the publish took what the file held under its lock
    expect((await stateOf(fx))?.workContextStatus).toBe("blocked");
    expect((await stateOf(fx))?.workContextTitle).toBe("Set by intent");
  });

  test("withholds the records of a life the hub ended, never filing them into it past its end", async () => {
    // Arrange: the hub ends the life; one of its edits is still on disk
    const fx = await fixture("refire-ended");
    const life = await register(fx);
    await flushAsHook(fx);
    await endSession(fx.hub, life.crosscheckSessionId);
    await captureTarget(fx, "src/after-end.ts");

    // Act: SessionStart re-fires, its ladder climbs past the ended life, and the hook flushes
    const next = await register(fx);
    await flushAsHook(fx);

    // Assert: on the next life; the ended one holds no record of it, and the edit is counted withheld
    expect(next.crosscheckSessionId).toBe(`${life.crosscheckSessionId}~r1`);
    expect(await targetsOf(life.workContextId)).toEqual([]);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({ withheld: 1 });
  });
});

/**
 * ONE EPOCH FOR ONE LIFE, WHATEVER RUNS BESIDE ITS SESSIONSTART (review-2
 * round 8, L2, seeds 134, 1933, 11285, 11683 and 11974). Two SessionStarts of
 * one conversation each minted an epoch, and the life's `session.started` and
 * its state could take different ones. A SessionEnd that deleted the state
 * while a re-fire's register was out left the re-fire's publish nothing to
 * carry, and it started the state on a fresh mint beside the carried epoch its
 * register had sent.
 */
describe("a SessionStart beside another SessionStart or a SessionEnd (review-2 round 8, L2)", () => {
  const causalOrderOf = async (fx: Fixture) => {
    const state = await stateOf(fx);
    if (state === null) throw new Error("no session state");
    await captureTarget(fx, "src/after-the-race.ts");
    await flushAsHook(fx, fx.proxied);
    return readSessionCausalOrder(db, state.crosscheckSessionId);
  };

  test("two at once take one epoch: the register that lands and the state agree", async () => {
    // Arrange: the first register to arrive is slow and lands; the second is refused at once
    const fx = await fixture("two-starts");
    registerScript = ["slow", "refused"];

    // Act: two SessionStarts of one conversation at once, then an edit
    await Promise.all([register(fx, fx.proxied), register(fx, fx.proxied)]);
    registerScript = [];
    const order = await causalOrderOf(fx);

    // Assert
    expect(order).toMatchObject({ state: "usable", epochs: 1 });
  });

  test("a re-fire whose state a SessionEnd deletes starts the next life on the epoch its register sent", async () => {
    // Arrange: a life the hub ended; the re-fire's walk to the next life is slow
    const fx = await fixture("start-beside-end");
    const life = await register(fx, fx.proxied);
    await flushAsHook(fx, fx.proxied);
    const epoch = (await stateOf(fx))?.seqEpoch;
    await endSession(fx.hub, life.crosscheckSessionId);
    registerDelayMs = WALK_DELAY_MS;

    // Act: SessionStart re-fires; SessionEnd deletes the state while its register is out
    const refire = register(fx, fx.proxied);
    await Bun.sleep(WALK_HEAD_START_MS);
    await endViaFlow(fx);
    const next = await refire;
    registerDelayMs = 0;
    const order = await causalOrderOf(fx);

    // Assert: the next life holds one epoch, the one the conversation was on
    expect(next.crosscheckSessionId).toBe(`${life.crosscheckSessionId}~r1`);
    expect((await stateOf(fx))?.seqEpoch).toBe(epoch);
    expect(order).toMatchObject({ state: "usable", epochs: 1 });
  });

  test("a re-fire whose own life's state a SessionEnd deletes hands out no position that life already holds", async () => {
    // Arrange: a live life with two positioned edits on the hub; the hub
    // refuses its end, so it stays live; the re-fire's register is slow
    const fx = await fixture("own-life-beside-end");
    const life = await register(fx, fx.proxied);
    await captureTarget(fx, "src/one.ts");
    await captureTarget(fx, "src/two.ts");
    await flushAsHook(fx, fx.proxied);
    registerDelayMs = WALK_DELAY_MS;
    refuseEnds = true;

    // Act: SessionStart re-fires on the life; SessionEnd deletes the state while its register is out
    const refire = register(fx, fx.proxied);
    await Bun.sleep(WALK_HEAD_START_MS);
    await endViaFlow(fx, fx.proxied);
    const same = await refire;
    registerDelayMs = 0;
    refuseEnds = false;
    await captureTarget(fx, "src/three.ts");
    await flushAsHook(fx, fx.proxied);

    // Assert: the counter is gone with the file, so the life's order is not
    // comparable across the fire — and no record lost its position to a
    // position the life had already handed out
    const conflicts = await raw<{ id: string }>(
      "select id from session_events where session_id = $1 and seq_reason = 'epoch_conflict'",
      [life.crosscheckSessionId],
    );
    expect(same.crosscheckSessionId).toBe(life.crosscheckSessionId);
    expect(conflicts).toEqual([]);
  });

  test("a resume onto a life a heal registered unheard keeps the epoch the hub filed it under (seed 11974)", async () => {
    // Arrange: life 0 on epoch E; a heal's register of ~r1 under E landed
    // after the heal stopped listening, so the state never moved; SessionEnd
    // ends life 0 and deletes the state
    const fx = await fixture("unheard-heal");
    const life = await register(fx);
    const epoch = (await stateOf(fx))?.seqEpoch ?? "";
    const next = `${life.crosscheckSessionId}~r1`;
    await registerSession(fx.hub, {
      id: next,
      agentKind: "acp:test",
      repo: REPO_ID,
      branch: BRANCH,
      baseCommit: BASE_COMMIT,
      status: "analyzing",
      seq: { epoch, n: 0 },
    });
    await endViaFlow(fx);

    // Act: the conversation resumes, and an edit follows
    const resumed = await register(fx);
    const order = await causalOrderOf(fx);

    // Assert: the resume is on ~r1, under the epoch its session.started holds
    expect(resumed.crosscheckSessionId).toBe(next);
    expect((await stateOf(fx))?.seqEpoch).toBe(epoch);
    expect(order).toMatchObject({ state: "usable", epochs: 1 });
  });

  test("a re-fire reserves the epoch it carries, so a register killed after its POST names it on disk", async () => {
    // Arrange: a live life; the re-fire's register is slow
    const fx = await fixture("refire-reserves");
    await register(fx, fx.proxied);
    const epoch = (await stateOf(fx))?.seqEpoch;
    registerDelayMs = WALK_DELAY_MS;

    // Act: read the reservation while the re-fire's register is out
    const refire = register(fx, fx.proxied);
    await Bun.sleep(WALK_HEAD_START_MS);
    const reserved = await Bun.file(sessionEpochPathForSlug(fx.home, sessionSlug(fx.hostSessionKey))).text();
    await refire;
    registerDelayMs = 0;

    // Assert
    expect(JSON.parse(reserved)).toMatchObject({ epoch });
  });
});

/**
 * A LIFE SESSIONEND ENDED (review-2 round 8, M1, seed 782 and probe C1). Its
 * own end never wrote the life down as refused, so a record of it appended
 * after the end — a reload's SessionStart re-fire beside the old process's
 * SessionEnd — was sent by a successor and filed into the ended session.
 */
describe("a life SessionEnd ended (review-2 round 8, M1)", () => {
  const straggler = (fx: Fixture, life: { workContextId: string; crosscheckSessionId: string }, file: string) =>
    appendRecords(
      fx.home,
      fx.key,
      fx.hostSessionKey,
      [targetRecord(life.workContextId, "file", file, producerOf(life.crosscheckSessionId), new Date())],
      new Date(),
    );

  test("withholds a record appended after its own end landed, never files it into the ended session", async () => {
    // Arrange: a life that ends cleanly, then a parallel process's straggler of it
    const fx = await fixture("own-end-refused");
    const life = await register(fx);
    await flushAsHook(fx);
    const ended = await endViaFlow(fx);
    await straggler(fx, life, "src/after-end.ts");

    // Act: another conversation's flush
    const other = await register(fx, fx.hub, `${fx.hostSessionKey}-other`);
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, BUDGET_MS);

    // Assert
    expect(ended.ended).toBe(true);
    expect(await targetsOf(life.workContextId)).toEqual([]);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({ withheld: 1 });
  });

  test("and once its deferred end lands from reap", async () => {
    // Arrange: SessionEnd deferred while the hub refused records; a successor
    // delivers the backlog and its SessionStart's reap ends the life
    const fx = await fixture("deferred-end-refused");
    const life = await register(fx);
    await flushAsHook(fx);
    await captureTarget(fx, "src/late.ts");
    refuseRecords = true;
    await endViaFlow(fx, fx.proxied);
    refuseRecords = false;
    const other = await register(fx, fx.hub, `${fx.hostSessionKey}-other`);
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, BUDGET_MS);
    await reapAsSessionStart(fx);
    await straggler(fx, life, "src/after-deferred-end.ts");

    // Act
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, BUDGET_MS);

    // Assert
    expect(await isEnded(life.crosscheckSessionId)).toBe(true);
    expect(await targetsOf(life.workContextId)).toEqual(["src/late.ts"]);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({ withheld: 1 });
  });
});
