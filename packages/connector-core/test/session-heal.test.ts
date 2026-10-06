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

import { HEAL_COOLDOWN_MS, MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "../src/constants.ts";
import { repoKey, sessionSlug, sessionStatePath, spoolDataPath } from "../src/config/paths.ts";
import { commitEvidenceRecord } from "../src/capture/commit-evidence.ts";
import { targetRecord, workContextRecord } from "../src/capture/records.ts";
import type { Producer } from "../src/capture/records.ts";
import { withSeq } from "../src/capture/seq.ts";
import type { HubContext } from "../src/http/client.ts";
import { endSessionFlow } from "../src/flows/end-session.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { sessionHealer } from "../src/flows/heal-session.ts";
import { heartbeatMaybe } from "../src/flows/heartbeat.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { appendRecords } from "../src/spool/append.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { lineEnds, writeCountedLines, writeCursorOffset } from "../src/spool/cursor.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import { flushSpool } from "../src/spool/flush.ts";
import type { SessionHealer } from "../src/spool/flush.ts";
import { recordRefusedLife } from "../src/spool/refused-lives.ts";
import { readSessionState, updateSessionState } from "../src/state/session-state.ts";
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
/** Record deliveries the proxy forwarded. */
let recordPosts = 0;
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
      if (request.method === "POST" && pathname === "/api/records") {
        recordPosts += 1;
      }
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
    // producer-filed commit_evidence), then an ended session's backlog
    const fx = await fixture("heal-resend");
    const life = await register(fx);
    const otherHost = `${fx.hostSessionKey}-other`;
    const otherLife = await register(fx, otherHost);
    await flushSpool(fx.hub, { sessionId: otherLife.crosscheckSessionId, developerId }, GENEROUS_BUDGET_MS);
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
    await rm(sessionStatePath(fx.home, otherHost), { force: true });

    // Act
    await flushAsHook(fx);

    // Assert: the producer-filed record went under the next life, unpositioned
    const next = `${life.crosscheckSessionId}~r1`;
    const observed = await raw(
      "select seq_n, seq_reason from session_events where session_id = $1 and kind = 'commit.observed'",
      [next],
    );
    expect(observed).toEqual([{ seq_n: null, seq_reason: "foreign_session_delivery" }]);
    // ...the ended session's backlog landed where its body names, as any successor flush delivers it
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

  test("a life the hub said ended is withheld from a successor even when no heal moved past it (review-2 round 7)", async () => {
    // Arrange: the hub ends the life and refuses every register, so the walk lands nothing
    const fx = await fixture("ended-no-heal", proxyUrl);
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    refuseRegisters = true;
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/refused.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await flushAsHook(fx);
    refuseRegisters = false;
    // ...one more edit of the life lands on disk, and the conversation is gone
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/straggler.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await rm(sessionStatePath(fx.home, fx.hostSessionKey), { force: true });

    // Act: another conversation's flush
    const other = await register(fx, `${fx.hostSessionKey}-other`);
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, GENEROUS_BUDGET_MS);

    // Assert: never filed into the ended life; counted for what it is
    expect(await targetsOf(life.workContextId)).toEqual([]);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({ rejected: 1, withheld: 1 });
  });

  test("a SessionEnd whose flush the hub refuses as ended withholds the life's stragglers from a successor (review-2 round 7, seed 500)", async () => {
    // Arrange: a sibling ended the life on the hub; an edit of it waits on disk
    const fx = await fixture("end-refused-ended", proxyUrl);
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/refused.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);

    // Act: SessionEnd — its flush has no healer — then a racing hook's edit, then another conversation's flush
    await endSessionFlow({
      home: fx.home,
      repoKey: fx.key,
      hub: fx.hub,
      hostSessionKey: fx.hostSessionKey,
      crosscheckSessionId: life.crosscheckSessionId,
      developerId,
      flushBudgetMs: GENEROUS_BUDGET_MS,
      now: () => new Date(),
    });
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/straggler.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    const other = await register(fx, `${fx.hostSessionKey}-other`);
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, GENEROUS_BUDGET_MS);

    // Assert: never filed into the ended life; counted for what it is
    expect(await targetsOf(life.workContextId)).toEqual([]);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({ rejected: 1, withheld: 1 });
  });

  test("a heartbeat the hub refuses as ended marks the life refused too, a failed walk or not (review-2 round 7)", async () => {
    // Arrange: the hub ends the life and refuses every register
    const fx = await fixture("beat-ended", proxyUrl);
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    refuseRegisters = true;

    // Act: the beat's 409 asks the healer, whose walk lands nothing; then the
    // conversation is gone with an edit of the life on disk, and another flushes
    await heartbeatMaybe({
      hub: fx.hub,
      crosscheckSessionId: life.crosscheckSessionId,
      lastHeartbeatAt: null,
      now: new Date(),
      onRefused: (cause) =>
        healerFor(fx)({ sessionId: life.crosscheckSessionId, cause }, Date.now() + GENEROUS_BUDGET_MS),
    });
    refuseRegisters = false;
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/after-beat.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await rm(sessionStatePath(fx.home, fx.hostSessionKey), { force: true });
    const other = await register(fx, `${fx.hostSessionKey}-other`);
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, GENEROUS_BUDGET_MS);

    // Assert
    expect(await targetsOf(life.workContextId)).toEqual([]);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({ withheld: 1 });
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

  test("a heal re-sends the life's work context at the head of the batch, even one an older connector spent", async () => {
    // Arrange: the unregistered life's work context, spent by a successor
    // flush from before this hold (the cursor moved past it, nothing sent)
    const fx = await fixture("wc-head", proxyUrl);
    refuseRegisters = true;
    const life = await register(fx);
    refuseRegisters = false;
    const spool = await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey));
    await writeCursorOffset(spool.dataPath, spool.cursorPath, spool.size, spool);

    // Act: the edit whose flush heals the life as itself, then the next one
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/healing.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await flushAsHook(fx);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/after-heal.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await flushAsHook(fx);

    // Assert: the healing edit landed too — its work context went ahead of it
    expect(await stateId(fx)).toBe(life.crosscheckSessionId);
    expect(await targetsOf(life.workContextId)).toEqual(["src/after-heal.ts", "src/healing.ts"]);
    expect((await readDropDetail(fx.home, fx.key)).byReason["rejected"] ?? 0).toBe(0);
  });

  test("a heal onto the same id clears the seen-set, so files whose records were lost are captured again", async () => {
    // Arrange: an unregistered life that has seen a file
    const fx = await fixture("seen-reset", proxyUrl);
    refuseRegisters = true;
    const life = await register(fx);
    refuseRegisters = false;
    await updateSessionState(fx.home, fx.hostSessionKey, (fresh) => ({ ...fresh, seenTargets: ["src/seen.ts"] }));

    // Act
    await flushAsHook(fx);

    // Assert
    const state = await readSessionState(fx.home, fx.hostSessionKey);
    expect(state?.crosscheckSessionId).toBe(life.crosscheckSessionId);
    expect(state?.seenTargets).toEqual([]);
  });
});

