/**
 * A SESSION THE HUB REFUSES HEALS MID-LIFE (flows/heal-session.ts).
 *
 * The life ladder only runs at SessionStart, so a session the hub ended or
 * never heard of — a sibling process's SessionEnd, a register that did not
 * land, a 0.10 conversation already deaf at upgrade — kept capturing into a
 * session id every record of which the hub refused, until the host fired
 * SessionStart again. The flush now sees its OWN producer refused, walks the
 * ladder once, registers the next life, and re-sends what the refused batch
 * may honestly carry under it; a heartbeat refused the same way does the
 * same walk. A cooldown keeps a hub that refuses everything from turning
 * every hook into register calls, and the walk lives inside the flush's
 * deadline.
 *
 * WHAT IS NOT RE-SENT, AND WHY: a record whose body names its session
 * (target, claim, claim_edge, work_context) and that was produced in the
 * refused life. The hub files its position in the session its body names, so
 * under the next life it would land in an ENDED session after that session's
 * end — or under an epoch that session never had — and misstate its order.
 * Those drop, counted with the cause `session_ended`, exactly as before.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";

import { createDb, createServer, readSessionCausalOrder } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { HEAL_COOLDOWN_MS } from "../src/constants.ts";
import { repoKey, sessionSlug, spoolDataPath } from "../src/config/paths.ts";
import { commitEvidenceRecord } from "../src/capture/commit-evidence.ts";
import { targetRecord } from "../src/capture/records.ts";
import type { Producer } from "../src/capture/records.ts";
import { withSeq } from "../src/capture/seq.ts";
import type { HubContext } from "../src/http/client.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { sessionHealer } from "../src/flows/heal-session.ts";
import { heartbeatMaybe } from "../src/flows/heartbeat.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { appendRecords } from "../src/spool/append.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { flushSpool } from "../src/spool/flush.ts";
import { recordRefusedLife } from "../src/spool/refused-lives.ts";
import { readSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "heal-admin";
const REPO_ID = "github.com/acme/api";
const BRANCH = "main";
const BASE_COMMIT = "0000000000000000000000000000000000000000";
const TIMEOUT_MS = 4000;
const GENEROUS_BUDGET_MS = 3000;
/** A flush handed this little room must come back inside it, heal or not. */
const TIGHT_BUDGET_MS = 300;
/** What the deadline check and one clamped request may add on a busy runner. */
const BUDGET_SLACK_MS = 250;
/** A register slower than any budget above. */
const SLOW_REGISTER_MS = 2000;
/** Apart enough that the oldest-backlog-first drain orders the two spools. */
const SPOOL_ORDER_GAP_MS = 5;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let proxyUrl: string;
let apiKey: string;
let developerId: string;
/** The proxy's dials: refuse every register, or hold it this long. */
let refuseRegisters = false;
let registerDelayMs = 0;
let registerCalls = 0;
const cleanups: string[] = [];

/**
 * The hub's own rows, read through PGlite directly: this package has no
 * drizzle edge, and the connector suites ask the database the same way.
 */
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

const fixture = async (label: string, url: string = hubUrl): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const key = repoKey(url, REPO_ID);
  return {
    home,
    repo,
    key,
    hostSessionKey: `acp-test--${label}`,
    hub: { hubUrl: url, apiKey, timeoutMs: TIMEOUT_MS, home, repoKey: key, now: () => new Date() },
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

const healerFor = (fx: Fixture, now: () => Date = () => new Date()) =>
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
    now,
  });

/** The flush a hook makes: under the session its state names, with the healer. */
const flushAsHook = async (
  fx: Fixture,
  budgetMs: number = GENEROUS_BUDGET_MS,
  now?: () => Date,
): Promise<void> => {
  const state = await readSessionState(fx.home, fx.hostSessionKey);
  if (state === null) throw new Error("no session state");
  await flushSpool(
    fx.hub,
    { sessionId: state.crosscheckSessionId, developerId, heal: healerFor(fx, now) },
    budgetMs,
  );
};

