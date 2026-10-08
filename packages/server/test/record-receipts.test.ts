/**
 * A RECORD THE HUB ALREADY HOLDS IS A DUPLICATE, WHOEVER RE-SENDS IT
 * (review-2 round 8, M4). The hub checked the producer session before it
 * looked for the record, so a connector re-sending a batch it never heard the
 * answer to — under a life the hub had ended since — read `rejected` for
 * records the hub held, and counted them as lost (6.6% of the losses the
 * spool simulation counted at production timing). The hub keeps a receipt
 * of every envelope it took and answers the same envelope `duplicate` where
 * the producer check would refuse it. While its producer can still write, the
 * envelope goes through every check, as the update its newer body may be.
 */
import { describe, expect, test } from "bun:test";
import { MAX_INTENT_CHAIN_VERSIONS } from "@crosscheck/schema";
import { sql } from "drizzle-orm";

import { RECORD_RECEIPT_PRUNE_CHUNK, RECORD_RECEIPT_RETENTION_DAYS } from "../src/constants.ts";
import { pruneRecordReceipts } from "../src/services/record-receipts.ts";
import { reapStaleSessions } from "../src/services/sessions.ts";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const SECONDS_PER_DAY = 86_400;
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** A declared intent sentence, as set_intent sends one. */
const declared = (summary: string): Record<string, unknown> => ({
  summary,
  provenance: "declared",
  confidence: 1,
  capturedAt: TEST_START_ISO,
});

const target = (value: string) => ({ workContextId: WORK_CONTEXT_ID, kind: "file", value });

const endProducer = async (harness: TestHarness, developer: TestDeveloper): Promise<void> => {
  await harness.app.request(`/api/sessions/${VALID_SESSION_BODY.id}/end`, jsonRequest("POST", developer.apiKey, {}));
};

const statusOf = async (harness: TestHarness, developer: TestDeveloper, record: unknown): Promise<string | undefined> =>
  (await postRecords(harness, developer, { records: [record] })).data?.results[0]?.status;

describe("an envelope the hub already took", () => {
  test("is answered duplicate when it comes again, though its producer session has ended since", async () => {
    // Arrange: a target the hub took, its answer lost on the way back; then the life ends
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody())] });
    const held = recordEnvelope("target", target("src/held.ts"));
    const first = await statusOf(harness, developer, held);
    await endProducer(harness, developer);

    // Act: the connector re-sends what it never heard about
    const again = await statusOf(harness, developer, held);

    // Assert
    expect(first).toBe("accepted");
    expect(again).toBe("duplicate");
  });

  test("with a newer body is applied while its producer lives", async () => {
    // Arrange: a work context the hub took as `analyzing`
    const { harness, developer } = await createHarnessWithSession();
    const held = recordEnvelope("work_context", validWorkContextBody());
    await statusOf(harness, developer, held);

    // Act: the same envelope again, its life's status moved on since
    const changed = await statusOf(harness, developer, { ...held, body: validWorkContextBody({ status: "blocked" }) });

    // Assert: processed as the update it is
    expect(changed).toBe("accepted");
  });

  test("with a newer body under a producer that has ended is still the envelope the hub holds", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    const held = recordEnvelope("work_context", validWorkContextBody());
    await statusOf(harness, developer, held);
    await endProducer(harness, developer);

    // Act
    const changed = await statusOf(harness, developer, { ...held, body: validWorkContextBody({ status: "blocked" }) });

    // Assert: answered as held, never refused — only the change inside it is not applied
    expect(changed).toBe("duplicate");
  });

  test("never seen, under a producer that has ended, is refused as before", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody())] });
    await endProducer(harness, developer);

    // Act
    const fresh = await statusOf(harness, developer, recordEnvelope("target", target("src/late.ts")));

    // Assert
    expect(fresh).toBe("rejected");
  });

  test("is forgotten after the retention, on the hub's reaper pass", async () => {
    // Arrange: a target taken, then the retention passes and the reaper runs
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody())] });
    const held = recordEnvelope("target", target("src/old.ts"));
    await statusOf(harness, developer, held);
    harness.clock.advanceSeconds((RECORD_RECEIPT_RETENTION_DAYS + 1) * SECONDS_PER_DAY);
    await reapStaleSessions({ db: harness.db, now: harness.clock.now });
    await endProducer(harness, developer);

    // Act
    const again = await statusOf(harness, developer, held);

    // Assert: no receipt left, so the ended producer is refused as before
    expect(again).toBe("rejected");
  });
});

