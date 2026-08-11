/**
 * landed_evidence ingest — DESIGN.md §5 merged-branch detection, hub side.
 *
 * The connector reports COMMITS it proved to be ancestors of the default
 * branch; the hub maps them to work contexts through the owning session's
 * base_commit and stamps landed_at. A column, not a status transition: the
 * session status enum records what the developer's session was doing, and a
 * landed context keeps that history — see services/landed.ts for the full
 * reasoning. Claims stay append-only and untouched.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  TEST_START_ISO,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const BASE_COMMIT = VALID_SESSION_BODY.baseCommit;

const landedEvidenceBody = (
  commits: readonly string[],
): Record<string, unknown> => ({
  repo: REPO,
  defaultBranch: "origin/main",
  checkedAt: TEST_START_ISO,
  commits,
});

interface ListedContext {
  readonly id: string;
  readonly baseCommit?: string;
  readonly landedAt?: string | null;
}

const listContexts = async (
  harness: TestHarness,
  apiKey: string,
): Promise<readonly ListedContext[]> => {
  const response = await harness.app.request(
    `/api/work-contexts?repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { workContexts: ListedContext[] };
  };
  return body.data.workContexts;
};

const seedContext = async (
  harness: TestHarness,
  developer: TestDeveloper,
): Promise<void> => {
  const posted = await postRecords(harness, developer, {
    records: [recordEnvelope("work_context", validWorkContextBody())],
  });
  expect(posted.data?.accepted).toBe(1);
};

describe("landed evidence", () => {
  test("a reported ancestor commit marks the matching context landed", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await seedContext(harness, developer);

    // Act
    const posted = await postRecords(harness, developer, {
      records: [
        recordEnvelope("landed_evidence", landedEvidenceBody([BASE_COMMIT])),
      ],
    });

    // Assert: accepted, and the listing shows when it was observed landed —
    // plus the base commit the connector's own landed check reads.
    expect(posted.data?.accepted).toBe(1);
    const contexts = await listContexts(harness, developer.apiKey);
    const context = contexts.find((entry) => entry.id === WORK_CONTEXT_ID);
    expect(context?.landedAt).toBe(TEST_START_ISO);
    expect(context?.baseCommit).toBe(BASE_COMMIT);
  });

  test("landing is monotonic — a later report does not move landedAt", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await seedContext(harness, developer);
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("landed_evidence", landedEvidenceBody([BASE_COMMIT])),
      ],
    });

    // Act: a fresh report a day later.
    harness.clock.advanceSeconds(86_400);
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("landed_evidence", landedEvidenceBody([BASE_COMMIT])),
      ],
    });

    // Assert: the first observation stands — git ancestry never un-happens.
    const contexts = await listContexts(harness, developer.apiKey);
    const context = contexts.find((entry) => entry.id === WORK_CONTEXT_ID);
    expect(context?.landedAt).toBe(TEST_START_ISO);
  });

  test("a commit matching no session leaves every context open", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await seedContext(harness, developer);

    // Act
    const posted = await postRecords(harness, developer, {
      records: [
        recordEnvelope("landed_evidence", landedEvidenceBody(["deadbeef1"])),
      ],
    });

    // Assert
    expect(posted.data?.accepted).toBe(1);
    const contexts = await listContexts(harness, developer.apiKey);
    const context = contexts.find((entry) => entry.id === WORK_CONTEXT_ID);
    expect(context?.landedAt).toBeNull();
  });

  test("a commit on another repo's session does not land this repo's context", async () => {
    // Arrange: same base commit sha, different repo in the report.
    const { harness, developer } = await createHarnessWithSession();
    await seedContext(harness, developer);

    // Act
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("landed_evidence", {
          ...landedEvidenceBody([BASE_COMMIT]),
          repo: "github.com/acme/web",
        }),
      ],
    });

    // Assert: the mapping is (repo, base_commit), not the sha alone.
    const contexts = await listContexts(harness, developer.apiKey);
    const context = contexts.find((entry) => entry.id === WORK_CONTEXT_ID);
    expect(context?.landedAt).toBeNull();
  });

  test("any hub member's report lands another developer's context", async () => {
    // Arrange: git ancestry is checkable from any clone, so evidence is not
    // owner-gated — same trust model as commit evidence for absences.
    const { harness, developer } = await createHarnessWithSession();
    await seedContext(harness, developer);
    const teammate = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: "ses_robin" },
    );

    // Act
    const posted = await postRecords(harness, teammate, {
      records: [
        recordEnvelope("landed_evidence", landedEvidenceBody([BASE_COMMIT]), {
          sessionId: "ses_robin",
        }),
      ],
    });

    // Assert
    expect(posted.data?.accepted).toBe(1);
    const contexts = await listContexts(harness, developer.apiKey);
    const context = contexts.find((entry) => entry.id === WORK_CONTEXT_ID);
    expect(context?.landedAt).toBe(TEST_START_ISO);
  });

  test("the diagnosis carries landedAt, the base commit, and the tree's file targets", async () => {
    // Arrange: what the connector's solved-tree presentation needs at pull
    // time — drift (baseCommit), the landed fact, and the referenced files
    // for the staleness check.
    const { harness, developer } = await createHarnessWithSession();
    await seedContext(harness, developer);
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("target", {
          workContextId: WORK_CONTEXT_ID,
          kind: "file",
          value: "src/auth/refresh.ts",
        }),
        recordEnvelope("landed_evidence", landedEvidenceBody([BASE_COMMIT])),
      ],
    });

    // Act
    const response = await harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        workContext: {
          baseCommit?: string;
          landedAt?: string | null;
        };
        targets?: readonly { kind: string; value: string }[];
      };
    };
    expect(body.data.workContext.baseCommit).toBe(BASE_COMMIT);
    expect(body.data.workContext.landedAt).toBe(TEST_START_ISO);
    expect(body.data.targets).toEqual([
      { kind: "file", value: "src/auth/refresh.ts" },
    ]);
  });
});
