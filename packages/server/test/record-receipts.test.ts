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

import { RECORD_RECEIPT_RETENTION_DAYS } from "../src/constants.ts";
import { reapStaleSessions } from "../src/services/sessions.ts";

import {
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
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
