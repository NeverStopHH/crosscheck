/**
 * REVIEW H3, THE `agent_event` HALF: the rung folds over the sessions the
 * answer itself names, beside its own heartbeat window — the scope the
 * `order` block already read.
 *
 * An answer picks its sessions by its own predicate: trace by work-context
 * activity, which an update from a successor session keeps inside the window
 * (updates never re-home a work context), while the rung reads heartbeats. A
 * rung that read the window alone said `complete / sessions_reported` — and
 * `isJudgeable` yes — beside an answer naming a session it never looked at,
 * and that session could be the one observed worst.
 *
 * EVERY CASE HERE FALLS ONE WAY. A named session may move the rung towards
 * `incomplete`; it never moves it towards `complete`.
 */
import { describe, expect, test } from "bun:test";

import { COVERAGE_SESSION_WINDOW_DAYS } from "../src/constants.ts";
import { agentSessions, commitEvidence } from "../src/db/schema.ts";
import { isJudgeable, readCoverage } from "../src/services/coverage.ts";
import type { CoverageRecord, CoverageSourceRecord } from "../src/services/coverage.ts";
import {
  TEST_START_ISO,
  VALID_SESSION_BODY,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DAY_SECONDS = DAY_MS / 1000;
/** Past the coverage window, which is suspect's window too. */
const OUTSIDE_WINDOW_DAYS = COVERAGE_SESSION_WINDOW_DAYS + 6;
const OLD_SESSION = "ses_old";
/** The old session's last heartbeat: the clock never moves in the unit cases. */
const OLD_HEARTBEAT = new Date(Date.parse(TEST_START_ISO) - OUTSIDE_WINDOW_DAYS * DAY_MS);
const OLD_LOSS_FROM = new Date(OLD_HEARTBEAT.getTime() - HOUR_MS);

const seed = async (): Promise<{ harness: TestHarness; developer: TestDeveloper }> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick@example.com");
  return { harness, developer };
};

/** A session last heard from outside the window, ended cleanly unless the case says otherwise. */
const insertOldSession = async (
  harness: TestHarness,
  developer: TestDeveloper,
  overrides: Partial<typeof agentSessions.$inferInsert> = {},
): Promise<void> => {
  await harness.db.insert(agentSessions).values({
    id: OLD_SESSION,
    developerId: developer.developerId,
    agentKind: "claude-code",
    repo: REPO,
    branch: "main",
    baseCommit: "a1b2c3d4",
    status: "analyzing",
    startedAt: new Date(OLD_HEARTBEAT.getTime() - HOUR_MS),
    lastHeartbeatAt: OLD_HEARTBEAT,
    endedAt: OLD_HEARTBEAT,
    ...overrides,
  });
};

/** The loss columns of a report whose every instant predates the window. */
const OLD_LOSS = {
  lossReportedAt: OLD_HEARTBEAT,
  lossTotal: 5,
  lossKinds: { spool_expired: 5 },
  lossOldestAt: OLD_LOSS_FROM,
  lossNewestAt: OLD_HEARTBEAT,
} as const;

/** Fresh commits by the viewer, who reported a session: the git rung reads complete. */
const insertReportedCommits = async (harness: TestHarness, developer: TestDeveloper): Promise<void> => {
  const now = harness.clock.now().getTime();
  await harness.db.insert(commitEvidence).values({
    repo: REPO,
    authorEmail: "nick@example.com",
    authorName: "nick-git",
    latestCommitAt: new Date(now - 2 * HOUR_MS),
    commitCount: 3,
    windowDays: COVERAGE_SESSION_WINDOW_DAYS,
    collectedAt: new Date(now - HOUR_MS),
    reportedBy: developer.developerId,
  });
};

const coverageOf = (
  harness: TestHarness,
  developer: TestDeveloper,
  answerSessionIds?: readonly string[],
): Promise<CoverageRecord> =>
  readCoverage(
    { db: harness.db, now: harness.clock.now },
    developer.developerId,
    REPO,
    answerSessionIds === undefined ? {} : { answerSessionIds },
  );

const agentEventOf = (record: CoverageRecord): CoverageSourceRecord => {
  const row = record.sources.find((entry) => entry.source === "agent_event");
  if (row === undefined) {
    throw new Error("agent_event row missing");
  }
  return row;
};

