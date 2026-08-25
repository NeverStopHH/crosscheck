/**
 * A read that is only a read (trial finding V1-X1), plus the two numbers the
 * connector needs to say whether capture and hints work at all (M1).
 *
 * `GET /api/work-contexts/:id/diagnosis` marks the reader's hint deliveries
 * pulled, because a developer opening a hinted tree IS the "the hint was
 * useful" signal. That makes every read of it a WRITE to the precision
 * ledger — and the trial's own auditor walked 113 contexts through it. There
 * was no other door: the pure `GET /:id` did not exist.
 *
 * The `claimCount` assertion below is the regression any join-based
 * `targetCount` causes: two left joins against one grouped row multiply each
 * other's `count()`.
 *
 * WHICH IMPLEMENTATION THESE GUARD, after the M1 and #20 rounds were merged:
 * one `/api/hints/stats`, `readHintStats` in services/hint-deliveries.ts. It
 * carries the trailing WINDOW #20 added (hence `windowDays` in every expected
 * body) and the repo-wide `claims` count M1 added, which is unwindowed on
 * purpose — a claim published before the window still gives a hint something
 * to point at. The duplicate window-less `hintStatsForRepo` this file was
 * written against is gone.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { hintDeliveries } from "../src/db/schema.ts";
import { HINT_STATS_DEFAULT_WINDOW_DAYS } from "../src/services/hint-deliveries.ts";
import {
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  TEST_START_ISO,
  validClaimBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { HarnessWithSession } from "./helpers.ts";

const REPO = "github.com/acme/api";
const DELIVERY_ID = "hd_0123456789abcdef0123456789abcdef";

/** One context, three claims, two targets, one UNPULLED hint delivery. */
const seedTree = async (): Promise<HarnessWithSession> => {
  const seeded = await createHarnessWithSession();
  const result = await postRecords(seeded.harness, seeded.developer, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope("target", {
        workContextId: WORK_CONTEXT_ID,
        kind: "file",
        value: "src/auth.ts",
      }),
      recordEnvelope("target", {
        workContextId: WORK_CONTEXT_ID,
        kind: "file",
        value: "src/token.ts",
      }),
      // DISTINCT bodies: the ingest dedup gate folds same-context, same-kind,
      // same-normalized-body claims into one, which would quietly make this
      // a one-claim fixture and hide the join-multiplication it exists to
      // catch (services/record-handlers.ts findDedupMatch).
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_01", body: "JWT validation fails after refresh" }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_02", body: "The refresh endpoint returns 500" }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_03", body: "Token expiry is read in the wrong unit" }),
      ),
      recordEnvelope("hint_delivery", {
        id: DELIVERY_ID,
        sessionId: "ses_01",
        refKind: "claim",
        refId: "clm_01",
        deliveredAt: TEST_START_ISO,
      }),
    ],
  });
  expect(result.data?.accepted).toBe(7);
  return seeded;
};

const pulledAtOf = async (seeded: HarnessWithSession): Promise<Date | null> => {
  const rows = await seeded.harness.db
    .select()
    .from(hintDeliveries)
    .where(eq(hintDeliveries.id, DELIVERY_ID));
  return rows[0]?.pulledAt ?? null;
};

describe("pure work-context read", () => {
  test("GET /:id returns the tree and marks nothing", async () => {
    // Arrange
    const seeded = await seedTree();

    // Act
    const response = await seeded.harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}`,
      jsonRequest("GET", seeded.developer.apiKey),
    );

    // Assert: the same payload, and the ledger untouched
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { workContext: { id: string }; claims: unknown[]; targets: unknown[] };
    };
    expect(body.data.workContext.id).toBe(WORK_CONTEXT_ID);
    expect(body.data.claims).toHaveLength(3);
    expect(body.data.targets).toHaveLength(2);
    expect(await pulledAtOf(seeded)).toBeNull();
  });

  test("?telemetry=0 spares the ledger while the bare url still marks it", async () => {
    // Arrange
    const seeded = await seedTree();

    // Act: the opted-out read first
    await seeded.harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis?telemetry=0`,
      jsonRequest("GET", seeded.developer.apiKey),
    );
    const afterOptOut = await pulledAtOf(seeded);

    // Act: then the ordinary one — the precision loop must still work
    await seeded.harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", seeded.developer.apiKey),
    );

    // Assert
    expect(afterOptOut).toBeNull();
    expect(await pulledAtOf(seeded)).not.toBeNull();
  });

  test("an unknown id is a 404 on the pure path too", async () => {
    // Arrange
    const seeded = await seedTree();

    // Act
    const response = await seeded.harness.app.request(
      "/api/work-contexts/wc_nope",
      jsonRequest("GET", seeded.developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(404);
  });
});

