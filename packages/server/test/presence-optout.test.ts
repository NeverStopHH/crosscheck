/**
 * Presence opt-out enforcement (DESIGN.md §2.1, §10 risk 3): an opted-out
 * developer's LIVE presence disappears from every surface OTHER developers
 * see — the presence list, the PreToolUse tripwire, absence "inactive"
 * findings, and every event-feed row attributed to them (knowledge kinds
 * included — feed timestamps are an activity timeline). Their own view of
 * themselves is
 * unaffected, and published knowledge (work contexts, claims, search rows)
 * is NOT retracted — the control covers the surveillance surface, not
 * authorship.
 *
 * Enforcement is HUB-side: every test here reads the raw API as another
 * developer, so a hostile or modified connector cannot see what these pins
 * hide (task item 4).
 */
import { describe, expect, test } from "bun:test";

import {
  TEST_START_ISO,
  createTestHarness,
  createTestDeveloper,
  fetchEvents,
  fetchPresence,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const TARGET_FILE = "src/auth/refresh.ts";
const MS_PER_DAY = 86_400_000;

const isoAt = (offsetMs: number): string =>
  new Date(new Date(TEST_START_ISO).getTime() + offsetMs).toISOString();

const setOptOut = async (
  harness: TestHarness,
  developer: TestDeveloper,
  optOut: boolean,
): Promise<void> => {
  const response = await harness.app.request(
    "/api/settings/presence",
    jsonRequest("PUT", developer.apiKey, { optOut }),
  );
  expect(response.status).toBe(200);
};

/** Robin: hub member with an active session and a file-targeting context. */
const seedRobinSession = async (
  harness: TestHarness,
): Promise<TestDeveloper> => {
  const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
  await registerTestSession(harness, robin.apiKey, { id: "ses_robin" });
  const seeded = await postRecords(harness, robin, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: "wc_robin", sessionId: "ses_robin" }),
        { sessionId: "ses_robin" },
      ),
      recordEnvelope(
        "target",
        { workContextId: "wc_robin", kind: "file", value: TARGET_FILE },
        { sessionId: "ses_robin" },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_robin",
          workContextId: "wc_robin",
          authorSessionId: "ses_robin",
        }),
        { sessionId: "ses_robin" },
      ),
    ],
  });
  expect(seeded.data?.accepted).toBe(3);
  return robin;
};

const fetchTripwireSessions = async (
  harness: TestHarness,
  developer: TestDeveloper,
  value: string,
): Promise<readonly { sessionId: string }[]> => {
  const params = new URLSearchParams({ repo: REPO, value });
  const response = await harness.app.request(
    `/api/hints/tripwire?${params.toString()}`,
    jsonRequest("GET", developer.apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { sessions: readonly { sessionId: string }[] };
  };
  return body.data.sessions;
};

describe("presence opt-out: the presence list", () => {
  test("an opted-out developer's sessions vanish from other developers' raw reads, not their own", async () => {
    // Arrange: Nick views, Robin has the only active session
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const robin = await seedRobinSession(harness);

    const before = await fetchPresence(harness, nick.apiKey);
    expect(before.sessions.map((entry) => entry.developerName)).toEqual([
      "Robin",
    ]);

    // Act
    await setOptOut(harness, robin, true);

    // Assert: hidden from Nick, still visible to Robin themself
    const after = await fetchPresence(harness, nick.apiKey);
    expect(after.sessions).toEqual([]);
    const own = await fetchPresence(harness, robin.apiKey);
    expect(own.sessions.map((entry) => entry.isSelf)).toEqual([true]);

    // Act + Assert: opting back in restores the surface
    await setOptOut(harness, robin, false);
    const restored = await fetchPresence(harness, nick.apiKey);
    expect(restored.sessions.map((entry) => entry.developerName)).toEqual([
      "Robin",
    ]);
  });
});

describe("presence opt-out: the PreToolUse tripwire", () => {
  test("an opted-out developer's active sessions never trigger asks on teammates", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const robin = await seedRobinSession(harness);
    const before = await fetchTripwireSessions(harness, nick, TARGET_FILE);
    expect(before.map((entry) => entry.sessionId)).toEqual(["ses_robin"]);

    // Act
    await setOptOut(harness, robin, true);

    // Assert
    const after = await fetchTripwireSessions(harness, nick, TARGET_FILE);
    expect(after).toEqual([]);
  });
});