const SHARED_ID = "env_shared";
const ROBIN_SESSION = "ses_robin";

/** Robin, a second developer with a live session of his own. */
const addRobin = (harness: TestHarness): Promise<TestDeveloper> =>
  addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: ROBIN_SESSION });

/**
 * A RECEIPT IS ITS DEVELOPER'S, OF WHAT THE HUB TOOK, FOR ITS RETENTION —
 * each guard here is one a mutation of the round-8 review walked through
 * without a test noticing (review-2 round 9, M6).
 */
describe("a receipt", () => {
  test("is never another developer's: the same envelope id under their ended producer is refused", async () => {
    // Arrange: Nick's target taken under an envelope id; Robin's life ended
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody())] });
    await statusOf(harness, developer, recordEnvelope("target", target("src/nick.ts"), { id: SHARED_ID }));
    const robin = await addRobin(harness);
    await harness.app.request(`/api/sessions/${ROBIN_SESSION}/end`, jsonRequest("POST", robin.apiKey, {}));

    // Act: Robin's connector sends under the same envelope id
    const robins = await statusOf(
      harness,
      robin,
      recordEnvelope("target", { workContextId: "wc_robin", kind: "file", value: "src/robin.ts" }, { id: SHARED_ID, sessionId: ROBIN_SESSION }),
    );

    // Assert: answered as Robin's own, never with Nick's receipt
    expect(robins).toBe("rejected");
  });

  test("is never overwritten by another developer's envelope under the same id", async () => {
    // Arrange: Nick's claim taken; then Robin's claim, his life live, under Nick's envelope id
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody())] });
    const nicks = recordEnvelope("claim", validClaimBody({ id: "clm_nick" }), { id: SHARED_ID });
    await statusOf(harness, developer, nicks);
    const robin = await addRobin(harness);
    await postRecords(harness, robin, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_robin", sessionId: ROBIN_SESSION }), { sessionId: ROBIN_SESSION }),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_robin", workContextId: "wc_robin", authorSessionId: ROBIN_SESSION, body: "the cache key omits the tenant" }),
          { id: SHARED_ID, sessionId: ROBIN_SESSION },
        ),
      ],
    });
    await endProducer(harness, developer);

    // Act: Nick's connector re-sends the claim whose answer it never heard
    const again = (await postRecords(harness, developer, { records: [nicks] })).data?.results[0];

    // Assert: Nick's own receipt answers, with Nick's claim
    expect(again).toMatchObject({ status: "duplicate", id: "clm_nick" });
  });

  test("is never kept of a record the hub refused: its re-send under an ended producer is refused again", async () => {
    // Arrange: a claim on a work context the hub never heard of, refused while its producer lives
    const { harness, developer } = await createHarnessWithSession();
    const refused = recordEnvelope("claim", validClaimBody({ workContextId: "wc_missing" }));
    const first = await statusOf(harness, developer, refused);
    await endProducer(harness, developer);

    // Act
    const again = await statusOf(harness, developer, refused);

    // Assert
    expect(first).toBe("rejected");
    expect(again).toBe("rejected");
  });

  test("outlives the next day's reaper pass", async () => {
    // Arrange: a target taken, then a day passes and the reaper runs — a fixed
    // day, not one counted from the retention this guards
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody())] });
    const held = recordEnvelope("target", target("src/kept.ts"));
    await statusOf(harness, developer, held);
    harness.clock.advanceSeconds(SECONDS_PER_DAY);
    await reapStaleSessions({ db: harness.db, now: harness.clock.now });
    await endProducer(harness, developer);

    // Act
    const again = await statusOf(harness, developer, held);

    // Assert: the receipt answers the re-send
    expect(again).toBe("duplicate");
  });

  test("is each developer's own under a shared envelope id: both re-sends are answered held (review-2 round 9, L3)", async () => {
    // Arrange: Nick's claim and Robin's claim, each taken under one envelope id; then both lives end
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody())] });
    const nicks = recordEnvelope("claim", validClaimBody({ id: "clm_nick" }), { id: SHARED_ID });
    await statusOf(harness, developer, nicks);
    const robin = await addRobin(harness);
    const robins = recordEnvelope(
      "claim",
      validClaimBody({ id: "clm_robin", workContextId: "wc_robin", authorSessionId: ROBIN_SESSION, body: "the cache key omits the tenant" }),
      { id: SHARED_ID, sessionId: ROBIN_SESSION },
    );
    await postRecords(harness, robin, {
      records: [recordEnvelope("work_context", validWorkContextBody({ id: "wc_robin", sessionId: ROBIN_SESSION }), { sessionId: ROBIN_SESSION }), robins],
    });
    await endProducer(harness, developer);
    await harness.app.request(`/api/sessions/${ROBIN_SESSION}/end`, jsonRequest("POST", robin.apiKey, {}));

    // Act: each connector re-sends its claim
    const nicksAgain = (await postRecords(harness, developer, { records: [nicks] })).data?.results[0];
    const robinsAgain = (await postRecords(harness, robin, { records: [robins] })).data?.results[0];

    // Assert
    expect(nicksAgain).toMatchObject({ status: "duplicate", id: "clm_nick" });
    expect(robinsAgain).toMatchObject({ status: "duplicate", id: "clm_robin" });
  });

  test("of a record that landed is kept though its batch then failed (review-2 round 9, L3)", async () => {
    // Arrange: the claims table refuses one body below every check the hub
    // writes, so the batch fails after the records before it landed
    const { harness, developer } = await createHarnessWithSession();
    await harness.db.execute(sql`ALTER TABLE claims ADD CONSTRAINT claims_refuses_one CHECK (body <> 'refused below every check')`);
    const landed = recordEnvelope("claim", validClaimBody({ id: "clm_landed" }));
    const failed = await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        landed,
        recordEnvelope("claim", validClaimBody({ id: "clm_refused", body: "refused below every check" })),
      ],
    });
    await endProducer(harness, developer);

    // Act: the connector re-sends what the failed batch carried
    const again = await statusOf(harness, developer, landed);

    // Assert: the record that landed is answered held, not counted lost
    expect(failed.status).toBe(500);
    expect(again).toBe("duplicate");
  });

  test("of a record the hub kept without the change inside it answers its re-send ignored again (review-2 round 9, L3)", async () => {
    // Arrange: a work context whose intent chain is full; one sentence more is ignored, its answer lost; then the life ends
    const { harness, developer } = await createHarnessWithSession();
    const intentRecord = (n: number) => ({
      ...recordEnvelope("work_context", validWorkContextBody({ intent: declared(`Sentence ${String(n)}.`) })),
      seq: { epoch: EPOCH, n },
    });
    for (let n = 1; n <= MAX_INTENT_CHAIN_VERSIONS; n += 1) {
      await statusOf(harness, developer, intentRecord(n));
    }
    const capped = intentRecord(MAX_INTENT_CHAIN_VERSIONS + 1);
    const first = await statusOf(harness, developer, capped);
    await endProducer(harness, developer);

    // Act
    const again = await statusOf(harness, developer, capped);

    // Assert: the same answer as the first time, neither refused nor held as taken
    expect(first).toBe("ignored");
    expect(again).toBe("ignored");
  });
});

