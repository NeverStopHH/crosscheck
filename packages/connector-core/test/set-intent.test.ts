/**
 * `set_intent` against a REAL hub (trial finding #16): the declared intent
 * lands on the caller's OWN work context, replaces a derived one, a
 * re-declaration supersedes, a foreign developer's context is unreachable by
 * construction (the tool never takes an id; the hub's ownership check is the
 * second lock), the argument shape and the contract are explained in words,
 * a session without a registration or with a pre-intent state file gets the
 * remedy, and a hint echo is refused like publish_claim refuses it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";
import { MAX_INTENT_CHAIN_VERSIONS, MAX_INTENT_SUMMARY_CHARS, PROTOCOL_VERSION } from "@crosscheck/schema";

import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { hintBodyHash } from "../src/hints/echo.ts";
import { prepareMcp } from "../src/mcp/context.ts";
import type { McpContext } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { writeIntent } from "../src/mcp/tools/intent-write.ts";
import { NO_SESSION } from "../src/mcp/tools/publish-claim.ts";
import { INTENT_ECHO_REFUSAL, INTENT_SECRET_REFUSAL, NO_TITLE } from "../src/mcp/tools/set-intent.ts";
import { repoKey, sessionSlug } from "../src/config/paths.ts";
import { oweWorkContext, readOwedWorkContext } from "../src/spool/owed-work-context.ts";
import { readRefusedLives } from "../src/spool/refused-lives.ts";
import { readSessionState, writeSessionState } from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "set-intent-admin";
const REPO_ID = "github.com/acme/api";
const TITLE = "detached@0badc0f · fix: refresh 500s @ api";
const HTTP_INTERNAL_ERROR = 500;
/** A request timeout the gateway below outlasts. */
const SHORT_TIMEOUT_MS = 150;
const SLOW_GATEWAY_MS = 600;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const cleanups: string[] = [];

interface Developer {
  readonly developerId: string;
  readonly apiKey: string;
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
  readonly hostSessionKey: string;
  readonly sessionId: string;
  readonly workContextId: string;
  readonly startedAt: string;
}

let alice: Developer;
let bob: Developer;

const post = async (path: string, apiKey: string, body: unknown): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ developerId: string; apiKey: string }> => {
  const response = await post("/api/developers", ADMIN_TOKEN, { name, email });
  const body = (await response.json()) as { data: { developer: { id: string }; apiKey: string } };
  return { developerId: body.data.developer.id, apiKey: body.data.apiKey };
};

const workContextRecordFor = (
  developer: { developerId: string; sessionId: string; workContextId: string; startedAt: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts: developer.startedAt,
  producer: { developerId: developer.developerId, agentKind: "claude-code", sessionId: developer.sessionId },
  kind: "work_context",
  body: {
    id: developer.workContextId,
    sessionId: developer.sessionId,
    title: TITLE,
    status: "analyzing",
    createdAt: developer.startedAt,
    ...extra,
  },
});

/**
 * A developer with a hub session, a work context and the state SessionStart
 * writes (title included), bound to `url` — the hub, or a gateway in front of it.
 */
const setUpDeveloper = async (label: string, name: string, email: string, url: string = hubUrl): Promise<Developer> => {
  const account = await createDeveloper(name, email);
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const hostSessionKey = `${label}-uuid`;
  const sessionId = `cc_${hostSessionKey}`;
  const workContextId = `wc_${sessionId}`;
  const startedAt = new Date().toISOString();
  await post("/api/sessions", account.apiKey, {
    id: sessionId, agentKind: "claude-code", repo: REPO_ID, branch: "detached@0badc0f", baseCommit: "a1b2c3d4", status: "analyzing",
  });
  const developer = { ...account, sessionId, workContextId, startedAt };
  await post("/api/records", account.apiKey, { records: [workContextRecordFor(developer)] });
  await writeSessionState(home, {
    hostSessionKey,
    crosscheckSessionId: sessionId,
    workContextId,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: url,
    developerId: account.developerId,
    startedAt,
    lastHeartbeatAt: startedAt,
    seenTargets: [],
    workContextTitle: TITLE,
    workContextStatus: "analyzing",
    // A LIVE SESSION HAS AN EPOCH. Without one `allocateSeq` refuses, every
    // record here lands unpositioned, and the tests below would only ever
    // exercise the branch where nothing can be ordered — which is the branch
    // the ledger can say least about.
    seqEpoch: crypto.randomUUID(),
    eventSeq: 0,
  });
  return {
    ...developer,
    home,
    repo,
    hostSessionKey,
    env: { CROSSCHECK_HOME: home, CROSSCHECK_HUB_URL: url, CROSSCHECK_API_KEY: account.apiKey },
  };
};