/** Another process ends the session — a sibling's SessionEnd, as the hub sees it. */
const endOnHub = async (sessionId: string): Promise<void> => {
  await fetch(`${hubUrl}/api/sessions/${encodeURIComponent(sessionId)}/end`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: "{}",
  });
};

const producerOf = (sessionId: string): Producer => ({ developerId, agentKind: "acp:test", sessionId });

const appendTo = async (
  fx: Fixture,
  hostSessionKey: string,
  records: readonly Record<string, unknown>[],
): Promise<void> => {
  await appendRecords(fx.home, fx.key, hostSessionKey, records, new Date());
};

const targetsOf = async (workContextId: string): Promise<readonly string[]> => {
  const rows = await raw<{ value: string }>(
    "select value from work_context_targets where work_context_id = $1 order by value",
    [workContextId],
  );
  return rows.map((row) => row.value);
};

const sessionRow = async (id: string): Promise<{ ended: boolean } | undefined> => {
  const rows = await raw<{ ended: boolean }>(
    "select ended_at is not null as ended from agent_sessions where id = $1",
    [id],
  );
  return rows[0];
};

const stateId = async (fx: Fixture): Promise<string | undefined> =>
  (await readSessionState(fx.home, fx.hostSessionKey))?.crosscheckSessionId;

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;
  proxy = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname, search } = new URL(request.url);
      if (request.method === "POST" && pathname === "/api/sessions") {
        registerCalls += 1;
        if (refuseRegisters) {
          return Response.json({ ok: false, error: { code: "unavailable", message: "down" } }, { status: 503 });
        }
        if (registerDelayMs > 0) {
          await Bun.sleep(registerDelayMs);
        }
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
    body: JSON.stringify({ name: "Healer", email: "healer@example.com" }),
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

describe("a flush whose own session the hub ended", () => {
  test("registers the next life, spools its work context, and later records land", async () => {
    // Arrange: a live life, delivered, then ended by another process
    const fx = await fixture("heal-ended");
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/after-end.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);

    // Act
    await flushAsHook(fx);
    const healed = await readSessionState(fx.home, fx.hostSessionKey);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(
        healed?.workContextId ?? "",
        "file",
        "src/next-life.ts",
        producerOf(healed?.crosscheckSessionId ?? ""),
        new Date(),
      ),
    ]);
    await flushAsHook(fx);

    // Assert: the next life is live, the ended one stays ended
    expect(healed?.crosscheckSessionId).toBe(`${life.crosscheckSessionId}~r1`);
    expect(await sessionRow(life.crosscheckSessionId)).toEqual({ ended: true });
    expect(await sessionRow(`${life.crosscheckSessionId}~r1`)).toEqual({ ended: false });
    // ...the edit after the end is NOT filed into the ended life
    expect(await targetsOf(life.workContextId)).toEqual([]);
    expect(await targetsOf(`wc_${life.crosscheckSessionId}~r1`)).toEqual(["src/next-life.ts"]);
    // ...and its loss is counted under the cause it had
    const drops = await readDropDetail(fx.home, fx.key);
    expect(drops.byReason["rejected"]).toBe(1);
    expect(drops.rejectedCauses).toEqual({ session_ended: 1 });
  });

  test("re-sends what the refused life did not author, and withholds what it did", async () => {
    // Arrange: the refused life's own batch (a body-naming target and a
    // producer-filed commit_evidence), then another session's backlog
    const fx = await fixture("heal-resend");
    const life = await register(fx);
    const otherHost = `${fx.hostSessionKey}-other`;
    const otherLife = await register(fx, otherHost);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    const author = { name: "Dev", email: "dev@example.com", latestCommitAt: new Date().toISOString(), commitCount: 1 };
    const epoch = (await readSessionState(fx.home, fx.hostSessionKey))?.seqEpoch ?? "";
    await appendTo(fx, fx.hostSessionKey, [
      withSeq(commitEvidenceRecord(REPO_ID, [author], producerOf(life.crosscheckSessionId), new Date()), {
        epoch,
        n: 7,
      }),
      targetRecord(life.workContextId, "file", "src/refused-life.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await Bun.sleep(SPOOL_ORDER_GAP_MS);
    await appendTo(fx, otherHost, [
      targetRecord(otherLife.workContextId, "file", "src/other-backlog.ts", producerOf(otherLife.crosscheckSessionId), new Date()),
    ]);

    // Act
    await flushAsHook(fx);

    // Assert: the producer-filed record went under the next life, unpositioned
    const next = `${life.crosscheckSessionId}~r1`;
    const observed = await raw(
      "select seq_n, seq_reason from session_events where session_id = $1 and kind = 'commit.observed'",
      [next],
    );
    expect(observed).toEqual([{ seq_n: null, seq_reason: "foreign_session_delivery" }]);
    // ...the other session's backlog landed where its body names, as any successor flush delivers it
    expect(await targetsOf(otherLife.workContextId)).toEqual(["src/other-backlog.ts"]);
    // ...and the refused life's own target was withheld and counted
    expect(await targetsOf(life.workContextId)).toEqual([]);
    const ended = await raw(
      "select count(*)::int as n from session_events where session_id = $1 and kind = 'file.modified'",
      [life.crosscheckSessionId],
    );
    expect(ended).toEqual([{ n: 0 }]);
    expect((await readDropDetail(fx.home, fx.key)).rejectedCauses).toEqual({ session_ended: 1 });
  });

  test("a straggler of the refused life flushed later is withheld too", async () => {
    // Arrange: healed once; a parallel hook's record of the refused life lands afterwards
    const fx = await fixture("heal-straggler");
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/first.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await flushAsHook(fx);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/straggler.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);

    // Act: the next hook flushes under the healed life
    await flushAsHook(fx);

    // Assert
    expect(await targetsOf(life.workContextId)).toEqual([]);
    const drops = await readDropDetail(fx.home, fx.key);
    expect(drops.byReason).toEqual({ rejected: 1, withheld: 1 });
    expect(drops.rejectedCauses).toEqual({ session_ended: 1 });
  });
});