/**
 * ANOTHER LOCAL LIFE THE HUB HAS NOT REGISTERED YET (review-2 MEDIUM-1). A
 * live conversation's flush drained the whole repo spool, and delivered such a
 * life's records under its own name: the hub refused the work context
 * ("session not found") and every target of it ("work context not found"),
 * and they were spent — before that life's own heal could register it. A
 * flush now sends no other live conversation's records (spool/ownership.ts).
 */
describe("a successor flush beside a live life the hub has not registered", () => {
  test("leaves that life's records on disk and delivers its own, and the life's heal delivers them", async () => {
    // Arrange: life D unregistered, with an edit; a registered conversation O
    const fx = await fixture("held-life", proxyUrl);
    refuseRegisters = true;
    const deaf = await register(fx);
    refuseRegisters = false;
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(deaf.workContextId, "file", "src/deaf.ts", producerOf(deaf.crosscheckSessionId), new Date()),
    ]);
    await Bun.sleep(SPOOL_ORDER_GAP_MS);
    const otherHost = `${fx.hostSessionKey}-other`;
    const other = await register(fx, otherHost);
    await appendTo(fx, otherHost, [
      targetRecord(other.workContextId, "file", "src/other.ts", producerOf(other.crosscheckSessionId), new Date()),
    ]);

    // Act: O's flush, then D's own
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, GENEROUS_BUDGET_MS);
    const held = (await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey))).lines.length;
    const dropsBetween = (await readDropDetail(fx.home, fx.key)).byReason;
    await flushAsHook(fx);

    // Assert
    expect(await targetsOf(other.workContextId)).toEqual(["src/other.ts"]);
    expect(held).toBe(2);
    expect(dropsBetween).toEqual({});
    expect(await targetsOf(deaf.workContextId)).toEqual(["src/deaf.ts"]);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
  });

  test("holds them only while the life is live: after its end they are delivered and every refusal counted", async () => {
    // Arrange: life D unregistered with an edit, then ended; a registered conversation O
    const fx = await fixture("held-until-end", proxyUrl);
    refuseRegisters = true;
    const deaf = await register(fx);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(deaf.workContextId, "file", "src/deaf.ts", producerOf(deaf.crosscheckSessionId), new Date()),
    ]);
    await endSessionFlow({
      home: fx.home,
      repoKey: fx.key,
      hub: fx.hub,
      hostSessionKey: fx.hostSessionKey,
      crosscheckSessionId: deaf.crosscheckSessionId,
      developerId,
      flushBudgetMs: GENEROUS_BUDGET_MS,
      now: () => new Date(),
    });
    refuseRegisters = false;
    const otherHost = `${fx.hostSessionKey}-other`;
    const other = await register(fx, otherHost);

    // Act
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, GENEROUS_BUDGET_MS);

    // Assert: nothing left behind, nothing silent, and named for what it is
    expect((await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey))).lines.length).toBe(0);
    const drops = await readDropDetail(fx.home, fx.key);
    expect(drops.byReason).toEqual({ rejected: 2 });
    expect(drops.rejectedCauses).toEqual({ author_unknown: 2 });
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

  test("a heal asked inside a failed walk's cooldown walks nothing, whoever asks — a heartbeat too", async () => {
    // Arrange: a walk the hub refused
    const fx = await fixture("cooldown-beat", proxyUrl);
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    refuseRegisters = true;
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/a.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await flushAsHook(fx);
    const before = registerCalls;

    // Act: the heartbeat the hub refuses as ended asks the healer, inside the cooldown
    await heartbeatMaybe({
      hub: fx.hub,
      crosscheckSessionId: life.crosscheckSessionId,
      lastHeartbeatAt: null,
      now: new Date(),
      onRefused: (cause) =>
        healerFor(fx)({ sessionId: life.crosscheckSessionId, cause }, Date.now() + GENEROUS_BUDGET_MS),
    });
    refuseRegisters = false;

    // Assert
    expect(registerCalls - before).toBe(0);
  });

  test("a flush inside a failed walk's cooldown says it failed, with its records still pending (F7)", async () => {
    // Arrange: a life whose register and SessionStart walk the hub refused
    const fx = await fixture("cooldown-outcome", proxyUrl);
    refuseRegisters = true;
    const life = await register(fx);
    await flushAsHook(fx);
    refuseRegisters = false;

    // Act: the next hook's flush, inside the cooldown
    const outcome = await flushSpool(
      fx.hub,
      { sessionId: life.crosscheckSessionId, developerId, heal: healerFor(fx) },
      GENEROUS_BUDGET_MS,
    );

    // Assert: never `empty` — a caller deferring an end must see the records
    expect(outcome).toEqual({ outcome: "failed", remaining: 1 });
  });

  test("a hook inside a failed walk's cooldown sends nothing the hub would refuse again (review-2 LOW-5)", async () => {
    // Arrange: a life whose register and SessionStart walk the hub refused
    const fx = await fixture("cooldown-silent", proxyUrl);
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    refuseRegisters = true;
    const life = await register(fx);
    await flushAsHook(fx, GENEROUS_BUDGET_MS, now);
    refuseRegisters = false;
    const before = recordPosts;

    // Act: three hooks inside the cooldown, then one after it
    for (const file of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
      await appendTo(fx, fx.hostSessionKey, [
        targetRecord(life.workContextId, "file", file, producerOf(life.crosscheckSessionId), new Date()),
      ]);
      await flushAsHook(fx, GENEROUS_BUDGET_MS, now);
    }
    const inside = recordPosts - before;
    clock.ms += HEAL_COOLDOWN_MS + 1;
    await flushAsHook(fx, GENEROUS_BUDGET_MS, now);

    // Assert: no batch pinned and re-sent per hook; everything lands after
    expect(inside).toBe(0);
    expect(await targetsOf(life.workContextId)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
  });

  test("a register that lands clears the failed walk's verdict, and the next flush sends (RS5-D)", async () => {
    // Arrange: a walk the hub refused, then a SessionStart re-fire whose register lands
    const fx = await fixture("verdict-cleared", proxyUrl);
    refuseRegisters = true;
    const life = await register(fx);
    await flushAsHook(fx);
    refuseRegisters = false;
    const again = await register(fx);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/after-refire.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    const before = recordPosts;

    // Act: the next hook, well inside the failed walk's cooldown
    await flushAsHook(fx);

    // Assert
    expect(again.crosscheckSessionId).toBe(life.crosscheckSessionId);
    expect(recordPosts - before).toBeGreaterThan(0);
    expect(await targetsOf(life.workContextId)).toEqual(["src/after-refire.ts"]);
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

  test("with a single torn line, has it counted once too (B1)", async () => {
    // Arrange: an ended life behind another conversation's backlog — one
    // record of its unregistered next life, one torn line
    const fx = await fixture("one-torn", proxyUrl);
    const life = await register(fx);
    await flushAsHook(fx);
    const otherHost = `${fx.hostSessionKey}-other`;
    const otherBase = `cc_${otherHost}`;
    const older = new Date(Date.now() - 60_000);
    await appendRecords(
      fx.home,
      fx.key,
      otherHost,
      [targetRecord(`wc_${otherBase}~r1`, "file", "src/other-live.ts", producerOf(`${otherBase}~r1`), older)],
      older,
    );
    await appendFile(spoolDataPath(fx.home, fx.key, sessionSlug(otherHost)), "{torn\n");
    await endOnHub(life.crosscheckSessionId);
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    refuseRegisters = true;

    // Act: three walks the hub refuses, one per cooldown
    for (let walk = 0; walk < 3; walk += 1) {
      await flushAsHook(fx, GENEROUS_BUDGET_MS, now);
      clock.ms += HEAL_COOLDOWN_MS + 1;
    }
    refuseRegisters = false;

    // Assert
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({ unparsable: 1 });
  });

  test("a torn line ahead of a life's records rides in that life's batch: counted, and the records go (review-2 round 7)", async () => {
    // Arrange: an ended conversation's spool that starts with a torn line
    const fx = await fixture("torn-first", proxyUrl);
    await register(fx);
    await flushAsHook(fx);
    const otherHost = `${fx.hostSessionKey}-other`;
    const other = await register(fx, otherHost);
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, GENEROUS_BUDGET_MS);
    await appendFile(spoolDataPath(fx.home, fx.key, sessionSlug(otherHost)), "{torn\n");
    await appendTo(fx, otherHost, [
      targetRecord(other.workContextId, "file", "src/behind-torn.ts", producerOf(other.crosscheckSessionId), new Date()),
    ]);
    await rm(sessionStatePath(fx.home, otherHost), { force: true });

    // Act
    await flushAsHook(fx);

    // Assert
    expect(await targetsOf(other.workContextId)).toEqual(["src/behind-torn.ts"]);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({ unparsable: 1 });
  });
});