describe("presence opt-out: absence findings", () => {
  const ingestEvidence = async (
    harness: TestHarness,
    reporter: TestDeveloper,
  ): Promise<void> => {
    const response = await postRecords(harness, reporter, {
      records: [
        recordEnvelope("commit_evidence", {
          repo: REPO,
          collectedAt: TEST_START_ISO,
          windowDays: 14,
          authors: [
            {
              name: "robin-git",
              email: "robin@example.com",
              latestCommitAt: isoAt(-2 * MS_PER_DAY),
              commitCount: 7,
            },
          ],
        }),
      ],
    });
    expect(response.data?.accepted).toBe(1);
  };

  const fetchAbsences = async (
    harness: TestHarness,
    developer: TestDeveloper,
  ): Promise<readonly { name: string; kind: string }[]> => {
    const response = await harness.app.request(
      `/api/absences?repo=${encodeURIComponent(REPO)}`,
      jsonRequest("GET", developer.apiKey),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { absences: readonly { name: string; kind: string }[] };
    };
    return body.data.absences;
  };

  test("'inactive' lines about an opted-out member disappear for teammates but not for the member", async () => {
    // Arrange: Robin is a member with commits and no reported session
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    const robin = await createTestDeveloper(
      harness,
      "Robin",
      "robin@example.com",
    );
    await ingestEvidence(harness, nick);
    const before = await fetchAbsences(harness, nick);
    expect(before.map((entry) => entry.name)).toEqual(["Robin"]);

    // Act
    await setOptOut(harness, robin, true);

    // Assert: absence reporting IS presence surveillance — hidden from Nick,
    // still visible to Robin about themself.
    expect(await fetchAbsences(harness, nick)).toEqual([]);
    const own = await fetchAbsences(harness, robin);
    expect(own.map((entry) => entry.name)).toEqual(["Robin"]);
  });
});

describe("presence opt-out: session lifecycle events", () => {
  test("session_started/session_ended events of an opted-out developer are hidden from other developers' reads", async () => {
    // Arrange: Robin registers and ends a session, then opts out
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const robin = await createTestDeveloper(
      harness,
      "Robin",
      "robin@example.com",
    );
    await registerTestSession(harness, robin.apiKey, { id: "ses_robin" });
    await harness.app.request(
      "/api/sessions/ses_robin/end",
      jsonRequest("POST", robin.apiKey, {}),
    );
    await setOptOut(harness, robin, true);

    // Act
    const nickEvents = await fetchEvents(harness, nick.apiKey);
    const robinEvents = await fetchEvents(harness, robin.apiKey);

    // Assert: Nick sees no session lifecycle rows about Robin, while rows
    // attributed to HIMSELF keep flowing (the attributed-feed pin below
    // covers the knowledge kinds); Robin's own view keeps their own rows.
    const sessionKinds = ["session_started", "session_ended"];
    const nickSessionRows = nickEvents.filter((event) =>
      sessionKinds.includes(event.kind),
    );
    expect(nickSessionRows).toEqual([]);
    expect(
      nickEvents.filter(
        (event) =>
          event.kind === "developer_created" &&
          event.payload["developerId"] === nick.developerId,
      ).length,
    ).toBe(1);
    const robinSessionRows = robinEvents.filter((event) =>
      sessionKinds.includes(event.kind),
    );
    expect(robinSessionRows.length).toBe(2);
  });
});