describe("a named session the window left out weakens the rung", () => {
  test("a named session reaped outside the window turns a judgeable record incomplete / session_reaped", async () => {
    // Arrange: a clean session in the window, the viewer's commits reported,
    // and a session the hub reaped twenty days ago.
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    await insertReportedCommits(harness, developer);
    await insertOldSession(harness, developer, {
      reapedAt: new Date(OLD_HEARTBEAT.getTime() + HOUR_MS),
    });
    // Act
    const unnamed = await coverageOf(harness, developer);
    const named = await coverageOf(harness, developer, [OLD_SESSION]);
    // Assert
    expect(agentEventOf(unnamed).state).toBe("complete");
    expect(isJudgeable(unnamed)).toBe(true);
    expect(agentEventOf(named)).toMatchObject({
      state: "incomplete",
      reason: "session_reaped",
      gapSince: OLD_HEARTBEAT.toISOString(),
    });
    expect(isJudgeable(named)).toBe(false);
  });

  test("a named session that went silent outside the window reads incomplete / session_silent", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    await insertOldSession(harness, developer, { endedAt: null });
    // Act
    const named = await coverageOf(harness, developer, [OLD_SESSION]);
    // Assert
    expect(agentEventOf(named)).toMatchObject({
      state: "incomplete",
      reason: "session_silent",
      gapSince: OLD_HEARTBEAT.toISOString(),
    });
  });

  test("a named session's loss counts though it predates the window — the answer cites that session's records", async () => {
    // Arrange: ended cleanly, so the loss is the only thing wrong with it.
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    await insertOldSession(harness, developer, OLD_LOSS);
    // Act
    const unnamed = await coverageOf(harness, developer);
    const named = await coverageOf(harness, developer, [OLD_SESSION]);
    // Assert
    expect(agentEventOf(unnamed).state).toBe("complete");
    expect(agentEventOf(named)).toMatchObject({
      state: "incomplete",
      reason: "telemetry_lost",
      gapSince: OLD_LOSS_FROM.toISOString(),
    });
  });

  test("a named session's ignored kind keeps its own word whenever it was ignored", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    await insertOldSession(harness, developer, {
      ...OLD_LOSS,
      lossKinds: { hub_ignored: 5 },
      lossIgnoredAt: OLD_HEARTBEAT,
    });
    // Act
    const named = await coverageOf(harness, developer, [OLD_SESSION]);
    // Assert
    expect(agentEventOf(named)).toMatchObject({
      state: "incomplete",
      reason: "record_kinds_ignored",
    });
  });
});

describe("a named session never strengthens the rung", () => {
  test("a named session that ended cleanly leaves a complete rung exactly as it was", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey);
    await insertOldSession(harness, developer);
    // Act
    const unnamed = await coverageOf(harness, developer);
    const named = await coverageOf(harness, developer, [OLD_SESSION]);
    // Assert
    expect(agentEventOf(named)).toEqual(agentEventOf(unnamed));
    expect(agentEventOf(named).state).toBe("complete");
  });

  test("a named clean session cannot turn an empty window complete", async () => {
    // Arrange: nobody reported inside the window; the answer names a session
    // that ended cleanly twenty days ago.
    const { harness, developer } = await seed();
    await insertOldSession(harness, developer);
    // Act
    const named = await coverageOf(harness, developer, [OLD_SESSION]);
    // Assert
    expect(agentEventOf(named)).toMatchObject({
      state: "unknown",
      reason: "no_session_in_window",
    });
  });

  test("a named gap session on an empty window reads incomplete, never complete", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await insertOldSession(harness, developer, { endedAt: null });
    // Act
    const named = await coverageOf(harness, developer, [OLD_SESSION]);
    // Assert
    expect(agentEventOf(named)).toMatchObject({
      state: "incomplete",
      reason: "session_silent",
    });
  });
});

describe("every answer that names sessions passes them", () => {
  const touchAuth = (
    harness: TestHarness,
    developer: TestDeveloper,
    sessionId: string,
    workContextId: string,
  ): Promise<unknown> =>
    postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: workContextId, sessionId }), {
          sessionId,
        }),
        recordEnvelope("target", { workContextId, kind: "file", value: "src/auth.ts" }, { sessionId }),
      ],
    });

  const bodyOf = async <T>(harness: TestHarness, developer: TestDeveloper, url: string): Promise<T> => {
    const response = await harness.app.request(url, jsonRequest("GET", developer.apiKey));
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: T }).data;
  };

  test("trace names a candidate whose heartbeat left the window, and its rung reads that session", async () => {
    // Arrange: a session touched the file twenty days ago and never ended; a
    // successor updated its work context inside the window; a third session
    // touched the same file today and is live.
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey, { id: OLD_SESSION });
    await touchAuth(harness, developer, OLD_SESSION, "wc_old");
    harness.clock.advanceSeconds(OUTSIDE_WINDOW_DAYS * DAY_SECONDS);
    await registerTestSession(harness, developer.apiKey, { id: "ses_new" });
    await postRecords(harness, developer, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: "wc_old", sessionId: OLD_SESSION, title: "Login 500s, again" }),
          { sessionId: "ses_new" },
        ),
      ],
    });
    await registerTestSession(harness, developer.apiKey, { id: "ses_c" });
    await touchAuth(harness, developer, "ses_c", "wc_c");
    // Act
    const data = await bodyOf<{ candidates: { sessionId: string }[]; coverage: CoverageRecord }>(
      harness,
      developer,
      `/api/suspect?repo=${encodeURIComponent(REPO)}&path=src/auth.ts`,
    );
    // Assert
    expect(data.candidates.map((candidate) => candidate.sessionId)).toContain(OLD_SESSION);
    expect(agentEventOf(data.coverage)).toMatchObject({
      state: "incomplete",
      reason: "session_reaped",
    });
  });
});