/** THE EDGES OF A HEAL'S RE-SEND (review-2 round 6, MEDIUM-2). */
describe("a heal's re-send with the owed work context ahead of it", () => {
  test("reads the hub's answers for the batch past the one for the work context (A1)", async () => {
    // Arrange: an unregistered life whose spooled work context was spent;
    // an edit, and last an edit naming a work context that exists nowhere —
    // both refused for the unknown life, only the second for itself after the heal
    const fx = await fixture("ahead-answers", proxyUrl);
    refuseRegisters = true;
    const life = await register(fx);
    refuseRegisters = false;
    const spool = await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey));
    await writeCursorOffset(spool.dataPath, spool.cursorPath, spool.size, spool);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/edit.ts", producerOf(life.crosscheckSessionId), new Date()),
      targetRecord("wc_nowhere", "file", "src/nowhere.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);

    // Act: the flush whose walk heals and re-sends both, the work context ahead
    await flushAsHook(fx);

    // Assert: the edit landed, and the last record's refusal is the one booked
    expect(await targetsOf(life.workContextId)).toEqual(["src/edit.ts"]);
    const drops = await readDropDetail(fx.home, fx.key);
    expect(drops.byReason).toEqual({ rejected: 1 });
    expect(drops.rejectedCauses).toEqual({ author_unknown: 1 });
  });
});

