/**
 * INT-11 — THE BUDGET IS MEASURED, NOT ASSERTED.
 *
 * §6 claims two things about `set_intent` after this spec: that it adds NO new
 * hub round trip, and that the `seq` reservation it gained costs a bounded
 * amount of lock time. Both were prose. Every sibling spec discharges the same
 * obligation with a numbered test (CCB-8, COV-8, VER-8, PIL-9, EV-8); INT-5 was
 * pointed at here by mistake and measures nothing at all.
 *
 * THE LOAD-BEARING HALF IS A COUNT, NOT A CLOCK. `capture-latency.test.ts`
 * learned this the expensive way: an assertion that a warm path is no slower
 * than a cold one still passed with the cache switched off, because a broken
 * cache makes warm resemble cold rather than exceed it. A wall clock cannot see
 * a round trip that was added; a request counter can, on every machine, under
 * any load. So the "no new HTTP call" claim is asserted as the NUMBER of
 * requests the hub serves during one `set_intent`, and the milliseconds below
 * it are measurements that print, bounded by budgets rather than by each other.
 *
 * AND THE COUNT HAS A REACH, WHICH THIS SAYS OUT LOUD RATHER THAN IMPLYING.
 * The counter runs across the tool call and for DEFERRED_SETTLE_MS after it
 * returns, so a debounced or batched post is caught as well as a synchronous
 * one. What it cannot see is a round trip booked onto a LATER HOOK — the shape
 * `set_intent` already uses for the ghost check's model half, which it hands to
 * the next UserPromptSubmit. No in-process counter can see that, and a test
 * that quietly did not would be making the same over-claim this file exists to
 * criticise. The first version of this test read the counter the instant the
 * tool returned, measured ~50 ms of window, and said "a counter can, on every
 * machine, under any load" anyway; an adversary reading this branch caught it.
 *
 * THE RESERVATION IS TIMED ON ITS OWN. An end-to-end delta between two
 * `set_intent` calls is dominated by the hub round trips either way, so a
 * regression in the lock would hide inside the noise. `allocateSeq` is timed
 * directly instead: it is the whole of what this spec added to the tool.
 *
 * THE HOOK HALF IS NOT DUPLICATED HERE. §6 also claims the 800 ms hook pair is
 * untouched, and `connector-claude/test/hook-time-budget.test.ts` already drives
 * SessionStart, SessionEnd and PostToolUse through the real binary against
 * ceilings derived from their own ratio constants. A second copy of that
 * measurement in this file would be a second thing to keep in step, and the
 * copy is exactly where a hook would go quietly unmeasured. What this spec owes
 * beyond it is the structural claim that nothing REACHES a hook path at all,
 * and INT-7 proves that one by walking every module rather than by timing it.
 *
 * THE CONTENDED CEILING IS DERIVED, NOT QUOTED. §6 was written when the state
 * lock retried 5 times and said "~100 ms"; #53 raised
 * SESSION_STATE_LOCK_RETRIES to 20 to stop losing positions under contention,
 * which moved the worst case to 400 ms without moving the sentence. The ceiling
 * here is computed from the two constants, so the next change to either is
 * carried into this bound by arithmetic rather than by somebody remembering.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { MAX_INTENT_CHAIN_VERSIONS } from "@crosscheck/schema";

import {
  MCP_TIMEOUT_MS,
  SESSION_STATE_LOCK_RETRIES,
  SPOOL_LOCK_RETRY_DELAY_MS,
} from "../src/constants.ts";
import { prepareMcp } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { allocateSeq, writeSessionState } from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "intent-budget-admin";
const REPO_ID = "github.com/acme/api";
const TITLE = "detached@0badc0f · fix: refresh 500s @ api";

/**
 * The epoch is a UUID by schema (`SeqStampSchema`), not a readable label: a
 * fixture spelling it `ep_…` is refused by the hub, which is how this test
 * found out. Fixed here so the shape is the production shape.
 */
const SEQ_EPOCH = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

/**
 * The requests one `set_intent` makes: the `POST /api/records` carrying the
 * work-context UPDATE, and the bounded ghost-overlap `GET`. This spec adds
 * NEITHER — the intent still travels on the existing record — and that is what
 * this number is here to keep true. A third request appearing is the defect;
 * the count going DOWN is also a defect, and also caught, because a dropped
 * ghost check would be a silent loss of the overlap notice.
 */