describe("presence opt-out: the whole attributed event feed", () => {
  /** Rows on the events feed attributed to one developer, any kind. */
  const attributedTo = (
    eventRows: readonly { kind: string; payload: Record<string, unknown> }[],
    developerId: string,
  ): readonly { kind: string; payload: Record<string, unknown> }[] =>
    eventRows.filter((event) => event.payload["developerId"] === developerId);

  const ROBIN_FEED_KINDS = [
    "developer_created",
    "session_started",
    "work_context_created",
    "claim_added",
  ];

  test("knowledge events of an opted-out developer stop leaking their live activity timeline", async () => {
    // Arrange: Robin's session publishes a work context and a claim — every
    // one of those rows carries Robin's developerId and a server timestamp,
    // so together they ARE a live activity timeline, session kinds or not.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const robin = await seedRobinSession(harness);
    const before = await fetchEvents(harness, nick.apiKey);
    expect(
      attributedTo(before, robin.developerId).map((event) => event.kind),
    ).toEqual(ROBIN_FEED_KINDS);

    // Act
    await setOptOut(harness, robin, true);

    // Assert: NO row attributed to Robin — of ANY kind — reaches Nick; a
    // kind-scoped filter would leave work_context_created as a start-of-work
    // presence signal on the raw feed a modified connector reads.
    const after = await fetchEvents(harness, nick.apiKey);
    expect(attributedTo(after, robin.developerId)).toEqual([]);
    // Nick's own rows keep flowing ...
    expect(
      attributedTo(after, nick.developerId).length,
    ).toBeGreaterThan(0);
    // ... and Robin's own view of their own feed is unaffected.
    const own = await fetchEvents(harness, robin.apiKey);
    expect(
      attributedTo(own, robin.developerId).map((event) => event.kind),
    ).toEqual(ROBIN_FEED_KINDS);

    // Act + Assert: live switch — opting back in restores every hidden row.
    await setOptOut(harness, robin, false);
    const restored = await fetchEvents(harness, nick.apiKey);
    expect(
      attributedTo(restored, robin.developerId).map((event) => event.kind),
    ).toEqual(ROBIN_FEED_KINDS);
  });
});

describe("presence opt-out does NOT retract published knowledge", () => {
  test("work contexts, claims, and search rows stay visible and attributed", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const robin = await seedRobinSession(harness);

    // Act
    await setOptOut(harness, robin, true);

    // Assert: the work-contexts listing keeps the row, attributed
    const listing = await harness.app.request(
      `/api/work-contexts?repo=${encodeURIComponent(REPO)}`,
      jsonRequest("GET", nick.apiKey),
    );
    expect(listing.status).toBe(200);
    const listingBody = (await listing.json()) as {
      data: {
        workContexts: readonly { id: string; developerName: string }[];
      };
    };
    expect(
      listingBody.data.workContexts.map((entry) => entry.developerName),
    ).toEqual(["Robin"]);

    // Assert: the diagnosis tree keeps Robin's claim, attributed
    const diagnosis = await harness.app.request(
      "/api/work-contexts/wc_robin/diagnosis",
      jsonRequest("GET", nick.apiKey),
    );
    expect(diagnosis.status).toBe(200);
    const diagnosisBody = (await diagnosis.json()) as {
      data: { claims: readonly { authorDeveloperName: string }[] };
    };
    expect(
      diagnosisBody.data.claims.map((claim) => claim.authorDeveloperName),
    ).toEqual(["Robin"]);

    // Assert: search still returns the context
    const params = new URLSearchParams({ query: TARGET_FILE, repo: REPO });
    const search = await harness.app.request(
      `/api/search?${params.toString()}`,
      jsonRequest("GET", nick.apiKey),
    );
    expect(search.status).toBe(200);
    const searchBody = (await search.json()) as {
      data: { results: readonly { id: string }[] };
    };
    expect(searchBody.data.results.map((row) => row.id)).toEqual(["wc_robin"]);
  });
});
