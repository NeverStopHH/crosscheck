import { describe, expect, test } from "bun:test";

import { MAX_COMMIT_CLOCK_SKEW_MS, deliveryIdFor } from "@crosscheck/schema";

import { hintDeliveries } from "../src/db/schema.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  registerTestSession,
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

/**
 * A delivery body whose id is DERIVED from its own session, ref and channel —
 * which the hub now requires (07 §3.1) — unless a test sets one on purpose.
 */
const deliveryBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    sessionId: "ses_01",
    refKind: "claim",
    refId: "clm_01",
    deliveredAt: TEST_START_ISO,
    ...overrides,
  };
  return {
    id: deliveryIdFor(
      String(body["sessionId"]),
      String(body["refId"]),
      String(body["channel"] ?? "unknown"),
    ),
    ...body,
  };
};

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

/**
 * WHICH SURFACE HANDED IT OVER (07 §3.1).
 *
 * `delivered / pulled` was one number over two channels that are not
 * comparable: a briefing arrives unasked at SessionStart, a hint interrupts a
 * turn already under way. Every pilot proof needs them apart.
 *
 * THE THREE CASES ARE THE WHOLE CONTRACT. An absent channel is `unknown` and
 * is STORED — refusing it would drop the deliveries of every install nobody
 * has upgraded, which is exactly the history worth counting. A named channel
 * is stored as named. And a word this hub does not know is REFUSED at the
 * boundary: an enum that quietly accepts anything is a text column with a
 * comment, and the report built on it would count buckets nobody defined.
 */
/**
 * A DELIVERY ID IS COMPUTED, AND THE HUB CHECKS IT WAS (07 §3.1, corrected).
 *
 * Found by an adversarial review: the id is deterministic, so a teammate who
 * can see your session id could post `hd(your session, ref)` under their own
 * session first. The primary key then dropped your genuine delivery as a
 * duplicate, and with it your right to call that intervention noise.
 */
describe("a delivery id cannot be squatted", () => {
  test("an id derived from somebody else's session is refused", async () => {
    // Arrange — Robin computes Nick's delivery id and posts it as his own
    const { harness, developer } = await seedContextWithClaim();
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin-squat@example.com", {
      id: SECOND_SESSION_ID,
    });
    const nicksId = deliveryIdFor("ses_01", "clm_01", "unknown");

    // Act
    const squat = await postRecords(
      harness,
      robin,
      recordEnvelope(
        "hint_delivery",
        { ...deliveryBody({ sessionId: SECOND_SESSION_ID }), id: nicksId },
        { sessionId: SECOND_SESSION_ID },
      ),
    );
    const genuine = await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", deliveryBody()),
    );

    // Assert — refused, and Nick's own delivery then lands as his
    expect(squat.data?.rejected).toBe(1);
    expect(genuine.data?.accepted).toBe(1);
    const rows = await listDeliveryRows(harness);
    expect(rows.map((row) => [row.id, row.sessionId])).toEqual([[nicksId, "ses_01"]]);
  });

  test("a tripwire delivery must carry the tripwire namespace", async () => {
    // Arrange
    const { harness, developer } = await seedContextWithClaim();

    // Act — the bare id on the tripwire channel is somebody else's slot
    const wrong = await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", {
        ...deliveryBody({ channel: "tripwire" }),
        id: deliveryIdFor("ses_01", "clm_01", "prompt_hint"),
      }),
    );
    const right = await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", deliveryBody({ channel: "tripwire" })),
    );

    // Assert
    expect(wrong.data?.rejected).toBe(1);
    expect(right.data?.accepted).toBe(1);
  });

  test("a delivery dated in the future is held to the hub's clock", async () => {
    // Arrange — stamped 2099, it would sit at the top of every noise
    // candidate list for good
    const { harness, developer } = await seedContextWithClaim();

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", deliveryBody({ deliveredAt: "2099-01-01T00:00:00.000Z" })),
    );

    // Assert — no later than now plus the allowed skew
    const stored = (await listDeliveryRows(harness))[0]?.deliveredAt;
    expect(stored?.getTime()).toBeLessThanOrEqual(
      new Date(TEST_START_ISO).getTime() + MAX_COMMIT_CLOCK_SKEW_MS,
    );
  });
});