/**
 * A RECEIPT ONLY SPARES A RE-SEND ITS REFUSAL (review-2 round 9, M5), so the
 * hub reads and writes them best-effort: a read or a write that fails answers
 * the batch as a hub without receipts would, never with a 500.
 */
describe("a receipt the hub cannot read or write", () => {
  test("costs the batch nothing: its records are answered as without receipts", async () => {
    // Arrange: a hub whose receipts table is gone
    const { harness, developer } = await createHarnessWithSession();
    await harness.db.execute(sql`DROP TABLE record_receipts`);

    // Act
    const result = await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", validWorkContextBody()), recordEnvelope("target", target("src/a.ts"))],
    });

    // Assert
    expect(result.status).toBe(200);
    expect(result.data?.results.map((entry) => entry.status)).toEqual(["accepted", "accepted"]);
  });

  test("is never looked up for an unknown kind's id: a NUL there costs its neighbours none of their receipts", async () => {
    // Arrange: a target taken, its answer lost; then the life ends
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody())] });
    const held = recordEnvelope("target", target("src/held.ts"));
    await statusOf(harness, developer, held);
    await endProducer(harness, developer);

    // Act: the re-send beside a record of a kind this hub does not know, whose id carries a NUL
    const result = await postRecords(harness, developer, {
      records: [held, recordEnvelope("telemetry_blob", { anything: true }, { id: `env_${String.fromCharCode(0)}later` })],
    });

    // Assert
    expect(result.status).toBe(200);
    expect(result.data?.results.map((entry) => entry.status)).toEqual(["duplicate", "ignored"]);
  });
});

