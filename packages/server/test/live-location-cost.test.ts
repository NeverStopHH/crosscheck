/**
 * WHAT OPTING OUT COSTS EVERYONE ELSE (review round 5, H3; the reviewer's
 * zz-probe-bench and zz-probe-ingest).
 *
 * Round 4 learned a hidden owner's every branch by scanning the events
 * table — unindexed and unpruned — once per call: on every colleague read,
 * twice per hint candidates call (the UserPromptSubmit hook's budget is
 * 400 ms), once per record of her own ingest, once per context of a toggle.
 * At 500k events: hint candidates p50 107 ms against 10, her 100-claim batch
 * 3.6 s, a toggle 4.8 s. Her branches now live in `developer_branches`,
 * written as sessions register; reads look them up by developer.
 *
 * And because the table is the memory, pruning the events table no longer
 * makes the hub forget a branch she left (review round 4, L2).
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { WITHHELD_TITLE } from "@crosscheck/schema";

import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import { setPresenceOptOutViaApi } from "./ui-helpers.ts";

const REPO = "github.com/acme/api";
const LOCAL_REPO = "local:0123456789abcdef";
const ROBIN_S = "cc_00000000-0000-4000-8000-000000000001";
const ROBIN_LOCAL_S = "cc_00000000-0000-4000-8000-000000000002";
const NICK_S = "cc_00000000-0000-4000-8000-000000000003";
/** Large enough that a scan per call shows; small enough for a test run. */
const EXTRA_EVENTS = 200_000;
const SAMPLES = 15;
const WARMUP = 3;
const BATCH = 100;
/** "Within a few ms": twice the opted-in time plus a margin for noise. */
const READ_MARGIN_MS = 15;
const BATCH_MARGIN_MS = 250;

interface World {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly robin: TestDeveloper;
}

const seed = async (): Promise<World> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
  await registerTestSession(harness, nick.apiKey, { id: NICK_S, branch: "fix/nick", baseCommit: "aaaabbbbcccc" });
  await registerTestSession(harness, robin.apiKey, { id: ROBIN_S, branch: "fix/robin-refresh", baseCommit: "c0ffee000000" });
  const contexts = Array.from({ length: 20 }, (_unused, n) => [
    recordEnvelope("work_context", validWorkContextBody({ id: `wc_r_${String(n)}`, sessionId: ROBIN_S, title: n % 2 === 0 ? "fix/robin-refresh @ api" : `Refresh token work ${String(n)}`, titleSource: n % 2 === 0 ? "fallback" : "host", description: `refresh token rotation case ${String(n)}` }), { sessionId: ROBIN_S }),
    recordEnvelope("target", { workContextId: `wc_r_${String(n)}`, kind: "file", value: "src/auth/refresh.ts" }, { sessionId: ROBIN_S }),
  ]).flat();
  await postRecords(harness, robin, { records: contexts });
  return { harness, nick, robin };
};