/**
 * A HOOK KILLED MID-WALK (review-2 LOW-3). The walk's losses reach the ledger
 * in `beforeWalk`, and the note that says so was written only once the heal
 * came back: a hook that died in between left the counts with nothing to say
 * they were counted, and the next flush wrote them again.
 */
describe("a flush whose hook dies inside the walk", () => {
  test("leaves the next flush nothing to count again", async () => {
    // Arrange: an ended life with a refused edit and a torn line on disk
    const fx = await fixture("dies-mid-walk");
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/after-end.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await appendFile(spoolDataPath(fx.home, fx.key, sessionSlug(fx.hostSessionKey)), "{torn\n");
    const dying: SessionHealer = async (_refusal, _deadlineMs, beforeWalk) => {
      await beforeWalk?.();
      throw new Error("killed mid-walk");
    };

    // Act: the hook that dies after the ledger write, then the next hook's flush
    await flushSpool(fx.hub, { sessionId: life.crosscheckSessionId, developerId, heal: dying }, GENEROUS_BUDGET_MS).catch(
      () => undefined,
    );
    const afterCrash = await readDropDetail(fx.home, fx.key);
    await flushAsHook(fx);
    const after = await readDropDetail(fx.home, fx.key);

    // Assert
    expect(afterCrash.byReason).toEqual({ unparsable: 1, rejected: 1 });
    expect(after.byReason).toEqual(afterCrash.byReason);
    expect(after.rejectedCauses).toEqual({ session_ended: 1 });
  });
});