describe("a flush whose own session the hub never registered", () => {
  test("registers that same session and re-sends the whole batch, order intact", async () => {
    // Arrange: SessionStart's register did not land
    const fx = await fixture("heal-unknown", proxyUrl);
    refuseRegisters = true;
    const life = await register(fx);
    refuseRegisters = false;
    expect(life.registered).toBe(false);
    const state = await readSessionState(fx.home, fx.hostSessionKey);
    await appendTo(fx, fx.hostSessionKey, [
      withSeq(
        targetRecord(life.workContextId, "file", "src/late-register.ts", producerOf(life.crosscheckSessionId), new Date()),
        { epoch: state?.seqEpoch ?? "", n: 3 },
      ),
    ]);

    // Act
    await flushAsHook(fx);

    // Assert: the same id, now on the hub, holding its own records in one order
    expect(await stateId(fx)).toBe(life.crosscheckSessionId);
    expect(await targetsOf(life.workContextId)).toEqual(["src/late-register.ts"]);
    expect(await readSessionCausalOrder(db, life.crosscheckSessionId)).toMatchObject({
      state: "usable",
      epochs: 1,
    });
    expect((await readDropDetail(fx.home, fx.key)).byReason["rejected"] ?? 0).toBe(0);
  });
});

/**
 * THE WORK CONTEXT OF A LIFE THE HUB NEVER REGISTERED (review-2 finding 1).
 * Every later record of that life names it, and the life may still be
 * registered as itself — so a refusal no heal answered spent the one record
 * the life could not do without, and every edit after the heal was refused
 * for a work context the hub never saw.
 */