const receiptCount = async (harness: TestHarness): Promise<number> =>
  Number(((await harness.db.execute(sql`select count(*)::int as n from record_receipts`)).rows[0] as { n: unknown }).n);

/**
 * THE PRUNE IS NO SESSIONSTART'S TO PAY (review-2 round 9, M4). It ran
 * hub-wide on the register route, and PGlite serves one statement at a time:
 * after a restart the first SessionStart paid the whole backlog, 457 ms for a
 * million receipts, past the connector's 400 ms timeout. It runs on the hub's
 * own timer and once at boot, a chunk at a time.
 */
describe("the receipts prune", () => {
  test("never runs on a SessionStart's register, only on the hub's own pass", async () => {
    // Arrange: two envelopes taken, then the retention passes
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody())] });
    await statusOf(harness, developer, recordEnvelope("target", target("src/kept.ts")));
    harness.clock.advanceSeconds((RECORD_RECEIPT_RETENTION_DAYS + 1) * SECONDS_PER_DAY);

    // Act: a SessionStart registers, then the hub's timer pass runs
    await registerTestSession(harness, developer.apiKey);
    const afterRegister = await receiptCount(harness);
    await reapStaleSessions({ db: harness.db, now: harness.clock.now });

    // Assert
    expect(afterRegister).toBe(2);
    expect(await receiptCount(harness)).toBe(0);
  });

  test("takes a backlog a chunk at a time, and serves a request that arrives meanwhile between two chunks", async () => {
    // Arrange: three chunks' worth of receipts past the retention
    const { harness, developer } = await createHarnessWithSession();
    const backlog = RECORD_RECEIPT_PRUNE_CHUNK * 3;
    await harness.db.execute(
      sql.raw(`INSERT INTO record_receipts (id, developer_id, result_id, received_at)
        SELECT 'env_' || g, '${developer.developerId}', NULL, to_timestamp(0) FROM generate_series(1, ${String(backlog)}) g`),
    );

    // Act: a query from the next turn of the event loop, where a request is
    // read; PGlite answers in microtasks, so a prune that never yields runs
    // to its end before that turn comes
    const pruning = pruneRecordReceipts({ db: harness.db, now: harness.clock.now });
    await new Promise((resolve) => setImmediate(resolve));
    const during = await receiptCount(harness);
    const pruned = await pruning;

    // Assert: it ran after the first chunk and before the last, and the prune took everything
    expect(during).toBe(backlog - RECORD_RECEIPT_PRUNE_CHUNK);
    expect(pruned).toBe(backlog);
    expect(await receiptCount(harness)).toBe(0);
  });
});
