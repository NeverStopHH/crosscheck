/**
 * landed_evidence ingest — DESIGN.md §5 merged-branch detection, hub side.
 *
 * The connector reports COMMITS it proved to be ancestors of the default
 * branch; the hub maps them to work contexts through the owning session's
 * base_commit and stamps landed_at. A column, not a status transition: the
 * session status enum records what the developer's session was doing, and a
 * landed context keeps that history — see services/landed.ts for the full
 * reasoning. Claims stay append-only and untouched.
 *
 * ONLY A BASE THAT REACHED THE DEFAULT BRANCH AFTER ITS SESSION REGISTERED
 * IS EVIDENCE (pilot finding, 2026-10-05). A teammate's report stamped every
 * open context whose base commit was an ancestor of main — the owner's
 * long-lived session detached at a six-week-old commit included — and the
 * stamp took his 180 captured files out of ghost checks and the conference
 * while a teammate edited the same files.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { LANDED_UNFLAGGED_FALLBACK_ENDS_AT } from "../src/constants.ts";
import { agentSessions } from "../src/db/schema.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const BASE_COMMIT = VALID_SESSION_BODY.baseCommit;

/** The owner's real shape: a long-lived worktree detached at an old main commit. */
const STALE_BASE = "51eae4d8f0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5";
const DETACHED_BRANCH = "detached@51eae4d8f";
/** Six weeks before the context opened (TEST_START_ISO). */
const STALE_COMMITTED_AT = "2026-06-12T09:00:00.000Z";
/** An hour before the context opened: the session's own branch tip. */
const FRESH_COMMITTED_AT = "2026-07-24T08:00:00.000Z";
/** Five days after the context opened; five days before a re-register ten days in. */
const FIVE_DAYS_AFTER_START = "2026-07-29T09:00:00.000Z";
const TEN_DAYS_S = 10 * 86_400;

/** A session whose connector said its base was NOT on the default branch. */
const NEW_WORK = { baseOnDefault: false } as const;

const landedEvidenceBody = (
  commits: readonly string[],
  commitDates?: readonly { sha: string; committedAt: string }[],
): Record<string, unknown> => ({
  repo: REPO,
  defaultBranch: "origin/main",
  checkedAt: TEST_START_ISO,
  commits,
  ...(commitDates === undefined ? {} : { commitDates }),
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

const landedAtOf = async (
  harness: TestHarness,
  apiKey: string,
  id: string = WORK_CONTEXT_ID,
): Promise<string | null | undefined> =>
  (await listContexts(harness, apiKey)).find((entry) => entry.id === id)?.landedAt;

const seedContext = async (
  harness: TestHarness,
  developer: TestDeveloper,
  overrides: Record<string, unknown> = {},
): Promise<void> => {
  const posted = await postRecords(harness, developer, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody(overrides),
        { sessionId: String(overrides["sessionId"] ?? VALID_SESSION_BODY.id) },
      ),
    ],
  });
  expect(posted.data?.accepted).toBe(1);
};

const report = async (
  harness: TestHarness,
  developer: TestDeveloper,
  body: Record<string, unknown>,
  sessionId: string = VALID_SESSION_BODY.id,
): Promise<void> => {
  const posted = await postRecords(harness, developer, {
    records: [recordEnvelope("landed_evidence", body, { sessionId })],
  });
  expect(posted.data?.accepted).toBe(1);
};

/** A teammate on a real feature branch — the only kind that still reports. */
const addReporter = (harness: TestHarness): Promise<TestDeveloper> =>
  addTestDeveloperWithSession(harness, "Robin", "robin@example.com", {
    id: "ses_robin",
    branch: "feat/robin-cache",
    baseCommit: "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff",
    ...NEW_WORK,
  });