/**
 * THE EDGES OF WHAT A REFUSED FLUSH KEEPS (review-2 LOW-6). Each test below
 * pins one guard a reviewer's mutation removed without a test noticing.
 */
describe("what a refused flush keeps on disk, and what it spends", () => {
  /** A heal-less flush, as SessionEnd's drain makes it. */
  const flushWithoutHealer = (fx: Fixture, sessionId: string) =>
    flushSpool(fx.hub, { sessionId, developerId }, GENEROUS_BUDGET_MS);

  /** Moves the cursor past everything on disk, as a delivered batch would. */
  const consumeAll = async (fx: Fixture): Promise<void> => {
    const spool = await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey));
    await writeCursorOffset(spool.dataPath, spool.cursorPath, spool.size, spool);
  };

  const workContextOf = (sessionId: string) =>
    workContextRecord(
      { workContextId: `wc_${sessionId}`, sessionId, title: "t", status: "analyzing" },
      producerOf(sessionId),
      new Date(),
    );

  test("another life's work context is not held for the flusher's heal (M1)", async () => {
    // Arrange: an unregistered life, its own work context gone ahead; another
    // life of the same conversation's work context on disk
    const fx = await fixture("keep-writer", proxyUrl);
    refuseRegisters = true;
    const life = await register(fx);
    refuseRegisters = false;
    await consumeAll(fx);
    await appendTo(fx, fx.hostSessionKey, [workContextOf(`${life.crosscheckSessionId}~r9`)]);

    // Act
    const outcome = await flushWithoutHealer(fx, life.crosscheckSessionId);

    // Assert: refused for the flusher, spent and counted — not pinned
    expect(outcome.outcome).toBe("flushed");
    expect((await readDropDetail(fx.home, fx.key)).rejectedCauses).toEqual({ session_unknown: 1 });
  });

  test("an ended life's own work context is not held either: that life is never registered again (M2)", async () => {
    // Arrange: a life registered, its work context still on disk, then ended
    const fx = await fixture("keep-cause");
    const life = await register(fx);
    await endOnHub(life.crosscheckSessionId);

    // Act
    const outcome = await flushWithoutHealer(fx, life.crosscheckSessionId);

    // Assert
    expect(outcome.outcome).toBe("flushed");
    expect((await readDropDetail(fx.home, fx.key)).rejectedCauses).toEqual({ session_ended: 1 });
  });

  test("an unregistered life's other records are not held — only its work context is (M12)", async () => {
    // Arrange: an unregistered life whose work context went ahead, an edit of it on disk
    const fx = await fixture("keep-kind", proxyUrl);
    refuseRegisters = true;
    const life = await register(fx);
    refuseRegisters = false;
    await consumeAll(fx);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/edit.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);

    // Act
    const outcome = await flushWithoutHealer(fx, life.crosscheckSessionId);

    // Assert
    expect(outcome.outcome).toBe("flushed");
    expect((await readDropDetail(fx.home, fx.key)).rejectedCauses).toEqual({ session_unknown: 1 });
  });

  test("a refusal an earlier walk wrote down is not counted again when the batch goes (M5)", async () => {
    // Arrange: an ended life's edit on disk, already written down by a walk
    // that left the batch where it was
    const fx = await fixture("noted-refusal");
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/noted.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    const spool = await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey));
    const end = lineEnds(spool.pending, 1, spool.offset)[0] ?? spool.size;
    await writeCountedLines(spool.dataPath, spool.cursorPath, spool.offset, new Set([end]), spool);

    // Act
    const outcome = await flushWithoutHealer(fx, life.crosscheckSessionId);

    // Assert: the batch went, and nothing new reached the ledger
    expect(outcome.outcome).toBe("flushed");
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({});
  });

  test("a flush whose walk heals and delivers counts the batch's losses once (M14)", async () => {
    // Arrange: an ended life; its refused edit and a torn line on disk
    const fx = await fixture("losses-once");
    const life = await register(fx);
    await flushAsHook(fx);
    await endOnHub(life.crosscheckSessionId);
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/after-end.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await appendFile(spoolDataPath(fx.home, fx.key, sessionSlug(fx.hostSessionKey)), "{torn\n");

    // Act: one flush — the walk heals, the batch goes
    await flushAsHook(fx);

    // Assert
    expect(await stateId(fx)).toBe(`${life.crosscheckSessionId}~r1`);
    expect((await readDropDetail(fx.home, fx.key)).byReason).toEqual({ unparsable: 1, rejected: 1 });
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

  test("registers a life the hub never heard of as itself, and spools its work context again", async () => {
    // Arrange: an unregistered life whose work context an older connector's
    // flush spent — the cursor past it, nothing sent
    const fx = await fixture("heal-heartbeat-unknown", proxyUrl);
    refuseRegisters = true;
    const life = await register(fx);
    refuseRegisters = false;
    const spool = await readSessionSpool(fx.home, fx.key, sessionSlug(fx.hostSessionKey));
    await writeCursorOffset(spool.dataPath, spool.cursorPath, spool.size, spool);
    const healer = healerFor(fx);

    // Act: the beat the hub answers 404, then the next edit's flush
    await heartbeatMaybe({
      hub: fx.hub,
      crosscheckSessionId: life.crosscheckSessionId,
      lastHeartbeatAt: null,
      now: new Date(),
      onRefused: (cause) => healer({ sessionId: life.crosscheckSessionId, cause }, Date.now() + GENEROUS_BUDGET_MS),
    });
    await appendTo(fx, fx.hostSessionKey, [
      targetRecord(life.workContextId, "file", "src/after-beat.ts", producerOf(life.crosscheckSessionId), new Date()),
    ]);
    await flushAsHook(fx);

    // Assert
    expect(await sessionRow(life.crosscheckSessionId)).toEqual({ ended: false });
    expect(await targetsOf(life.workContextId)).toEqual(["src/after-beat.ts"]);
  });
});