/**
 * A gateway in front of the hub that answers every record post itself — an HTTP status as a failure envelope,
 * or a whole response — or forwards it, running `onRecords` first, while the post is in flight.
 */
const gatewayAnswering = (
  respond: () => number | Response | null,
  onRecords: () => Promise<void> = async () => undefined,
) =>
  Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname, search } = new URL(request.url);
      if (pathname === "/api/records") {
        await onRecords();
      }
      const answer = pathname === "/api/records" ? respond() : null;
      if (typeof answer === "number") {
        return Response.json({ ok: false, error: { code: "gateway", message: "gateway" } }, { status: answer });
      }
      if (answer !== null) {
        return answer;
      }
      return fetch(`${hubUrl}${pathname}${search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" ? undefined : await request.arrayBuffer(),
      });
    },
  });

const contextFor = async (developer: Developer): Promise<McpContext> => {
  const setup = await prepareMcp(developer.env, developer.repo);
  if (!setup.ok) {
    throw new Error(`prepareMcp failed: ${setup.message}`);
  }
  return setup.ctx;
};

const call = async (developer: Developer, args: unknown): Promise<{ text: string; isError: boolean }> => {
  const tool = findTool("set_intent");
  if (tool === undefined) {
    throw new Error("no tool set_intent");
  }
  const result = await tool.run(await contextFor(developer), args);
  return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
};

const storedIntent = async (developer: Developer): Promise<Record<string, unknown> | null> => {
  const response = await fetch(`${hubUrl}/api/work-contexts/${developer.workContextId}/diagnosis`, {
    headers: { Authorization: `Bearer ${developer.apiKey}` },
  });
  const body = (await response.json()) as { data: { workContext: { intent: Record<string, unknown> | null; status: string } } };
  return body.data.workContext.intent;
};

/**
 * THE LEDGER, which is where the checkable half actually lives.
 *
 * `storedIntent` above reads the HEAD, and §8.6 keeps the head to six fields
 * precisely so the amendment reason and the declared scope never ride the
 * unsolicited surfaces that project it whole (presence, search, suspect,
 * hints, ghost-overlap). Asserting those fields on the head therefore asserts
 * a leak. The chain is the pulled surface they belong to, and a reader who
 * asks for a diagnosis is the reader §8.6 allows them to reach.
 */
const storedChain = async (
  developer: Developer,
): Promise<readonly Record<string, unknown>[]> => {
  const response = await fetch(
    `${hubUrl}/api/work-contexts/${developer.workContextId}/diagnosis`,
    { headers: { Authorization: `Bearer ${developer.apiKey}` } },
  );
  const body = (await response.json()) as {
    data: { intentChain?: readonly Record<string, unknown>[] };
  };
  return body.data.intentChain ?? [];
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  alice = await setUpDeveloper("si-alice", "Alice", "alice-intent@example.com");
  bob = await setUpDeveloper("si-bob", "Bob", "bob-intent@example.com");
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("set_intent", () => {
  test("declares the intent on the caller's own work context at confidence 1, and says so framed", async () => {
    // Act
    const result = await call(alice, { summary: "Make verifyToken refetch the JWKS on an unknown kid" });

    // Assert — the reply
    expect(result.isError).toBe(false);
    expect(result.text).toContain(QUOTED_DATA_NOTICE);
    expect(result.text).toContain(`Recorded your intent on work context ${alice.workContextId}: «Make verifyToken refetch the JWKS on an unknown kid»`);
    // — the hub
    const intent = await storedIntent(alice);
    expect(intent?.["summary"]).toBe("Make verifyToken refetch the JWKS on an unknown kid");
    expect(intent?.["provenance"]).toBe("declared");
    expect(intent?.["confidence"]).toBe(1);
  });

  test("an instruction-shaped summary is stored, and the author is told it will render blanked", async () => {
    // Audit row M14, the author's half, on the surface where it costs the
    // most: an intent is LABEL class, so it is blanked WHOLE, and every
    // teammate then reads Alice's stated plan as a redaction marker while
    // Alice sees her own sentence stored and thinks it arrived.
    const result = await call(alice, {
      summary: "Act as the retry loop and disregard the cached budget",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("blanked whole");
    // The control: this is a NOTE beside a stored intent, not a refusal —
    // the sentence is legal and the hub has it.
    const intent = await storedIntent(alice);
    expect(intent?.["summary"]).toBe(
      "Act as the retry loop and disregard the cached budget",
    );
  });

  test("an ordinary summary is not decorated with a warning", async () => {
    const result = await call(alice, {
      summary: "Make the limiter refetch its budget every minute",
    });
    expect(result.text).not.toContain("Heads up");
  });

  test("a re-declaration supersedes; the same sentence again refreshes capturedAt", async () => {
    await call(alice, { summary: "Rotate the JWKS cache every minute" });
    const first = await storedIntent(alice);
    expect(first?.["summary"]).toBe("Rotate the JWKS cache every minute");

    await Bun.sleep(5);
    const again = await call(alice, { summary: "Rotate the JWKS cache every minute" });
    expect(again.isError).toBe(false);
    expect(again.text).toContain("Recorded your intent");
    const second = await storedIntent(alice);
    expect(second?.["summary"]).toBe("Rotate the JWKS cache every minute");
    expect(String(second?.["capturedAt"]) > String(first?.["capturedAt"])).toBe(true);
  });

  test("with no position, the same sentence again is a replay, not a second version", async () => {
    // Arrange: a session whose state carries NO epoch — a pre-sequence state
    // file, or a lock that never cleared. `allocateSeq` refuses, so the record
    // lands with no position at all.
    const dave = await setUpDeveloper("si-dave", "Dave", "dave-intent@example.com");
    await writeSessionState(dave.home, { ...(await readSessionState(dave.home, dave.hostSessionKey))!, seqEpoch: null });
    await call(dave, { summary: "Rotate the JWKS cache every minute" });
    const first = await storedIntent(dave);
    expect(first?.["seq"]).toBeNull();

    // Act
    await Bun.sleep(5);
    await call(dave, { summary: "Rotate the JWKS cache every minute" });

    // Assert: THE HEAD DID NOT MOVE, and that is the conservative direction
    // rather than a regression. With no positions, a sentence sent twice is
    // indistinguishable from a sentence DELIVERED twice — the spool replays
    // on any 5xx — so the id hash (context, author, position, sentence)
    // collides by construction and the hub keeps one version. Refreshing the
    // head's `capturedAt` here would leave `work_contexts.intent` carrying a
    // timestamp no ledger row holds, which is the head/ledger disagreement
    // this table exists to make impossible; `captured_at` orders nothing, so
    // the cost is a display timestamp and the gain is the invariant.
    const second = await storedIntent(dave);
    expect(second).toEqual(first);
  });

  test("the chain's cap is printed, never swallowed", async () => {
    // Arrange: a chain already AT the cap, filled over the record endpoint
    // rather than by twenty MCP calls — the assertion is about the reply.
    const carol = await setUpDeveloper("si-carol", "Carol", "carol-intent@example.com");
    for (let n = 1; n <= MAX_INTENT_CHAIN_VERSIONS; n += 1) {
      await post("/api/records", carol.apiKey, {
        records: [
          workContextRecordFor(carol, {
            intent: { summary: `Sentence ${String(n)}`, provenance: "declared", confidence: 1, capturedAt: carol.startedAt },
          }),
        ],
      });
    }

    // Act
    const result = await call(carol, { summary: "One sentence too many" });

    // Assert: the hub ignored the sentence, so a reply reading "Recorded your
    // intent" would be this tool telling its author a thing that is not true
    // — the silent drop non-negotiable #4 forbids, on the one surface whose
    // whole job is to record the sentence.
    expect(result.text).not.toContain("Recorded your intent");
    expect(result.text).toContain(String(MAX_INTENT_CHAIN_VERSIONS));
    expect((await storedIntent(carol))?.["summary"]).toBe(`Sentence ${String(MAX_INTENT_CHAIN_VERSIONS)}`);
  });

  test("a declared intent replaces a derived one, and a later derived one never overwrites it", async () => {
    // Arrange: Bob's first prompt was derived (the worker's record)
    const derived = { summary: "Find why the refresh call 500s", provenance: "derived", confidence: 0.4, capturedAt: bob.startedAt };
    await post("/api/records", bob.apiKey, { records: [workContextRecordFor(bob, { intent: derived })] });
    expect((await storedIntent(bob))?.["provenance"]).toBe("derived");

    // Act: Bob's agent declares
    await call(bob, { summary: "Make the refresh endpoint refetch the JWKS on an unknown kid" });
    expect((await storedIntent(bob))?.["provenance"]).toBe("declared");

    // A late-flushed derived spool record arrives afterwards
    await post("/api/records", bob.apiKey, { records: [workContextRecordFor(bob, { intent: { ...derived, summary: "A late derived sentence" } })] });

    // Assert: declared stands
    const intent = await storedIntent(bob);
    expect(intent?.["provenance"]).toBe("declared");
    expect(intent?.["summary"]).toBe("Make the refresh endpoint refetch the JWKS on an unknown kid");
  });

  test("an optional status moves the work context's status along with the intent", async () => {
    await call(alice, { summary: "Ship the JWKS refetch behind a flag", status: "implementing" });

    const response = await fetch(`${hubUrl}/api/work-contexts/${alice.workContextId}/diagnosis`, {
      headers: { Authorization: `Bearer ${alice.apiKey}` },
    });
    const body = (await response.json()) as { data: { workContext: { status: string } } };
    expect(body.data.workContext.status).toBe("implementing");
  });

  test("a status the hub accepted is the one SessionEnd compares the state's with (review-2 round 8, L7)", async () => {
    // Act
    await call(alice, { summary: "Ship the JWKS refetch behind a flag, acknowledged", status: "blocked" });

    // Assert
    expect((await readSessionState(alice.home, alice.hostSessionKey))?.workContextAcked).toEqual({
      id: alice.workContextId,
      status: "blocked",
    });
  });

  test("settles the work context a heal still owes for that life, and only that one (review-2 round 7, M1)", async () => {
    // Arrange: a debt for Alice's work context, as a heal leaves it
    const key = repoKey(hubUrl, REPO_ID);
    const slug = sessionSlug(alice.hostSessionKey);
    const owed = (workContextId: string) => ({
      sessionId: alice.sessionId,
      record: workContextRecordFor({ ...alice, workContextId }),
    });
    await oweWorkContext(alice.home, key, slug, owed(alice.workContextId));

    // Act
    await call(alice, { summary: "Settle the owed work context", status: "blocked" });
    const afterOwn = await readOwedWorkContext(alice.home, key, slug);
    await oweWorkContext(alice.home, key, slug, owed(`${alice.workContextId}~other`));
    await call(alice, { summary: "Leave another debt alone", status: "blocked" });

    // Assert
    expect(afterOwn).toBeNull();
    expect((await readOwedWorkContext(alice.home, key, slug))?.sessionId).toBe(alice.sessionId);
  });

  test("a status the hub surely never took is not left in the state, and one it may have taken stays (review-2 round 7)", async () => {
    // Arrange: a developer behind a gateway that refuses every record post with 400, then answers 504
    let answer = 400;
    const gateway = gatewayAnswering(() => answer);
    const erin = await setUpDeveloper("si-gateway", "Erin", "erin-intent@example.com", `http://127.0.0.1:${String(gateway.port)}`);
    const statusOf = async () => (await readSessionState(erin.home, erin.hostSessionKey))?.workContextStatus;

    // Act: refused for sure; then lost on the way back
    const refused = await call(erin, { summary: "Refused at the door", status: "testing" });
    const afterRefused = await statusOf();
    answer = 504;
    const lost = await call(erin, { summary: "Maybe taken", status: "blocked" });
    gateway.stop(true);

    // Assert: both failed at the hub, not at the argument check
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("HTTP 400") });
    expect(lost).toMatchObject({ isError: true, text: expect.stringContaining("HTTP 504") });
    expect(afterRefused).toBe("analyzing");
    expect(await statusOf()).toBe("blocked");
  });

  test("the new status is in the state before its post leaves, for a hook killed after it (review-2 round 7, seed 10)", async () => {
    // Arrange: a gateway that reads the state while the post is in flight
    const statuses: unknown[] = [];
    const gateway = gatewayAnswering(
      () => null,
      async () => {
        statuses.push((await readSessionState(frank.home, frank.hostSessionKey))?.workContextStatus);
      },
    );
    const frank = await setUpDeveloper("si-in-flight", "Frank", "frank-intent@example.com", `http://127.0.0.1:${String(gateway.port)}`);

    // Act
    const result = await call(frank, { summary: "Read while in flight", status: "testing" });
    gateway.stop(true);

    // Assert: what a re-fire or a debt's payment would build from, had the hook died with the post
    expect(result).toMatchObject({ isError: false });
    expect(statuses[0]).toBe("testing");
  });

  test("keeps the new status over a plain HTTP 500: the post may have landed (review-2 round 8, R7-M5)", async () => {
    // Arrange: a gateway that answers every record post with 500
    const gateway = gatewayAnswering(() => HTTP_INTERNAL_ERROR);
    const gina = await setUpDeveloper("si-500", "Gina", "gina-intent@example.com", `http://127.0.0.1:${String(gateway.port)}`);

    // Act
    const result = await call(gina, { summary: "Maybe taken behind a 500", status: "blocked" });
    gateway.stop(true);

    // Assert
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining("HTTP 500") });
    expect((await readSessionState(gina.home, gina.hostSessionKey))?.workContextStatus).toBe("blocked");
  });

  test("puts the old status back when the hub ignores the change (review-2 round 8, R7-M7)", async () => {
    // Arrange: a gateway that answers every record post as the hub does past the amendment cap
    const gateway = gatewayAnswering(() =>
      Response.json({
        ok: true,
        data: {
          accepted: 0,
          duplicates: 0,
          ignored: 1,
          rejected: 0,
          results: [{ index: 0, status: "ignored", issues: ["intent: amendment cap reached"] }],
        },
      }),
    );
    const ivan = await setUpDeveloper("si-ignored", "Ivan", "ivan-intent@example.com", `http://127.0.0.1:${String(gateway.port)}`);

    // Act
    const result = await call(ivan, { summary: "Past the cap", status: "blocked" });
    gateway.stop(true);

    // Assert
    expect(result.isError).toBe(true);
    expect((await readSessionState(ivan.home, ivan.hostSessionKey))?.workContextStatus).toBe("analyzing");
  });

  test("keeps the new status when its post times out after the hub may have taken it (review-2 round 8, R7-M6)", async () => {
    // Arrange: a gateway slower than the request's timeout; the write itself, with that short timeout
    const gateway = gatewayAnswering(
      () => null,
      () => Bun.sleep(SLOW_GATEWAY_MS),
    );
    const url = `http://127.0.0.1:${String(gateway.port)}`;
    const hana = await setUpDeveloper("si-timeout", "Hana", "hana-intent@example.com", url);
    const state = await readSessionState(hana.home, hana.hostSessionKey);
    if (state === null) throw new Error("no session state");
    const key = repoKey(url, REPO_ID);
    const now = () => new Date();

    // Act
    const outcome = await writeIntent(
      {
        home: hana.home,
        repoKey: key,
        hub: { hubUrl: url, apiKey: hana.apiKey, timeoutMs: SHORT_TIMEOUT_MS, home: hana.home, repoKey: key, now },
        now,
        envelope: (producer, body, seq) => ({
          cx: PROTOCOL_VERSION,
          id: `env_${crypto.randomUUID()}`,
          ts: now().toISOString(),
          producer: { developerId: producer.developerId, agentKind: "claude-code", sessionId: producer.sessionId },
          kind: "work_context",
          body,
          seq,
        }),
      },
      { ...state, workContextTitle: TITLE, workContextStatus: "analyzing", sessionAmbiguous: false },
      {
        summary: "Taken after the timeout",
        status: "blocked",
        intent: { summary: "Taken after the timeout", provenance: "declared", confidence: 1, capturedAt: now().toISOString() },
      },
    );
    gateway.stop(true);

    // Assert
    expect(outcome.outcome).toBe("failed");
    expect((await readSessionState(hana.home, hana.hostSessionKey))?.workContextStatus).toBe("blocked");
  });

  test("a life the hub refuses as ended is written down as refused (review-2 round 7)", async () => {
    // Arrange: a developer whose session the hub has ended
    const ended = await setUpDeveloper("si-ended", "Ended", "ended-intent@example.com");
    await post(`/api/sessions/${encodeURIComponent(ended.sessionId)}/end`, ended.apiKey, { status: "done" });

    // Act
    const result = await call(ended, { summary: "Too late for this life" });

    // Assert
    expect(result.isError).toBe(true);
    expect(await readRefusedLives(ended.home, repoKey(hubUrl, REPO_ID), new Date())).toContain(ended.sessionId);
  });

  test("another developer's context is unreachable: Bob's declaration never touches Alice's", async () => {
    const before = await storedIntent(alice);
    await call(bob, { summary: "Bob's own goal, on Bob's own context" });
    expect(await storedIntent(alice)).toEqual(before);
    expect((await storedIntent(bob))?.["summary"]).toBe("Bob's own goal, on Bob's own context");
  });

  test("explains the argument shape: empty, too long, an unknown status", async () => {
    const empty = await call(alice, { summary: "" });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("set_intent was called with arguments it cannot use");

    const long = await call(alice, { summary: "x".repeat(MAX_INTENT_SUMMARY_CHARS + 1) });
    expect(long.isError).toBe(true);
    expect(long.text).toContain(String(MAX_INTENT_SUMMARY_CHARS));

    const status = await call(alice, { summary: "A fine goal for this session", status: "procrastinating" });
    expect(status.isError).toBe(true);
    expect(status.text).toContain("must be one of");
  });

  test("with no registered session the remedy names SessionStart", async () => {
    const home = await makeHome("si-nobody");
    const repo = await makeRepo("si-nobody", { remote: "git@github.com:acme/api.git" });
    cleanups.push(home, repo);
    const nobody: Developer = { ...alice, home, repo, env: { ...alice.env, CROSSCHECK_HOME: home } };

    const result = await call(nobody, { summary: "A goal with nowhere to land" });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(NO_SESSION);
  });

  test("a session registered before intent support gets the restart remedy, never a fabricated title", async () => {
    const home = await makeHome("si-legacy");
    cleanups.push(home);
    await writeSessionState(home, {
      hostSessionKey: "legacy-uuid",
      crosscheckSessionId: "cc_legacy-uuid",
      workContextId: "wc_cc_legacy-uuid",
      repoId: REPO_ID,
      repoRoot: alice.repo,
      hubUrl,
      developerId: alice.developerId,
      startedAt: alice.startedAt,
      lastHeartbeatAt: alice.startedAt,
      seenTargets: [],
    });
    const legacy: Developer = { ...alice, home, env: { ...alice.env, CROSSCHECK_HOME: home } };

    const result = await call(legacy, { summary: "A goal on a pre-intent session" });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(NO_TITLE);
  });

  test("a sentence that arrived as a teammate hint is refused (echo-loop exclusion)", async () => {
    const echoed = "The refresh 500s trace back to the rotated signing key";
    const home = await makeHome("si-echo");
    cleanups.push(home);
    await writeSessionState(home, {
      hostSessionKey: alice.hostSessionKey,
      crosscheckSessionId: alice.sessionId,
      workContextId: alice.workContextId,
      repoId: REPO_ID,
      repoRoot: alice.repo,
      hubUrl,
      developerId: alice.developerId,
      startedAt: alice.startedAt,
      lastHeartbeatAt: alice.startedAt,
      seenTargets: [],
      deliveredHintHashes: [hintBodyHash(echoed)],
      workContextTitle: TITLE,
      workContextStatus: "analyzing",
    });
    const echoing: Developer = { ...alice, home, env: { ...alice.env, CROSSCHECK_HOME: home } };

    const result = await call(echoing, { summary: echoed });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(INTENT_ECHO_REFUSAL);
  });

  /**
   * A declared intent is the ONE piece of agent-written text this system
   * pushes into every teammate's briefing unasked — a claim body is a
   * pointer until somebody pulls it. The derived path already drops a
   * secret-like sentence (intent/worker.ts DROPPED_SECRET), so without this
   * gate `set_intent` is the only way credential-shaped text reaches another
   * developer's context. Drop, never redact (DESIGN.md §3).
   */
  test("a summary carrying credential-shaped text is refused, and nothing reaches the hub", async () => {
    // Arrange: a synthetic AWS-shaped id, built rather than typed
    const fake = `AKIA${"Q7RSTUVWXYZ234567".slice(0, 16)}`;
    const before = await storedIntent(alice);

    // Act
    const result = await call(alice, { summary: `Rotate the leaked key ${fake} out of the limiter` });

    // Assert: the refusal names the rule, and the stored intent is untouched
    expect(result.isError).toBe(true);
    expect(result.text).toBe(INTENT_SECRET_REFUSAL);
    expect(result.text).not.toContain(fake);
    expect(await storedIntent(alice)).toEqual(before);
  });
});