const SET_INTENT_HUB_REQUESTS = 2;

/** Worst case the state lock can cost a single acquisition, from §6's own two constants. */
const LOCK_CEILING_MS = SESSION_STATE_LOCK_RETRIES * SPOOL_LOCK_RETRY_DELAY_MS;

/**
 * THE CALLS THIS FILE MAKES BEFORE THE SAMPLING LOOP: one warm-up and one
 * counted call, both in the first test, both on this same work context.
 */
const SET_INTENT_CALLS_BEFORE_SAMPLING = 2;

/**
 * How long the request counter keeps running after the tool has returned.
 *
 * Long enough to catch a flush debounced by a few hundred milliseconds — the
 * shape this path would most plausibly grow, since `set_intent` already books
 * the ghost check's model half for a later turn. It is NOT long enough to
 * catch work booked onto a later HOOK, and no in-process counter can be; that
 * limit is stated in the file header rather than hidden behind a number.
 */
const DEFERRED_SETTLE_MS = 750;

/**
 * Enough samples for a p95 to mean something, DERIVED FROM THE CAP rather than
 * chosen.
 *
 * Every call in this file amends the SAME work context, and §10.1 caps a
 * chain at MAX_INTENT_CHAIN_VERSIONS: past it the hub returns `ignored`, the
 * head stays put and `set_intent` reports the refusal — correctly. A fixed 20
 * here walked straight into that and the timing test failed on an outcome, not
 * on a clock. The bound is arithmetic now, so raising the cap widens the
 * sample and lowering it below the reserved calls fails loudly instead of
 * quietly measuring refusals.
 */
const SAMPLES = MAX_INTENT_CHAIN_VERSIONS - SET_INTENT_CALLS_BEFORE_SAMPLING;

/**
 * Room demanded below the tool's own timeout. `set_intent` is an MCP tool with
 * a 10 s ceiling and no hook budget; a measurement that merely fits inside 10 s
 * would pass on a machine in serious trouble, so the bound is a fraction of it.
 */
const MCP_HEADROOM_RATIO = 0.2;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let hubRequests = 0;
const cleanups: string[] = [];

interface Developer {
  readonly apiKey: string;
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
  readonly hostSessionKey: string;
  readonly workContextId: string;
}

let alice: Developer;

const post = async (path: string, apiKey: string, body: unknown): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] ?? 0;
};