describe("the delivery channel (07 §3.1)", () => {
  test("a connector older than the column stores `unknown`, not a refusal", async () => {
    // Arrange — no `channel` key at all, which is every connector today
    const { harness, developer } = await seedContextWithClaim();

    // Act
    const result = await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", deliveryBody()),
    );

    // Assert
    expect(result.data?.accepted).toBe(1);
    expect((await listDeliveryRows(harness))[0]?.channel).toBe("unknown");
  });

  test("a named channel is stored as named", async () => {
    // Arrange
    const { harness, developer } = await seedContextWithClaim();

    // Act
    const result = await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", deliveryBody({ channel: "briefing" })),
    );

    // Assert
    expect(result.data?.accepted).toBe(1);
    expect((await listDeliveryRows(harness))[0]?.channel).toBe("briefing");
  });

  test("a channel this hub does not know is REFUSED, never stored", async () => {
    // Arrange — the case that decides whether this is an enum or a text
    // column with a comment on it.
    const { harness, developer } = await seedContextWithClaim();

    // Act
    const result = await postRecords(
      harness,
      developer,
      recordEnvelope("hint_delivery", deliveryBody({ channel: "telepathy" })),
    );

    // Assert
    expect(result.data?.accepted).toBe(0);
    expect(result.data?.rejected).toBe(1);
    expect(await listDeliveryRows(harness)).toHaveLength(0);
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

  test("a read that names its session stamps only that session's deliveries", async () => {
    // Arrange — one developer, two sessions, both shown the same claim. The
    // read comes from ses_01; ses_03 never opened anything (07, corrected).
    const { harness, developer } = await seedContextWithClaim();
    await registerTestSession(harness, developer.apiKey, { id: "ses_03" });
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("hint_delivery", deliveryBody()),
        recordEnvelope("hint_delivery", deliveryBody({ sessionId: "ses_03" }), {
          sessionId: "ses_03",
        }),
      ],
    });

    // Act
    await harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis?session=ses_01`,
      jsonRequest("GET", developer.apiKey),
    );

    // Assert
    const rows = await listDeliveryRows(harness);
    const pulled = Object.fromEntries(rows.map((row) => [row.sessionId, row.pulledAt !== null]));
    expect(pulled).toEqual({ ses_01: true, ses_03: false });
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

/**
 * WHICH IMPLEMENTATION THESE GUARD, after the #20 and M1 rounds were merged:
 * `readHintStats`, the one reader left on this route. It kept #20's trailing
 * window (`windowDays`, clamped) and gained M1's repo-wide `claims` count,
 * which is deliberately NOT windowed — a claim published before the window
 * still gives a hint something to point at — so it appears in every body
 * below and moves with the repo, not with the delivery window.
 */
describe("GET /api/hints/stats — delivered/pulled per repo (trial finding #20)", () => {
  const REPO = "github.com/acme/api";
  const statsFor = async (
    harness: TestHarness,
    developer: TestDeveloper,
    query: string,
  ): Promise<{ status: number; data: Record<string, unknown> | null }> => {
    const response = await harness.app.request(
      `/api/hints/stats${query}`,
      jsonRequest("GET", developer.apiKey),
    );
    if (response.status !== 200) {
      return { status: response.status, data: null };
    }
    const body = (await response.json()) as { data: Record<string, unknown> };
    return { status: response.status, data: body.data };
  };

  test("counts this repo's deliveries inside the window and how many were pulled", async () => {
    // Arrange: two deliveries to ses_01 — a claim ref inside wc_01 (pulled by
    // the diagnosis read below) and a context ref to ANOTHER tree (stays
    // unpulled); a third delivery from before the window must not count.
    const { harness, developer } = await seedContextWithClaim();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("hint_delivery", deliveryBody()),
        recordEnvelope(
          "hint_delivery",
          deliveryBody({
            refKind: "work_context",
            refId: "wc_elsewhere",
          }),
        ),
        recordEnvelope(
          "hint_delivery",
          // Its own ref, so its DERIVED id is its own: the window, not the
          // id check, is what must keep it out of the count.
          deliveryBody({
            refId: "clm_before_window",
            deliveredAt: "2026-06-01T09:00:00.000Z",
          }),
        ),
      ],
    });
    await harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", developer.apiKey),
    );

    // Act
    const result = await statsFor(harness, developer, `?repo=${encodeURIComponent(REPO)}`);

    // Assert: 2 in the 7-day window, 1 pulled, the window stated, and the
    // repo's one claim — the seeded tree's, outside the window question
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ delivered: 2, pulled: 1, windowDays: 7, claims: 1 });
  });

  test("another repo's deliveries do not count", async () => {
    // Arrange: Robin's session reports to a different repo
    const { harness, developer } = await seedContextWithClaim();
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: SECOND_SESSION_ID, repo: "github.com/acme/web" },
    );
    await postRecords(
      harness,
      robin,
      recordEnvelope(
        "hint_delivery",
        deliveryBody({ sessionId: SECOND_SESSION_ID }),
        { sessionId: SECOND_SESSION_ID },
      ),
    );

    // Act
    const api = await statsFor(harness, developer, `?repo=${encodeURIComponent(REPO)}`);
    const web = await statsFor(
      harness,
      developer,
      `?repo=${encodeURIComponent("github.com/acme/web")}`,
    );

    // Assert: `claims` is repo-scoped the same way the deliveries are — the
    // seeded tree is on api, and web has nothing published on it at all
    expect(api.data).toEqual({ delivered: 0, pulled: 0, windowDays: 7, claims: 1 });
    expect(web.data).toEqual({ delivered: 1, pulled: 0, windowDays: 7, claims: 0 });
  });

  test("the window is bounded: days is clamped to the maximum, repo is required", async () => {
    // Arrange
    const { harness, developer } = await seedContextWithClaim();

    // Act
    const noRepo = await statsFor(harness, developer, "");
    const wide = await statsFor(
      harness,
      developer,
      `?repo=${encodeURIComponent(REPO)}&days=100000`,
    );

    // Assert: a missing repo is a validation failure; an absurd window is
    // clamped, never honoured
    expect(noRepo.status).toBe(400);
    expect(wide.status).toBe(200);
    expect(wide.data?.windowDays).toBe(90);
  });
});