describe("the checkable half reaches the wire", () => {
  test("a declared surface, a non-goal and a reason all land", async () => {
    // THEY HAD NO WRITER. Spec 06 makes the declared paths the field an edit
    // is compared against — `explanationTimingFor` answers from them and from
    // nothing else — and this tool could not send one, so every production
    // row stored a sentence with an empty scope and `intent_scope` was
    // written by nothing at all. The ledger existed and the checkable half
    // was unreachable from the one writer agents have.
    const first = await call(alice, {
      summary: "Rewrite the provider matcher",
      expectedSurface: ["packages/a.ts"],
    });
    expect(first.isError).toBe(false);

    const amended = await call(alice, {
      summary: "Rewrite the provider matcher and its fixture",
      expectedSurface: ["packages/a.ts", "packages/fixture.ts"],
      nonGoals: ["packages/b.ts"],
      reason: "The fixture hid the gap.",
    });
    expect(amended.isError).toBe(false);

    // THE LEDGER CARRIES THEM, and that is the whole contract: the reason and
    // both scope lists reached the hub and are readable by somebody who asked
    // for a diagnosis.
    const chain = await storedChain(alice);
    const head = chain[0];
    expect(head?.["reason"]).toBe("The fixture hid the gap.");
    expect(head?.["scope"]).toEqual([
      { role: "expected", kind: "file", value: "packages/a.ts" },
      { role: "expected", kind: "file", value: "packages/fixture.ts" },
      { role: "non_goal", kind: "file", value: "packages/b.ts" },
    ]);

    // AND THE HEAD DOES NOT — §8.6, checked here rather than assumed. This
    // assertion used to read the other way round, and it passed only because
    // `record-handlers.ts` had two writers of `work_contexts.intent` and the
    // one that runs when `set_intent` beats the spool stored the whole wire.
    // A test that reads the reason off the head is a test that requires the
    // leak, so it would have kept the defect alive through any later fix.
    const intent = await storedIntent(alice);
    expect(intent?.["summary"]).toBe(
      "Rewrite the provider matcher and its fixture",
    );
    expect(intent?.["reason"]).toBeUndefined();
    expect(intent?.["expectedSurface"]).toBeUndefined();
    expect(intent?.["nonGoals"]).toBeUndefined();
  });

  test("an unscoped call still lands, unchanged", async () => {
    // Back-compat, and the control: the three fields are optional, so a v0
    // caller that knows none of them behaves exactly as before.
    const result = await call(bob, { summary: "Look at the refresh path" });
    expect(result.isError).toBe(false);
    const intent = await storedIntent(bob);
    expect(intent?.["summary"]).toBe("Look at the refresh path");
    expect(intent?.["expectedSurface"]).toBeUndefined();
    expect(intent?.["nonGoals"]).toBeUndefined();
  });

  test("a credential in a declared path is refused before the hub sees it", async () => {
    // The hub screens these fields too (record-handlers.ts), but the tool is
    // where a refusal can still tell the AUTHOR — a hub rejection reaches the
    // spool, not the person.
    const result = await call(alice, {
      summary: "Rotate the key",
      expectedSurface: ["packages/ghp_0123456789abcdefghijklmnopqrstuvwxyzAB.ts"],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("secret pattern");
  });
});