describe("a life the hub never registered keeps its work context", () => {
  test("a refused flush with no healer leaves it on disk for the heal that registers the life", async () => {
    // Arrange: SessionStart's register did not land
    const fx = await fixture("wc-healless", proxyUrl);
    refuseRegisters = true;
    const life = await register(fx);
    refuseRegisters = false;

    // Act: a flush that carries no healer, then a hook's
    const healless = await flushSpool(
      fx.hub,
      { sessionId: life.crosscheckSessionId, developerId },
      GENEROUS_BUDGET_MS,
    );
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/kept.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await flushAsHook(fx);

    // Assert
    expect(healless.outcome).toBe("failed");
    expect(await stateId(fx)).toBe(life.crosscheckSessionId);
    expect(await targetsOf(life.workContextId)).toEqual(["src/kept.ts"]);
    expect((await readDropDetail(fx.home, fx.key)).byReason["rejected"] ?? 0).toBe(0);
  });

  test("a walk the hub refuses too leaves it on disk, and the walk after the cooldown delivers it", async () => {
    // Arrange: the register and SessionStart's own heal both refused
    const fx = await fixture("wc-failed-walk", proxyUrl);
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    refuseRegisters = true;
    const life = await register(fx);
    await flushAsHook(fx, GENEROUS_BUDGET_MS, now);
    refuseRegisters = false;

    // Act: the hub is back, the cooldown over, and the next edit flushes
    clock.ms += HEAL_COOLDOWN_MS + 1;
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/after-cooldown.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await flushAsHook(fx, GENEROUS_BUDGET_MS, now);

    // Assert
    expect(await stateId(fx)).toBe(life.crosscheckSessionId);
    expect(await targetsOf(life.workContextId)).toEqual(["src/after-cooldown.ts"]);
    expect((await readDropDetail(fx.home, fx.key)).byReason["rejected"] ?? 0).toBe(0);
  });

  test("a heal onto the same id spools it again when another conversation's flush spent it", async () => {
    // Arrange: the unregistered life's work context, delivered by another
    // conversation's live flush and refused there — its session is unknown
    const fx = await fixture("wc-respool", proxyUrl);
    refuseRegisters = true;
    const life = await register(fx);
    refuseRegisters = false;
    await Bun.sleep(SPOOL_ORDER_GAP_MS);
    const otherLife = await register(fx, `${fx.hostSessionKey}-other`);
    await flushSpool(fx.hub, { sessionId: otherLife.crosscheckSessionId, developerId }, GENEROUS_BUDGET_MS);

    // Act: the edit whose flush heals the life as itself, then the next one
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/healing.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await flushAsHook(fx);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/after-heal.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await flushAsHook(fx);

    // Assert: the work context is on the hub again, and the edits after the
    // heal land in it. The healing edit's own re-send ran ahead of the work
    // context the heal spooled behind it, and is counted.
    expect(await stateId(fx)).toBe(life.crosscheckSessionId);
    expect(await raw("select id from work_contexts where id = $1", [life.workContextId])).toEqual([
      { id: life.workContextId },
    ]);
    expect(await targetsOf(life.workContextId)).toEqual(["src/after-heal.ts"]);
    expect((await readDropDetail(fx.home, fx.key)).rejectedCauses).toEqual({ other: 2 });
  });
});

describe("the bounds", () => {
  test("a hub that keeps refusing gets one walk per cooldown, not one per hook", async () => {
    // Arrange: an ended life, and a hub whose register never answers ok
    const fx = await fixture("heal-cooldown", proxyUrl);
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    refuseRegisters = true;
    const start = Date.now();
    const clock = { ms: start };
    const now = () => new Date(clock.ms);
    const before = registerCalls;

    // Act: three hooks inside the cooldown, then one after it
    for (const file of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
      await appendTo(fx, fx.hostSessionKey, [
        targetRecord(life.workContextId, "file", file, producerOf(life.crosscheckSessionId), new Date()),
      ]);
      await flushAsHook(fx, GENEROUS_BUDGET_MS, now);
    }
    const inside = registerCalls - before;
    clock.ms = start + HEAL_COOLDOWN_MS + 1;
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/d.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await flushAsHook(fx, GENEROUS_BUDGET_MS, now);
    refuseRegisters = false;

    // Assert
    expect(inside).toBe(1);
    expect(registerCalls - before).toBe(2);
    expect(await stateId(fx)).toBe(life.crosscheckSessionId);
  });

  test("the walk stays inside the flush's budget against a slow hub", async () => {
    // Arrange
    const fx = await fixture("heal-budget", proxyUrl);
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/slow.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    registerDelayMs = SLOW_REGISTER_MS;

    // Act
    const started = Date.now();
    await flushAsHook(fx, TIGHT_BUDGET_MS);
    const elapsed = Date.now() - started;
    registerDelayMs = 0;

    // Assert: back inside the budget, the refused record counted, no life invented
    expect(elapsed).toBeLessThan(TIGHT_BUDGET_MS + BUDGET_SLACK_MS);
    expect((await readDropDetail(fx.home, fx.key)).rejectedCauses).toEqual({ session_ended: 1 });
    expect(await stateId(fx)).toBe(life.crosscheckSessionId);
  });
});

