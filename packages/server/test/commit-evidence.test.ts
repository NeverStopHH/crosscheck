import { describe, expect, test } from "bun:test";

import { commitEvidence } from "../src/db/schema.ts";
import {
  TEST_START_ISO,
  createHarnessWithSession,
  postRecords,
  recordEnvelope,
} from "./helpers.ts";
import type { HarnessWithSession } from "./helpers.ts";

const REPO = "github.com/acme/api";
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const isoAt = (offsetMs: number): string =>
  new Date(new Date(TEST_START_ISO).getTime() + offsetMs).toISOString();

const evidenceBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  repo: REPO,
  collectedAt: TEST_START_ISO,
  windowDays: 14,
  authors: [
    {
      name: "Robin",
      email: "Robin@Example.com",
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

describe("commit_evidence ingest", () => {
  test("accepts evidence and stores one row per author, email lowercased", async () => {
    // Arrange
    const setup = await createHarnessWithSession();

    // Act
    const status = await postEvidence(setup, evidenceBody());

    // Assert
    expect(status).toBe("accepted");
    const rows = await allRows(setup);
    expect(rows.length).toBe(1);
    expect(rows[0]?.repo).toBe(REPO);
    expect(rows[0]?.authorEmail).toBe("robin@example.com");
    expect(rows[0]?.authorName).toBe("Robin");
    expect(rows[0]?.commitCount).toBe(5);
    expect(rows[0]?.latestCommitAt.toISOString()).toBe(isoAt(-2 * MS_PER_DAY));
  });

  test("a replayed older collection never regresses the stored row", async () => {
    // Arrange: fresh collection first, then a spool replay of an older one
    const setup = await createHarnessWithSession();
    await postEvidence(setup, evidenceBody());

    // Act
    const status = await postEvidence(
      setup,
      evidenceBody({
        collectedAt: isoAt(-3 * MS_PER_DAY),
        authors: [
          {
            name: "Robin (old)",
            email: "robin@example.com",
            latestCommitAt: isoAt(-9 * MS_PER_DAY),
            commitCount: 1,
          },
        ],
      }),
    );

    // Assert: the fresher collection's reading stands untouched
    expect(status).toBe("accepted");
    const rows = await allRows(setup);
    expect(rows.length).toBe(1);
    expect(rows[0]?.authorName).toBe("Robin");
    expect(rows[0]?.latestCommitAt.toISOString()).toBe(isoAt(-2 * MS_PER_DAY));
    expect(rows[0]?.collectedAt.toISOString()).toBe(TEST_START_ISO);
  });

  test("a fresher collection updates the row but keeps the newest commit timestamp", async () => {
    // Arrange: the older collection saw a commit the fresher one no longer
    // covers (its window slid); the newest commit timestamp must survive.
    // The hub clock advances with the fresher collection — a collectedAt
    // ahead of the hub's own clock would be clamped as skew, deliberately
    // (commit-evidence-clock.test.ts).
    const setup = await createHarnessWithSession();
    await postEvidence(setup, evidenceBody());
    setup.harness.clock.advanceSeconds(3600);

    // Act
    const status = await postEvidence(
      setup,
      evidenceBody({
        collectedAt: isoAt(MS_PER_HOUR),
        authors: [
          {
            name: "Robin R.",
            email: "robin@example.com",
            latestCommitAt: isoAt(-5 * MS_PER_DAY),
            commitCount: 2,
          },
        ],
      }),
    );

    // Assert
    expect(status).toBe("accepted");
    const rows = await allRows(setup);
    expect(rows.length).toBe(1);
    expect(rows[0]?.authorName).toBe("Robin R.");
    expect(rows[0]?.collectedAt.toISOString()).toBe(isoAt(MS_PER_HOUR));
    expect(rows[0]?.latestCommitAt.toISOString()).toBe(isoAt(-2 * MS_PER_DAY));
  });

  test("prunes rows whose newest commit fell out of the retention window", async () => {
    // Arrange: one author far beyond retention, stored by an earlier ingest
    const setup = await createHarnessWithSession();
    await postEvidence(
      setup,
      evidenceBody({
        authors: [
          {
            name: "Ghost",
            email: "ghost@example.com",
            latestCommitAt: isoAt(-40 * MS_PER_DAY),
            commitCount: 1,
          },
        ],
      }),
    );

    // Act: the next ingest for the repo sweeps expired rows out
    setup.harness.clock.advanceSeconds(60);
    await postEvidence(setup, evidenceBody());

    // Assert
    const rows = await allRows(setup);
    expect(rows.map((row) => row.authorEmail)).toEqual(["robin@example.com"]);
  });
});
