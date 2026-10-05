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
import { rm } from "node:fs/promises";

import { createDb, createServer, readSessionCausalOrder } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { repoKey } from "../src/config/paths.ts";
import { targetRecord } from "../src/capture/records.ts";
import type { Producer } from "../src/capture/records.ts";
import { seqAt, withSeq } from "../src/capture/seq.ts";
import type { HubContext } from "../src/http/client.ts";
import { endSession } from "../src/http/hub.ts";
import { endSessionFlow } from "../src/flows/end-session.ts";
import { sessionHealer } from "../src/flows/heal-session.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { appendRecords } from "../src/spool/append.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { flushSpool } from "../src/spool/flush.ts";
import { reapSpool } from "../src/spool/reap.ts";
import { allocateSeq, readSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "lives-admin";
const REPO_ID = "github.com/acme/api";
const BRANCH = "main";
const BASE_COMMIT = "0000000000000000000000000000000000000000";
const TIMEOUT_MS = 4000;
const BUDGET_MS = 3000;
/** How much older a backlog is made so the oldest-first drain takes it first. */
const OLDER_MS = 60_000;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let proxyUrl: string;
let apiKey: string;
let developerId: string;
/** The proxy's dials. */
let refuseRegisters = false;
let refuseEnds = false;
let registerDelayMs = 0;
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
        if (refuseRegisters) {
          return Response.json({ ok: false, error: { code: "unavailable", message: "down" } }, { status: 503 });
        }
        if (registerDelayMs > 0) {
          await Bun.sleep(registerDelayMs);
        }
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

  /** Another conversation's pending edit, OLDER than anything of this one, so it drains first. */
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
    return { host, workContextId: other.workContextId };
  };

  test("a refused flusher that cannot heal leaves another conversation's records on disk", async () => {
    // Arrange: this conversation ended by the hub, a hub that refuses every
    // register so no heal can land, and the other conversation's older edit
    const fx = await fixture("other-at-stake");
    const other = await otherBacklog(fx);
    const life = await register(fx);
    await endSession(fx.hub, life.crosscheckSessionId);

    // Act: this conversation's flush, refused and unhealable; then the other's own flush
    refuseRegisters = true;
    await flushAs(fx, fx.hostSessionKey, fx.proxied);
    refuseRegisters = false;
    const spent = (await readDropDetail(fx.home, fx.key)).byReason["rejected"] ?? 0;
    await flushAs(fx, other.host);

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
    await flushAs(fx, other.host);

    // Assert
    expect(spent).toBe(0);
    expect(await targetsOf(other.workContextId)).toEqual(["src/other.ts"]);
  });
});