const growEvents = async (harness: TestHarness): Promise<void> => {
  await harness.db.execute(sql`INSERT INTO events (kind, payload, created_at)
    SELECT CASE WHEN i % 50 = 0 THEN 'session_started' ELSE 'claim_added' END,
           jsonb_build_object('developerId', 'dev_' || (i % 12), 'branch', 'feat/b' || (i % 97), 'claimId', 'clm_' || i),
           now()
      FROM generate_series(1, ${EXTRA_EVENTS}) AS i`);
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const p50 = async (world: World, path: string): Promise<number> => {
  const times: number[] = [];
  for (let index = 0; index < WARMUP + SAMPLES; index += 1) {
    const started = performance.now();
    const response = await world.harness.app.request(path, jsonRequest("GET", world.nick.apiKey));
    await response.text();
    if (index >= WARMUP) {
      times.push(performance.now() - started);
    }
  }
  return median(times);
};

const claimBatch = (prefix: string): Record<string, unknown>[] =>
  Array.from({ length: BATCH }, (_unused, n) =>
    recordEnvelope("claim", validClaimBody({ id: `clm_${prefix}_${String(n)}`, workContextId: "wc_r_0", authorSessionId: ROBIN_S, body: `finding ${prefix} ${String(n)} about the refresh path` }), { sessionId: ROBIN_S }),
  );

const timedBatch = async (world: World, prefix: string): Promise<number> => {
  const started = performance.now();
  const posted = await postRecords(world.harness, world.robin, { records: claimBatch(prefix) });
  expect(posted.data?.rejected).toBe(0);
  return performance.now() - started;
};

describe("opting out costs colleagues nothing they would notice", () => {
  test(`a colleague's hint candidates and her own ingest, at ${String(EXTRA_EVENTS)} extra events`, async () => {
    const world = await seed();
    await growEvents(world.harness);
    const hints = `/api/hints/candidates?repo=${encodeURIComponent(REPO)}&query=${encodeURIComponent("refresh token rotation src/auth/refresh.ts")}`;

    const optedInRead = await p50(world, hints);
    const optedInBatch = await timedBatch(world, "in");
    await setPresenceOptOutViaApi(world.harness, world.robin.apiKey, true);
    const optedOutRead = await p50(world, hints);
    const optedOutBatch = await timedBatch(world, "out");

    expect(optedOutRead).toBeLessThanOrEqual(2 * optedInRead + READ_MARGIN_MS);
    expect(optedOutBatch).toBeLessThanOrEqual(2 * optedInBatch + BATCH_MARGIN_MS);
  }, 600_000);
});

/** The slice of the PGlite client the hub's queries go through. */
interface Queryable {
  query: (text: string, ...rest: unknown[]) => Promise<unknown>;
  transaction: <T>(work: (tx: Queryable) => Promise<T>) => Promise<T>;
}

/** How many statements read developer_branches while `act` runs, transactions included. */
const countBranchReads = async (harness: TestHarness, act: () => Promise<unknown>): Promise<number> => {
  let reads = 0;
  const counting = (target: Queryable): void => {
    const query = target.query.bind(target);
    target.query = (text, ...rest) => {
      reads += text.includes("developer_branches") ? 1 : 0;
      return query(text, ...rest);
    };
  };
  const client = (harness.db as unknown as { readonly $client: Queryable }).$client;
  const { query, transaction } = client;
  counting(client);
  client.transaction = (work) =>
    transaction.call(client, (tx) => {
      counting(tx);
      return work(tx);
    }) as never;
  try {
    await act();
  } finally {
    client.query = query;
    client.transaction = transaction;
  }
  return reads;
};

describe("her branches are read once per read, and only when a title needs them", () => {
  test("a colleague's hint candidates look her branches up once, not once per stage", async () => {
    // Arrange
    const world = await seed();
    await setPresenceOptOutViaApi(world.harness, world.robin.apiKey, true);
    const hints = `/api/hints/candidates?repo=${encodeURIComponent(REPO)}&query=${encodeURIComponent("refresh token rotation src/auth/refresh.ts")}`;

    // Act
    let candidates = 0;
    const reads = await countBranchReads(world.harness, async () => {
      const response = await world.harness.app.request(hints, jsonRequest("GET", world.nick.apiKey));
      candidates = ((await response.json()) as { data: { candidates: unknown[] } }).data.candidates.length;
    });

    // Assert: the read found her work, and asked for her branches once.
    expect(candidates).toBeGreaterThan(0);
    expect(reads).toBe(1);
  });

  test("her ingest reads her branches only for a title without the connector's marker", async () => {
    // Arrange
    const world = await seed();
    await setPresenceOptOutViaApi(world.harness, world.robin.apiKey, true);
    const context = (id: string, titleSource: string | undefined): Record<string, unknown> =>
      recordEnvelope("work_context", validWorkContextBody({ id, sessionId: ROBIN_S, title: `Refresh token work ${id}`, ...(titleSource === undefined ? {} : { titleSource }) }), { sessionId: ROBIN_S });

    // Act
    const marked = await countBranchReads(world.harness, () =>
      postRecords(world.harness, world.robin, { records: [context("wc_r_host", "host"), context("wc_r_fallback", "fallback"), context("wc_r_person", "person")] }),
    );
    const unmarked = await countBranchReads(world.harness, () =>
      postRecords(world.harness, world.robin, { records: [context("wc_r_unmarked", undefined)] }),
    );

    // Assert: the marker decides on its own; an unmarked title still asks
    // (and so proves the count sees her ingest at all).
    expect(marked).toBe(0);
    expect(unmarked).toBeGreaterThan(0);
  });
});

describe("the hub remembers every branch she reported, whatever the events table keeps", () => {
  test("a bare-branch title on a branch she left stays withheld after the events are pruned", async () => {
    // Arrange: her local session reports branch A, her context is titled A
    // (an older connector: no title marker), and the session moves to B.
    const world = await seed();
    await registerTestSession(world.harness, world.robin.apiKey, { id: ROBIN_LOCAL_S, repo: LOCAL_REPO, branch: "feat/robin-old-hideout", baseCommit: "beef00000000" });
    await postRecords(world.harness, world.robin, {
      records: [recordEnvelope("work_context", validWorkContextBody({ id: "wc_r_local", sessionId: ROBIN_LOCAL_S, title: "feat/robin-old-hideout" }), { sessionId: ROBIN_LOCAL_S })],
    });
    await registerTestSession(world.harness, world.robin.apiKey, { id: ROBIN_LOCAL_S, repo: LOCAL_REPO, branch: "feat/robin-next", baseCommit: "beef00000001" });
    await setPresenceOptOutViaApi(world.harness, world.robin.apiKey, true);
    // Act: retention prunes the events table.
    await world.harness.db.execute(sql`DELETE FROM events`);
    const response = await world.harness.app.request("/api/work-contexts/wc_r_local", jsonRequest("GET", world.nick.apiKey));
    // Assert
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { workContext: { title: string } } }).data.workContext.title).toBe(WITHHELD_TITLE);
  });
});
