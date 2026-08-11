import { describe, expect, test } from "bun:test";

import { hintDeliveries } from "../src/db/schema.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  TEST_START_ISO,
  validClaimBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const SECOND_SESSION_ID = "ses_02";

const deliveryBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "hd_0123456789abcdef0123456789abcdef",
  sessionId: "ses_01",
  refKind: "claim",
  refId: "clm_01",
  deliveredAt: TEST_START_ISO,
  ...overrides,
});

const listDeliveryRows = (harness: TestHarness) =>
  harness.db.select().from(hintDeliveries);

/** Nick's harness with wc_01 + clm_01 already ingested. */
const seedContextWithClaim = async (): Promise<{
  harness: TestHarness;
  developer: TestDeveloper;
}> => {
  const { harness, developer } = await createHarnessWithSession();
  const seeded = await postRecords(harness, developer, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope("claim", validClaimBody()),
    ],
  });
  expect(seeded.data?.accepted).toBe(2);
  return { harness, developer };
};

describe("hint_delivery ingest", () => {
  test("accepts a delivery and lands exactly one unpulled row", async () => {
    // Arrange
    const { harness, developer } = await seedContextWithClaim();

    // Act
    const result = await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", deliveryBody()),
    );

    // Assert
    expect(result.data?.accepted).toBe(1);
    const rows = await listDeliveryRows(harness);
    expect(rows.length).toBe(1);
    expect(rows[0]?.refId).toBe("clm_01");
    expect(rows[0]?.pulledAt).toBeNull();
  });

  test("a spool replay of the same delivery is a duplicate, not a second row", async () => {
    // Arrange
    const { harness, developer } = await seedContextWithClaim();
    await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", deliveryBody()),
    );

    // Act — same deterministic delivery id, as a cursor-lost replay resends it
    const replay = await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", deliveryBody()),
    );

    // Assert
    expect(replay.data?.duplicates).toBe(1);
    expect(replay.data?.accepted).toBe(0);
    expect((await listDeliveryRows(harness)).length).toBe(1);
  });

  test("rejects a delivery naming another developer's session", async () => {
    // Arrange
    const { harness } = await seedContextWithClaim();
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: SECOND_SESSION_ID },
    );

    // Act — Robin reports a delivery into Nick's session
    const result = await postRecords(
      harness,
      robin,
      recordEnvelope("hint_delivery", deliveryBody(), {
        sessionId: SECOND_SESSION_ID,
      }),
    );

    // Assert
    expect(result.data?.rejected).toBe(1);
    expect((await listDeliveryRows(harness)).length).toBe(0);
  });
});

describe("get_diagnosis marks deliveries pulled (the precision loop)", () => {
  test("the receiving developer's claim- and context-refs are marked", async () => {
    // Arrange — one claim ref and one work-context ref delivered to ses_01
    const { harness, developer } = await seedContextWithClaim();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("hint_delivery", deliveryBody()),
        recordEnvelope(
          "hint_delivery",
          deliveryBody({
            id: "hd_ffffffffffffffffffffffffffffffff",
            refKind: "work_context",
            refId: WORK_CONTEXT_ID,
          }),
        ),
      ],
    });

    // Act
    const response = await harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(200);
    const rows = await listDeliveryRows(harness);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.pulledAt).not.toBeNull();
    }
  });

  test("another developer's read leaves them unpulled", async () => {
    // Arrange
    const { harness, developer } = await seedContextWithClaim();
    await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", deliveryBody()),
    );
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: SECOND_SESSION_ID },
    );

    // Act — Robin reads the same tree; the hint was never delivered to Robin
    const response = await harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", robin.apiKey),
    );

    // Assert
    expect(response.status).toBe(200);
    const rows = await listDeliveryRows(harness);
    expect(rows[0]?.pulledAt).toBeNull();
  });

  test("a pulled timestamp is not rewritten by a second read", async () => {
    // Arrange
    const { harness, developer } = await seedContextWithClaim();
    await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", deliveryBody()),
    );
    await harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", developer.apiKey),
    );
    const first = (await listDeliveryRows(harness))[0]?.pulledAt;
    harness.clock.advanceSeconds(60);

    // Act
    await harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", developer.apiKey),
    );

    // Assert — the FIRST pull is the precision signal; later reads are noise
    expect((await listDeliveryRows(harness))[0]?.pulledAt).toEqual(first);
  });
});