describe("listing carries targetCount without disturbing claimCount", () => {
  test("three claims and two targets stay three and two", async () => {
    // Arrange
    const seeded = await seedTree();

    // Act
    const response = await seeded.harness.app.request(
      `/api/work-contexts?repo=${encodeURIComponent(REPO)}`,
      jsonRequest("GET", seeded.developer.apiKey),
    );

    // Assert: the join-multiplication regression is the whole point here
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { workContexts: { claimCount: number; targetCount: number }[] };
    };
    expect(body.data.workContexts[0]?.claimCount).toBe(3);
    expect(body.data.workContexts[0]?.targetCount).toBe(2);
  });

  test("a context with no targets reports zero rather than omitting the field", async () => {
    // Arrange
    const seeded = await createHarnessWithSession();
    await postRecords(seeded.harness, seeded.developer, {
      records: [recordEnvelope("work_context", validWorkContextBody())],
    });

    // Act
    const response = await seeded.harness.app.request(
      `/api/work-contexts?repo=${encodeURIComponent(REPO)}`,
      jsonRequest("GET", seeded.developer.apiKey),
    );

    // Assert
    const body = (await response.json()) as {
      data: { workContexts: { targetCount: number }[] };
    };
    expect(body.data.workContexts[0]?.targetCount).toBe(0);
  });
});

describe("hint stats", () => {
  test("delivered, pulled and the claims that decide whether hints can fire", async () => {
    // Arrange
    const seeded = await seedTree();

    // Act: before any pull
    const before = await seeded.harness.app.request(
      `/api/hints/stats?repo=${encodeURIComponent(REPO)}`,
      jsonRequest("GET", seeded.developer.apiKey),
    );
    const beforeBody = (await before.json()) as {
      data: { delivered: number; pulled: number; claims: number; windowDays: number };
    };

    // Act: then a real diagnosis read, which is the pull signal
    await seeded.harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", seeded.developer.apiKey),
    );
    const after = await seeded.harness.app.request(
      `/api/hints/stats?repo=${encodeURIComponent(REPO)}`,
      jsonRequest("GET", seeded.developer.apiKey),
    );
    const afterBody = (await after.json()) as {
      data: { delivered: number; pulled: number; claims: number; windowDays: number };
    };

    // Assert
    const windowDays = HINT_STATS_DEFAULT_WINDOW_DAYS;
    expect(beforeBody.data).toEqual({ delivered: 1, pulled: 0, claims: 3, windowDays });
    expect(afterBody.data).toEqual({ delivered: 1, pulled: 1, claims: 3, windowDays });
  });

  test("a repo with no claims reports zero — the structural fact, not a tuning problem", async () => {
    // Arrange: a session on a repo where nobody has published anything
    const seeded = await createHarnessWithSession();

    // Act
    const response = await seeded.harness.app.request(
      `/api/hints/stats?repo=${encodeURIComponent("github.com/acme/empty")}`,
      jsonRequest("GET", seeded.developer.apiKey),
    );

    // Assert
    const body = (await response.json()) as {
      data: { delivered: number; pulled: number; claims: number; windowDays: number };
    };
    expect(body.data).toEqual({
      delivered: 0,
      pulled: 0,
      claims: 0,
      windowDays: HINT_STATS_DEFAULT_WINDOW_DAYS,
    });
  });

  test("a missing repo parameter is a 400, not a silent all-repo scan", async () => {
    // Arrange
    const seeded = await createHarnessWithSession();

    // Act
    const response = await seeded.harness.app.request(
      "/api/hints/stats",
      jsonRequest("GET", seeded.developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(400);
  });
});