describe("landed evidence", () => {
  test("a reported ancestor commit marks the matching context landed", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession(NEW_WORK);
    await seedContext(harness, developer);

    // Act
    await report(harness, developer, landedEvidenceBody([BASE_COMMIT]));

    // Assert: the listing shows when it was observed landed — plus the base
    // commit the connector's own landed check reads.
    const contexts = await listContexts(harness, developer.apiKey);
    const context = contexts.find((entry) => entry.id === WORK_CONTEXT_ID);
    expect(context?.landedAt).toBe(TEST_START_ISO);
    expect(context?.baseCommit).toBe(BASE_COMMIT);
  });

  test("landing is monotonic — a later report does not move landedAt", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession(NEW_WORK);
    await seedContext(harness, developer);
    await report(harness, developer, landedEvidenceBody([BASE_COMMIT]));

    // Act: a fresh report a day later.
    harness.clock.advanceSeconds(86_400);
    await report(harness, developer, landedEvidenceBody([BASE_COMMIT]));

    // Assert: the first observation stands — git ancestry never un-happens.
    expect(await landedAtOf(harness, developer.apiKey)).toBe(TEST_START_ISO);
  });

  test("a commit matching no session leaves every context open", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession(NEW_WORK);
    await seedContext(harness, developer);

    // Act
    await report(harness, developer, landedEvidenceBody(["deadbeef1"]));

    // Assert
    expect(await landedAtOf(harness, developer.apiKey)).toBeNull();
  });

  test("a commit on another repo's session does not land this repo's context", async () => {
    // Arrange: same base commit sha, different repo in the report.
    const { harness, developer } = await createHarnessWithSession(NEW_WORK);
    await seedContext(harness, developer);

    // Act
    await report(harness, developer, {
      ...landedEvidenceBody([BASE_COMMIT]),
      repo: "github.com/acme/web",
    });

    // Assert: the mapping is (repo, base_commit), not the sha alone.
    expect(await landedAtOf(harness, developer.apiKey)).toBeNull();
  });

  test("any hub member's report lands another developer's context", async () => {
    // Arrange: git ancestry is checkable from any clone, so evidence is not
    // owner-gated — same trust model as commit evidence for absences.
    const { harness, developer } = await createHarnessWithSession(NEW_WORK);
    await seedContext(harness, developer);
    const teammate = await addReporter(harness);

    // Act
    await report(harness, teammate, landedEvidenceBody([BASE_COMMIT]), "ses_robin");

    // Assert
    expect(await landedAtOf(harness, developer.apiKey)).toBe(TEST_START_ISO);
  });

  test("the diagnosis carries landedAt, the base commit, and the tree's file targets", async () => {
    // Arrange: what the connector's solved-tree presentation needs at pull
    // time — drift (baseCommit), the landed fact, and the referenced files
    // for the staleness check.
    const { harness, developer } = await createHarnessWithSession(NEW_WORK);
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

describe("only the session's own work landing stamps it", () => {
  test("a detached-at-ancestor context is never stamped by a teammate's report", async () => {
    // Arrange: the pilot incident. Three of the owner's worktree sessions sit
    // detached at the same old main commit — one from a current connector
    // (it said the base was already on main), one from an older connector
    // (it said nothing), and one whose connector said "not on main" (a
    // detached checkout of a commit main did not yet hold). The teammate's
    // report even dates the base as fresh, so neither the flag nor the date
    // is what refuses it.
    const { harness, developer } = await createHarnessWithSession({
      branch: DETACHED_BRANCH,
      baseCommit: STALE_BASE,
      baseOnDefault: true,
    });
    await registerTestSession(harness, developer.apiKey, {
      id: "ses_old_connector",
      branch: DETACHED_BRANCH,
      baseCommit: STALE_BASE,
    });
    await registerTestSession(harness, developer.apiKey, {
      id: "ses_detached_new_work",
      branch: DETACHED_BRANCH,
      baseCommit: STALE_BASE,
      ...NEW_WORK,
    });
    await seedContext(harness, developer);
    await seedContext(harness, developer, { id: "wc_old", sessionId: "ses_old_connector" });
    await seedContext(harness, developer, { id: "wc_new", sessionId: "ses_detached_new_work" });
    const teammate = await addReporter(harness);

    // Act
    await report(
      harness,
      teammate,
      landedEvidenceBody([STALE_BASE], [{ sha: STALE_BASE, committedAt: FRESH_COMMITTED_AT }]),
      "ses_robin",
    );

    // Assert: all three stay visible to every collision check.
    expect(await landedAtOf(harness, developer.apiKey)).toBeNull();
    expect(await landedAtOf(harness, developer.apiKey, "wc_old")).toBeNull();
    expect(await landedAtOf(harness, developer.apiKey, "wc_new")).toBeNull();
  });

  test("a base the connector said was already on the default branch is never stamped", async () => {
    // Arrange: a feature branch cut from main with no commit of its own yet —
    // its HEAD is main's, so it is an ancestor from the first second.
    const { harness, developer } = await createHarnessWithSession({ baseOnDefault: true });
    await seedContext(harness, developer);
    const teammate = await addReporter(harness);

    // Act
    await report(
      harness,
      teammate,
      landedEvidenceBody([BASE_COMMIT], [{ sha: BASE_COMMIT, committedAt: FRESH_COMMITTED_AT }]),
      "ses_robin",
    );

    // Assert
    expect(await landedAtOf(harness, developer.apiKey)).toBeNull();
  });

  test("the hub stores what the connector said, and keeps it across a re-register of the same base", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession({ baseOnDefault: true });
    const flagOf = async (): Promise<boolean | null | undefined> =>
      (
        await harness.db
          .select({ flag: agentSessions.baseOnDefault })
          .from(agentSessions)
          .where(eq(agentSessions.id, VALID_SESSION_BODY.id))
      )[0]?.flag;
    const stored = await flagOf();

    // Act: a SessionStart re-fire that did not (or could not) say again.
    await registerTestSession(harness, developer.apiKey);
    const keptOnSameBase = await flagOf();
    await registerTestSession(harness, developer.apiKey, { baseCommit: "feedface1234" });
    const droppedOnNewBase = await flagOf();

    // Assert: unsaid about a NEW base means unknown, never the old answer.
    expect(stored).toBe(true);
    expect(keptOnSameBase).toBe(true);
    expect(droppedOnNewBase).toBeNull();
  });
});

describe("a base that was on the default branch already, however it got there", () => {
  test("a session ON the default branch is never stamped, whatever its connector said", async () => {
    // Arrange: two sessions on `main` — a current connector that said "not
    // on main" (an unpushed local commit, say) and an older one with a
    // fresh-dated base. The report names origin/main.
    const { harness, developer } = await createHarnessWithSession({ branch: "main", ...NEW_WORK });
    await registerTestSession(harness, developer.apiKey, { id: "ses_main_old", branch: "main", baseCommit: STALE_BASE });
    await seedContext(harness, developer);
    await seedContext(harness, developer, { id: "wc_main_old", sessionId: "ses_main_old" });
    const teammate = await addReporter(harness);

    // Act
    await report(
      harness,
      teammate,
      landedEvidenceBody([BASE_COMMIT, STALE_BASE], [{ sha: STALE_BASE, committedAt: FRESH_COMMITTED_AT }]),
      "ses_robin",
    );

    // Assert
    expect(await landedAtOf(harness, developer.apiKey)).toBeNull();
    expect(await landedAtOf(harness, developer.apiKey, "wc_main_old")).toBeNull();
  });

  test("a base's age is judged against when the session took it, not when its context opened", async () => {
    // Arrange: an older connector's session opened its context ten days ago
    // on base A, then re-registered today on base B — a commit five days old
    // that it pulled. Measured from the context, B is younger than the work;
    // measured from when the session took it, B is a five-day-old checkout.
    const { harness, developer } = await createHarnessWithSession({ baseCommit: BASE_COMMIT });
    await seedContext(harness, developer);
    harness.clock.advanceSeconds(TEN_DAYS_S);
    await registerTestSession(harness, developer.apiKey, { baseCommit: STALE_BASE });
    const teammate = await addReporter(harness);

    // Act
    await report(
      harness,
      teammate,
      landedEvidenceBody([STALE_BASE], [{ sha: STALE_BASE, committedAt: FIVE_DAYS_AFTER_START }]),
      "ses_robin",
    );

    // Assert
    expect(await landedAtOf(harness, developer.apiKey)).toBeNull();
  });

  test("the hub stores when a session's base last changed, and only a new base moves it", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    const changedAt = async (): Promise<string | undefined> =>
      (
        await harness.db
          .select({ at: agentSessions.baseChangedAt })
          .from(agentSessions)
          .where(eq(agentSessions.id, VALID_SESSION_BODY.id))
      )[0]?.at?.toISOString();
    const registered = await changedAt();

    // Act: a re-fire on the same base, then a pull onto a new one.
    harness.clock.advanceSeconds(3_600);
    await registerTestSession(harness, developer.apiKey);
    const sameBase = await changedAt();
    harness.clock.advanceSeconds(3_600);
    await registerTestSession(harness, developer.apiKey, { baseCommit: STALE_BASE });
    const newBase = await changedAt();

    // Assert
    expect(registered).toBe(TEST_START_ISO);
    expect(sameBase).toBe(TEST_START_ISO);
    expect(newBase).toBe(harness.clock.now().toISOString());
  });
});