const setUp = async (): Promise<Developer> => {
  const created = await post("/api/developers", ADMIN_TOKEN, {
    name: "Alice",
    email: "alice-budget@example.com",
  });
  const account = (await created.json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  const apiKey = account.data.apiKey;
  const home = await makeHome("ib-alice");
  const repo = await makeRepo("ib-alice", { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const hostSessionKey = "ib-alice-uuid";
  const sessionId = `cc_${hostSessionKey}`;
  const workContextId = `wc_${sessionId}`;
  const startedAt = new Date().toISOString();
  await post("/api/sessions", apiKey, {
    id: sessionId,
    agentKind: "claude-code",
    repo: REPO_ID,
    branch: "detached@0badc0f",
    baseCommit: "a1b2c3d4",
    status: "analyzing",
  });
  await post("/api/records", apiKey, {
    records: [
      {
        kind: "work_context",
        op: "update",
        id: workContextId,
        sessionId,
        repo: REPO_ID,
        title: TITLE,
        status: "analyzing",
        capturedAt: startedAt,
      },
    ],
  });
  await writeSessionState(home, {
    hostSessionKey,
    crosscheckSessionId: sessionId,
    workContextId,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    developerId: account.data.developer.id,
    startedAt,
    lastHeartbeatAt: startedAt,
    seenTargets: [],
    workContextTitle: TITLE,
    workContextStatus: "analyzing",
    seqEpoch: SEQ_EPOCH,
    eventSeq: 0,
  });
  return {
    apiKey,
    home,
    repo,
    hostSessionKey,
    workContextId,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: apiKey,
    },
  };
};

const callSetIntent = async (summary: string): Promise<boolean> => {
  const tool = findTool("set_intent");
  if (tool === undefined) {
    throw new Error("no tool set_intent");
  }
  const setup = await prepareMcp(alice.env, alice.repo);
  if (!setup.ok) {
    throw new Error(`prepareMcp failed: ${setup.message}`);
  }
  const result = await tool.run(setup.ctx, { summary });
  return result.isError !== true;
};

beforeAll(async () => {
  db = await createDb();
  const app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({
    port: 0,
    fetch: (request, srv) => {
      hubRequests += 1;
      return app.fetch(request, srv);
    },
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  alice = await setUp();
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("INT-11 — what this spec costs set_intent", () => {
  test("no hub round trip is added: the request count is the one a count can see", async () => {
    // One warm-up outside the count: `prepareMcp` and the first connection
    // are not what this number is about.
    expect(await callSetIntent("warm up the path")).toBe(true);

    const before = hubRequests;
    expect(await callSetIntent("Make verifyToken refetch the JWKS")).toBe(true);
    const synchronous = hubRequests - before;

    // AND THEN WAIT, because the first version of this test did not.
    //
    // Reading the counter the instant the tool returns measures only the
    // tool's own duration — about 50 ms — so any round trip DEFERRED past
    // that return went uncounted: a debounced flush, a batched post, work
    // booked onto a later turn. This file's thesis is that a counter sees
    // what a wall clock cannot; it only did so for SYNCHRONOUS work, which is
    // the narrower claim it was not making.
    //
    // `set_intent` already books one such debt — the ghost check's model half
    // is left for the next UserPromptSubmit — so a second deferred call is
    // the most likely shape for this path to grow.
    await Bun.sleep(DEFERRED_SETTLE_MS);
    const settled = hubRequests - before;

    // eslint-disable-next-line no-console
    console.log(
      `[intent-budget] set_intent hub requests: ${String(synchronous)} ` +
        `synchronous, ${String(settled)} after ${String(DEFERRED_SETTLE_MS)} ms`,
    );
    expect(synchronous).toBe(SET_INTENT_HUB_REQUESTS);
    expect(settled).toBe(SET_INTENT_HUB_REQUESTS);
  });

  test("the seq reservation costs a bounded, printed amount of lock time", async () => {
    const samples: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const started = Bun.nanoseconds();
      const range = await allocateSeq(alice.home, alice.hostSessionKey, 1);
      samples.push((Bun.nanoseconds() - started) / 1e6);
      // The measurement is worthless if the allocator refused: a null answer
      // skips the write and would time the cheap path.
      expect(range).not.toBeNull();
    }

    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    // eslint-disable-next-line no-console
    console.log(
      `[intent-budget] allocateSeq p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms ` +
        `(uncontended; contended ceiling ${String(LOCK_CEILING_MS)} ms = ` +
        `${String(SESSION_STATE_LOCK_RETRIES)} retries x ${String(SPOOL_LOCK_RETRY_DELAY_MS)} ms)`,
    );

    // Uncontended, this is a read-transform-write of one small file. The bound
    // is the CONTENDED ceiling because that is the number §6 owes a reader:
    // an uncontended p95 anywhere near it means the lock is being taken twice.
    expect(p95).toBeLessThan(LOCK_CEILING_MS);
  });

  test("set_intent end to end stays far inside the MCP ceiling", async () => {
    const samples: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const started = Bun.nanoseconds();
      const ok = await callSetIntent(`Measure the tool, sample ${String(index)}`);
      samples.push((Bun.nanoseconds() - started) / 1e6);
      // A refused call is a CHEAPER call, so a p95 built from refusals would
      // read better the more of them there were. This is the assertion that
      // keeps the measurement a measurement.
      expect(ok).toBe(true);
    }

    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    const budget = MCP_TIMEOUT_MS * MCP_HEADROOM_RATIO;
    // eslint-disable-next-line no-console
    console.log(
      `[intent-budget] set_intent p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms ` +
        `(budget ${String(budget)} ms of MCP_TIMEOUT_MS ${String(MCP_TIMEOUT_MS)})`,
    );

    expect(p95).toBeLessThan(budget);
  });
});
