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
import { sql } from "drizzle-orm";

import { RECORD_RECEIPT_PRUNE_CHUNK, RECORD_RECEIPT_RETENTION_DAYS } from "../src/constants.ts";
import { pruneRecordReceipts } from "../src/services/record-receipts.ts";
import { reapStaleSessions } from "../src/services/sessions.ts";

import {
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const SECONDS_PER_DAY = 86_400;

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
