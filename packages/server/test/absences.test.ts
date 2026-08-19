import { describe, expect, test } from "bun:test";

import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createHarnessWithSession,
  createTestDeveloper,
  jsonRequest,
  postRecords,
  recordEnvelope,
} from "./helpers.ts";
import type { HarnessWithSession } from "./helpers.ts";

const REPO = "github.com/acme/api";
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const isoAt = (offsetMs: number): string =>
  new Date(new Date(TEST_START_ISO).getTime() + offsetMs).toISOString();

interface AbsenceView {
  readonly kind: string;
  readonly name: string;
  readonly latestCommitAt: string;
  readonly lastSessionAt: string | null;
  readonly evidenceCollectedAt: string;
}

const ingestEvidence = async (
  setup: HarnessWithSession,
  authors: readonly Record<string, unknown>[],
  collectedAt: string = TEST_START_ISO,
): Promise<void> => {
  const response = await postRecords(setup.harness, setup.developer, {
    records: [
      recordEnvelope("commit_evidence", {
        repo: REPO,
        collectedAt,
        windowDays: 14,
        authors,
      }),
    ],
  });
  expect(response.status).toBe(200);
  expect(response.data?.accepted).toBe(1);
};

const fetchAbsences = async (
  setup: HarnessWithSession,
): Promise<{ status: number; raw: string; absences: AbsenceView[] }> => {
  const response = await setup.harness.app.request(
    `/api/absences?repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", setup.developer.apiKey),
  );
  const raw = await response.text();
  if (response.status !== 200) {
    return { status: response.status, raw, absences: [] };
  }
  const body = JSON.parse(raw) as { data: { absences: AbsenceView[] } };
  return { status: response.status, raw, absences: body.data.absences };
};

describe("GET /api/absences", () => {
  test("a member with commits and no session on the repo is 'inactive'", async () => {
    // Arrange: Robin is a hub member (mixed-case email) with recent commits
    // but has never reported a session on this repo.
    const setup = await createHarnessWithSession();
    await createTestDeveloper(setup.harness, "Robin", "Robin@Example.com");
    await ingestEvidence(setup, [
      {
        name: "robin-git",
        email: "robin@example.com",
        latestCommitAt: isoAt(-2 * MS_PER_DAY),
        commitCount: 7,
      },
    ]);

    // Act
    const { status, absences } = await fetchAbsences(setup);

    // Assert: hub identity name, not the git author string
    expect(status).toBe(200);
    expect(absences.length).toBe(1);
    expect(absences[0]?.kind).toBe("inactive");
    expect(absences[0]?.name).toBe("Robin");
    expect(absences[0]?.lastSessionAt).toBeNull();
    expect(absences[0]?.latestCommitAt).toBe(isoAt(-2 * MS_PER_DAY));
  });

  test("a commit author with no hub membership is 'unconnected', not 'inactive'", async () => {
    // Arrange
    const setup = await createHarnessWithSession();
    await ingestEvidence(setup, [
      {
        name: "Sam Stranger",
        email: "sam@external.example",
        latestCommitAt: isoAt(-1 * MS_PER_DAY),
        commitCount: 2,
      },
    ]);

    // Act
    const { absences } = await fetchAbsences(setup);

    // Assert
    expect(absences.length).toBe(1);
    expect(absences[0]?.kind).toBe("unconnected");
    expect(absences[0]?.name).toBe("Sam Stranger");
    expect(absences[0]?.lastSessionAt).toBeNull();
  });

  test("a member matched via an ALIAS email is a member, never 'unconnected'", async () => {
    // Arrange: Robin's git commits carry a personal address the admin linked
    // as an alias (trial finding #7 — two of three trial members commit under
    // an email that is not their hub email).
    const setup = await createHarnessWithSession();
    const robin = await createTestDeveloper(
      setup.harness,
      "Robin",
      "robin@example.com",
    );
    const linked = await setup.harness.app.request(
      `/api/developers/${encodeURIComponent(robin.developerId)}/emails`,
      jsonRequest("POST", TEST_ADMIN_TOKEN, { email: "Robin.Personal@GMail.com" }),
    );
    expect(linked.status).toBe(200);
    await ingestEvidence(setup, [
      {
        name: "robin-laptop",
        email: "robin.personal@gmail.com",
        latestCommitAt: isoAt(-2 * MS_PER_DAY),
        commitCount: 4,
      },
    ]);

    // Act
    const { absences } = await fetchAbsences(setup);

    // Assert: hub member identity, not a "no crosscheck account" noise line
    expect(absences.length).toBe(1);
    expect(absences[0]?.kind).toBe("inactive");
    expect(absences[0]?.name).toBe("Robin");
  });

  test("a member whose commit falls inside the grace window stays silent", async () => {
    // Arrange: the reporting developer's own commit, one hour before their
    // registered session — committing around a session is the normal workflow.
    const setup = await createHarnessWithSession();
    await ingestEvidence(setup, [
      {
        name: "Nick",
        email: "nick@example.com",
        latestCommitAt: isoAt(-1 * MS_PER_HOUR),
        commitCount: 3,
      },
    ]);

    // Act
    const { absences } = await fetchAbsences(setup);

    // Assert
    expect(absences).toEqual([]);
  });

  test("a member whose newest commit postdates their last session by days fires", async () => {
    // Arrange: session registered at T0; commits continue until T0+3d with no
    // further reported session.
    const setup = await createHarnessWithSession();
    setup.harness.clock.advanceSeconds(3 * 24 * 3600);
    await ingestEvidence(
      setup,
      [
        {
          name: "Nick",
          email: "nick@example.com",
          latestCommitAt: isoAt(3 * MS_PER_DAY),
          commitCount: 9,
        },
      ],
      isoAt(3 * MS_PER_DAY),
    );

    // Act
    const { absences } = await fetchAbsences(setup);

    // Assert: factual observation with both timestamps, never an accusation
    expect(absences.length).toBe(1);
    expect(absences[0]?.kind).toBe("inactive");
    expect(absences[0]?.lastSessionAt).toBe(TEST_START_ISO);
    expect(absences[0]?.latestCommitAt).toBe(isoAt(3 * MS_PER_DAY));
  });

  test("evidence past the staleness bound fires nothing", async () => {
    // Arrange
    const setup = await createHarnessWithSession();
    await createTestDeveloper(setup.harness, "Robin", "robin@example.com");
    await ingestEvidence(setup, [
      {
        name: "robin-git",
        email: "robin@example.com",
        latestCommitAt: isoAt(-2 * MS_PER_DAY),
        commitCount: 7,
      },
    ]);

    // Act: eight days later the collection has never been refreshed
    setup.harness.clock.advanceSeconds(8 * 24 * 3600);
    const { absences } = await fetchAbsences(setup);

    // Assert
    expect(absences).toEqual([]);
  });

  test("a commit older than the scan window is history, not absence", async () => {
    // Arrange
    const setup = await createHarnessWithSession();
    await createTestDeveloper(setup.harness, "Robin", "robin@example.com");
    await ingestEvidence(setup, [
      {
        name: "robin-git",
        email: "robin@example.com",
        latestCommitAt: isoAt(-20 * MS_PER_DAY),
        commitCount: 1,
      },
    ]);

    // Act
    const { absences } = await fetchAbsences(setup);

    // Assert
    expect(absences).toEqual([]);
  });

  test("a forged future commit date cannot pin a member absent once honest evidence returns", async () => {
    // Arrange: Nick has a live session at T0. A forged record — internally
    // consistent, so the wire schema passes — claims his newest commit is a
    // year ahead. Then an honest re-scan reports the real newest commit.
    const setup = await createHarnessWithSession();
    await ingestEvidence(
      setup,
      [
        {
          name: "Nick",
          email: "nick@example.com",
          latestCommitAt: isoAt(365 * MS_PER_DAY),
          commitCount: 1,
        },
      ],
      isoAt(365 * MS_PER_DAY),
    );
    setup.harness.clock.advanceSeconds(3600);
    await ingestEvidence(
      setup,
      [
        {
          name: "Nick",
          email: "nick@example.com",
          latestCommitAt: TEST_START_ISO,
          commitCount: 1,
        },
      ],
      isoAt(1 * MS_PER_HOUR),
    );

    // Act
    const { absences } = await fetchAbsences(setup);

    // Assert: the forged timestamp must not outlive the honest report — a
    // commit inside the grace window of his session stays silent.
    expect(absences).toEqual([]);
  });

  test("the response never carries an email address", async () => {
    // Arrange: both finding kinds present
    const setup = await createHarnessWithSession();
    await createTestDeveloper(setup.harness, "Robin", "robin@example.com");
    await ingestEvidence(setup, [
      {
        name: "robin-git",
        email: "robin@example.com",
        latestCommitAt: isoAt(-2 * MS_PER_DAY),
        commitCount: 7,
      },
      {
        name: "Sam Stranger",
        email: "sam@external.example",
        latestCommitAt: isoAt(-1 * MS_PER_DAY),
        commitCount: 2,
      },
    ]);

    // Act
    const { raw, absences } = await fetchAbsences(setup);

    // Assert: emails are the server-side matching key and nothing more
    expect(absences.length).toBe(2);
    expect(raw).not.toContain("@");
  });

  test("rejects a missing repo query", async () => {
    // Arrange
    const setup = await createHarnessWithSession();

    // Act
    const response = await setup.harness.app.request(
      "/api/absences",
      jsonRequest("GET", setup.developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(400);
  });
});