/**
 * A BATCH A WALK LEAVES ON DISK (review-2 finding 4). What the batch has lost
 * whatever comes next — torn lines, withheld stragglers — is written down
 * before the walk's register, so the next life reports it. A batch that then
 * stayed on disk was written down again by every later walk: one torn line and
 * one straggler read as three of each after three cooldowns, up to the
 * spool's seven-day age, and flowed into the hub's `loss_total`.
 */
describe("a batch a walk leaves on disk", () => {
  test("has its torn and withheld lines counted once, however many walks meet it", async () => {
    // Arrange: an ended life behind another conversation's backlog — a
    // straggler of a refused life, a record of its live one, a torn line —
    // and a hub that refuses every register
    const fx = await fixture("counted-once", proxyUrl);
    const life = await register(fx);
    await flushAsHook(fx);
    const otherHost = `${fx.hostSessionKey}-other`;
    const otherBase = `cc_${otherHost}`;
    const older = new Date(Date.now() - 60_000);
    await recordRefusedLife(fx.home, fx.key, otherBase, new Date());
    await appendRecords(
      fx.home,
      fx.key,
      otherHost,
      [
        targetRecord(`wc_${otherBase}`, "file", "src/withheld.ts", producerOf(otherBase), older),
        targetRecord(`wc_${otherBase}~r1`, "file", "src/other-live.ts", producerOf(`${otherBase}~r1`), older),
      ],
      older,
    );
    await appendFile(spoolDataPath(fx.home, fx.key, sessionSlug(otherHost)), "{torn\n");
    await endOnHub(life.crosscheckSessionId);
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    refuseRegisters = true;

    // Act: three walks the hub refuses, one per cooldown, then one it takes
    for (let walk = 0; walk < 3; walk += 1) {
      await flushAsHook(fx, GENEROUS_BUDGET_MS, now);
      clock.ms += HEAL_COOLDOWN_MS + 1;
    }
    const whileStuck = (await readDropDetail(fx.home, fx.key)).byReason;
    refuseRegisters = false;
    await flushAsHook(fx, GENEROUS_BUDGET_MS, now);

    // Assert: one of each while the batch waited, and none again once it went
    expect(whileStuck).toEqual({ unparsable: 1, withheld: 1 });
    const after = (await readDropDetail(fx.home, fx.key)).byReason;
    expect(after["unparsable"]).toBe(1);
    expect(after["withheld"]).toBe(1);
  });
});

describe("a heartbeat the hub refuses", () => {
  test("walks the same ladder and moves the session to its next life", async () => {
    // Arrange
    const fx = await fixture("heal-heartbeat");
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    const healer = healerFor(fx);

    // Act
    await heartbeatMaybe({
      hub: fx.hub,
      crosscheckSessionId: life.crosscheckSessionId,
      lastHeartbeatAt: null,
      now: new Date(),
      onRefused: (cause) => healer({ sessionId: life.crosscheckSessionId, cause }, Date.now() + GENEROUS_BUDGET_MS),
    });

    // Assert
    expect(await stateId(fx)).toBe(`${life.crosscheckSessionId}~r1`);
    expect(await sessionRow(`${life.crosscheckSessionId}~r1`)).toEqual({ ended: false });
  });
});