describe("a connector from before the flag", () => {
  test("after the fallback's end date, an unflagged session never lands by ancestry", async () => {
    // Arrange: a fresh-dated branch tip, reported after
    // LANDED_UNFLAGGED_FALLBACK_ENDS_AT. Until then this lands (the next test).
    const { harness, developer } = await createHarnessWithSession({ baseCommit: STALE_BASE });
    await seedContext(harness, developer);
    const teammate = await addReporter(harness);
    harness.clock.advanceSeconds(
      (Date.parse(LANDED_UNFLAGGED_FALLBACK_ENDS_AT) - Date.parse(TEST_START_ISO)) / 1000,
    );

    // Act
    await report(
      harness,
      teammate,
      { ...landedEvidenceBody([STALE_BASE], [{ sha: STALE_BASE, committedAt: FRESH_COMMITTED_AT }]), checkedAt: harness.clock.now().toISOString() },
      "ses_robin",
    );

    // Assert
    expect(await landedAtOf(harness, developer.apiKey)).toBeNull();
  });

  test("a stale base is not stamped — an old checkout is not new work", async () => {
    // Arrange: no flag, on a named branch; the base was committed six weeks
    // before the context opened.
    const { harness, developer } = await createHarnessWithSession({ baseCommit: STALE_BASE });
    await seedContext(harness, developer);
    const teammate = await addReporter(harness);

    // Act
    await report(
      harness,
      teammate,
      landedEvidenceBody([STALE_BASE], [{ sha: STALE_BASE, committedAt: STALE_COMMITTED_AT }]),
      "ses_robin",
    );

    // Assert
    expect(await landedAtOf(harness, developer.apiKey)).toBeNull();
  });

  test("a base committed just before the context opened still lands", async () => {
    // Arrange: the session's own branch tip, an hour before it started.
    const { harness, developer } = await createHarnessWithSession({ baseCommit: STALE_BASE });
    await seedContext(harness, developer);
    const teammate = await addReporter(harness);

    // Act
    await report(
      harness,
      teammate,
      landedEvidenceBody([STALE_BASE], [{ sha: STALE_BASE, committedAt: FRESH_COMMITTED_AT }]),
      "ses_robin",
    );

    // Assert
    expect(await landedAtOf(harness, developer.apiKey)).toBe(TEST_START_ISO);
  });

  test("a report that cannot date the base lands nothing — unknown age is not evidence", async () => {
    // Arrange: an older reporter too, so nobody can say how old the base is.
    const { harness, developer } = await createHarnessWithSession({ baseCommit: STALE_BASE });
    await seedContext(harness, developer);
    const teammate = await addReporter(harness);

    // Act
    await report(harness, teammate, landedEvidenceBody([STALE_BASE]), "ses_robin");

    // Assert
    expect(await landedAtOf(harness, developer.apiKey)).toBeNull();
  });
});
