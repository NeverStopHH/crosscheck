import { describe, expect, test } from "bun:test";

import { MAX_COMMIT_CLOCK_SKEW_MS } from "@crosscheck/schema";

import { commitEvidence } from "../src/db/schema.ts";
import {
  TEST_START_ISO,
  createHarnessWithSession,
  postRecords,
  recordEnvelope,
} from "./helpers.ts";
import type { HarnessWithSession } from "./helpers.ts";

const REPO = "github.com/acme/api";
const MS_PER_DAY = 86_400_000;
const START_MS = new Date(TEST_START_ISO).getTime();

const isoAt = (offsetMs: number): string =>
  new Date(START_MS + offsetMs).toISOString();

const evidenceBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  repo: REPO,
  collectedAt: TEST_START_ISO,
  windowDays: 14,
  authors: [
    {
      name: "Robin",
      email: "robin@example.com",
      latestCommitAt: isoAt(-2 * MS_PER_DAY),
      commitCount: 5,
    },
  ],
  ...overrides,
});

const postEvidence = async (
  { harness, developer }: HarnessWithSession,
  body: Record<string, unknown>,
): Promise<string> => {
  const response = await postRecords(harness, developer, {
    records: [recordEnvelope("commit_evidence", body)],
  });
  expect(response.status).toBe(200);
  return response.data?.results[0]?.status ?? "missing";
};

const allRows = async ({ harness }: HarnessWithSession) =>
  harness.db.select().from(commitEvidence);

/**
 * The clock is the adversary here: both wire timestamps are sender-controlled,
 * and a value far enough in the future used to freeze or poison the row for
 * good — greatest() could never be overtaken and the age prune never fired.
 */
describe("commit_evidence clock discipline", () => {
  test("clamps a fast-clocked collectedAt so honest reports still update the row", async () => {
    // Arrange: a connector three days fast reports first
    const setup = await createHarnessWithSession();
    await postEvidence(
      setup,
      evidenceBody({
        collectedAt: isoAt(3 * MS_PER_DAY),
        authors: [
          {
            name: "Robin (skewed)",
            email: "robin@example.com",
            latestCommitAt: isoAt(-2 * MS_PER_DAY),
            commitCount: 5,
          },
        ],
      }),
    );
    const skewed = await allRows(setup);
    expect(skewed[0]?.collectedAt.getTime()).toBeLessThanOrEqual(
      START_MS + MAX_COMMIT_CLOCK_SKEW_MS,
    );

    // Act: an honest collection three minutes later
    setup.harness.clock.advanceSeconds(180);
    const status = await postEvidence(
      setup,
      evidenceBody({ collectedAt: isoAt(180_000) }),
    );

    // Assert: the honest report wins instead of being a silent no-op
    expect(status).toBe("accepted");
    const rows = await allRows(setup);
    expect(rows.length).toBe(1);
    expect(rows[0]?.authorName).toBe("Robin");
    expect(rows[0]?.collectedAt.toISOString()).toBe(isoAt(180_000));
  });

  test("clamps a forged future latestCommitAt at ingest", async () => {
    // Arrange: internally consistent record — collectedAt and latestCommitAt
    // both a year ahead — so the wire schema's relative bound passes and only
    // the hub's own clock can call the forgery out.
    const setup = await createHarnessWithSession();

    // Act
    const status = await postEvidence(
      setup,
      evidenceBody({
        collectedAt: isoAt(365 * MS_PER_DAY),
        authors: [
          {
            name: "Victim",
            email: "victim@example.com",
            latestCommitAt: isoAt(365 * MS_PER_DAY),
            commitCount: 1,
          },
        ],
      }),
    );

    // Assert: nothing stored may claim a timestamp past now + skew
    expect(status).toBe("accepted");
    const rows = await allRows(setup);
    expect(rows.length).toBe(1);
    expect(rows[0]?.latestCommitAt.getTime()).toBeLessThanOrEqual(
      START_MS + MAX_COMMIT_CLOCK_SKEW_MS,
    );
    expect(rows[0]?.collectedAt.getTime()).toBeLessThanOrEqual(
      START_MS + MAX_COMMIT_CLOCK_SKEW_MS,
    );
  });

  test("prunes rows claiming future timestamps on the next ingest", async () => {
    // Arrange: a poisoned row written before the ingest clamp existed —
    // inserted directly, the way a pre-clamp hub would have stored it.
    const setup = await createHarnessWithSession();
    await setup.harness.db.insert(commitEvidence).values({
      repo: REPO,
      authorEmail: "victim@example.com",
      authorName: "Victim",
      latestCommitAt: new Date(START_MS + 365 * MS_PER_DAY),
      commitCount: 1,
      windowDays: 14,
      collectedAt: new Date(START_MS + 365 * MS_PER_DAY),
      reportedBy: setup.developer.developerId,
    });

    // Act: any honest ingest for the repo sweeps it out
    await postEvidence(setup, evidenceBody());

    // Assert: the age prune alone would never fire — a future timestamp is
    // never older than the cutoff — so future rows must be pruned as such.
    const rows = await allRows(setup);
    expect(rows.map((row) => row.authorEmail)).toEqual(["robin@example.com"]);
  });
});
