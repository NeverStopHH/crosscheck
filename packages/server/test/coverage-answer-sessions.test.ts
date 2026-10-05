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
  validClaimBody,
  validClaimEdgeBody,
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

});

describe("a loss report is the machine's ledger, so naming a session moves no loss window (LOSS-4)", () => {
  const ANCIENT = new Date(Date.parse(TEST_START_ISO) - 300 * DAY_MS);

  test("a loss older than the window is no gap for a named session either", async () => {
    // Arrange: today's live session re-reports a 300-day-old machine loss, and
    // a session that ended twenty days ago carries one from before the window.
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey, {
      losses: {
        total: 3,
        kinds: { spool_expired: 3 },
        oldestAt: ANCIENT.toISOString(),
        newestAt: ANCIENT.toISOString(),
      },
    });
    await insertOldSession(harness, developer, OLD_LOSS);
    // Act
    const unnamed = await coverageOf(harness, developer);
    const named = await coverageOf(harness, developer, [VALID_SESSION_BODY.id, OLD_SESSION]);
    // Assert
    expect(agentEventOf(named)).toEqual(agentEventOf(unnamed));
    expect(agentEventOf(named)).toMatchObject({ state: "complete", reason: "sessions_reported" });
  });

  test("an ignored kind from before the window cannot take the word from yesterday's reap", async () => {
    // Arrange: a session reaped inside the window, and a live session whose
    // report carries a 300-day-old ignored kind.
    const { harness, developer } = await seed();
    const now = harness.clock.now().getTime();
    const reapedHeartbeat = new Date(now - 24 * HOUR_MS);
    const live = {
      developerId: developer.developerId,
      agentKind: "claude-code",
      repo: REPO,
      branch: "main",
      baseCommit: "a1b2c3d4",
      status: "analyzing",
    } as const;
    await harness.db.insert(agentSessions).values([
      {
        ...live,
        id: "ses_reaped",
        startedAt: new Date(now - 30 * HOUR_MS),
        lastHeartbeatAt: reapedHeartbeat,
        endedAt: new Date(now - 18 * HOUR_MS),
        reapedAt: new Date(now - 18 * HOUR_MS),
      },
      {
        ...live,
        id: "ses_live",
        startedAt: new Date(now - HOUR_MS),
        lastHeartbeatAt: new Date(now - 10_000),
        lossReportedAt: new Date(now - HOUR_MS),
        lossTotal: 2,
        lossKinds: { hub_ignored: 2 },
        lossOldestAt: ANCIENT,
        lossNewestAt: ANCIENT,
        lossIgnoredAt: ANCIENT,
      },
    ]);
    // Act
    const named = await coverageOf(harness, developer, ["ses_live"]);
    // Assert
    expect(agentEventOf(named)).toMatchObject({
      state: "incomplete",
      reason: "session_reaped",
      gapSince: reapedHeartbeat.toISOString(),
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

  const endCleanly = async (
    harness: TestHarness,
    developer: TestDeveloper,
    sessionId: string,
  ): Promise<void> => {
    const response = await harness.app.request(
      `/api/sessions/${sessionId}/end`,
      jsonRequest("POST", developer.apiKey, { status: "done" }),
    );
    expect(response.status).toBe(200);
  };

  /** Twenty days on, a clean session reports inside the window; the tree's sessions are reaped. */
  const diagnosisLater = async (
    harness: TestHarness,
    developer: TestDeveloper,
  ): Promise<{
    workContext: { sessionId: string };
    claims: { authorSessionId: string }[];
    edges: { authorSessionId: string }[];
    coverage: CoverageRecord;
  }> => {
    harness.clock.advanceSeconds(OUTSIDE_WINDOW_DAYS * DAY_SECONDS);
    await registerTestSession(harness, developer.apiKey, { id: "ses_c" });
    return bodyOf(harness, developer, "/api/work-contexts/wc_old/diagnosis?telemetry=0");
  };

  test("get_diagnosis reads the tree's owning session, wherever its heartbeat sits", async () => {
    // Arrange: the tree's session went quiet twenty days ago.
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey, { id: OLD_SESSION });
    await touchAuth(harness, developer, OLD_SESSION, "wc_old");
    // Act
    const data = await diagnosisLater(harness, developer);
    // Assert
    expect(data.workContext.sessionId).toBe(OLD_SESSION);
    expect(agentEventOf(data.coverage)).toMatchObject({
      state: "incomplete",
      reason: "session_reaped",
    });
  });

  test("get_diagnosis reads the session that wrote a claim in the tree, not only its owner", async () => {
    // Arrange: the owner ended cleanly; a second session wrote a claim into
    // its tree and went quiet; both twenty days ago.
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey, { id: OLD_SESSION });
    await touchAuth(harness, developer, OLD_SESSION, "wc_old");
    await endCleanly(harness, developer, OLD_SESSION);
    await registerTestSession(harness, developer.apiKey, { id: "ses_author" });
    await postRecords(harness, developer, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({ workContextId: "wc_old", authorSessionId: "ses_author" }),
          { sessionId: "ses_author" },
        ),
      ],
    });
    // Act
    const data = await diagnosisLater(harness, developer);
    // Assert
    expect(data.claims.map((claim) => claim.authorSessionId)).toEqual(["ses_author"]);
    expect(agentEventOf(data.coverage)).toMatchObject({
      state: "incomplete",
      reason: "session_reaped",
    });
  });

  test("get_diagnosis reads the session that wrote an edge in the tree", async () => {
    // Arrange: the owner wrote two claims and ended cleanly; a second session
    // linked them and went quiet; both twenty days ago.
    const { harness, developer } = await seed();
    await registerTestSession(harness, developer.apiKey, { id: OLD_SESSION });
    await touchAuth(harness, developer, OLD_SESSION, "wc_old");
    const ownClaim = (id: string, body: string): Record<string, unknown> =>
      recordEnvelope(
        "claim",
        validClaimBody({ id, body, workContextId: "wc_old", authorSessionId: OLD_SESSION }),
        { sessionId: OLD_SESSION },
      );
    await postRecords(harness, developer, {
      records: [
        ownClaim("clm_01", "JWT validation fails after token refresh"),
        ownClaim("clm_02", "the refresh handler drops the signing key"),
      ],
    });
    await endCleanly(harness, developer, OLD_SESSION);
    await registerTestSession(harness, developer.apiKey, { id: "ses_linker" });
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("claim_edge", validClaimEdgeBody({ authorSessionId: "ses_linker" }), {
          sessionId: "ses_linker",
        }),
      ],
    });
    // Act
    const data = await diagnosisLater(harness, developer);
    // Assert
    expect(data.edges.map((edge) => edge.authorSessionId)).toEqual(["ses_linker"]);
    expect(agentEventOf(data.coverage)).toMatchObject({
      state: "incomplete",
      reason: "session_reaped",
    });
  });

  test("a machine loss from before the window is no gap beside a tripwire or a trace that names the session", async () => {
    // Arrange: Ken's live session is on the file, and its report re-states a
    // loss his machine's ledger has held for 300 days.
    const { harness, developer } = await seed();
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
    const ancient = new Date(harness.clock.now().getTime() - 300 * DAY_MS).toISOString();
    await registerTestSession(harness, ken.apiKey, {
      id: "ses_ken",
      losses: { total: 3, kinds: { spool_expired: 3 }, oldestAt: ancient, newestAt: ancient },
    });
    await touchAuth(harness, ken, "ses_ken", "wc_ken");
    // Act
    const tripwire = await bodyOf<{ sessions: { sessionId: string }[]; coverage: CoverageRecord }>(
      harness,
      developer,
      `/api/hints/tripwire?repo=${encodeURIComponent(REPO)}&value=src/auth.ts`,
    );
    const trace = await bodyOf<{ candidates: { sessionId: string }[]; coverage: CoverageRecord }>(
      harness,
      developer,
      `/api/suspect?repo=${encodeURIComponent(REPO)}&path=src/auth.ts`,
    );
    // Assert
    expect(tripwire.sessions.map((session) => session.sessionId)).toEqual(["ses_ken"]);
    expect(trace.candidates.map((candidate) => candidate.sessionId)).toEqual(["ses_ken"]);
    expect(agentEventOf(tripwire.coverage)).toMatchObject({ state: "complete", reason: "sessions_reported" });
    expect(agentEventOf(trace.coverage)).toMatchObject({ state: "complete", reason: "sessions_reported" });
  });

  test("the tripwire's order block reads the session it names, though only a symbol target matched", async () => {
    // Arrange: the tripwire matches a target's value whatever its kind, the
    // rung's path scope reads file targets only. Ken's session declared nothing.
    const { harness, developer } = await seed();
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
    await registerTestSession(harness, ken.apiKey, { id: "ses_ken" });
    await postRecords(harness, ken, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_ken", sessionId: "ses_ken" }), {
          sessionId: "ses_ken",
        }),
        recordEnvelope("target", { workContextId: "wc_ken", kind: "symbol", value: "src/auth.ts" }, {
          sessionId: "ses_ken",
        }),
      ],
    });
    // Act
    const data = await bodyOf<{ sessions: { sessionId: string }[]; coverage: CoverageRecord }>(
      harness,
      developer,
      `/api/hints/tripwire?repo=${encodeURIComponent(REPO)}&value=src/auth.ts`,
    );
    // Assert
    expect(data.sessions.map((session) => session.sessionId)).toEqual(["ses_ken"]);
    expect(data.coverage.order).toEqual({ state: "undeclared", reason: "provider_undeclared" });
  });
});
