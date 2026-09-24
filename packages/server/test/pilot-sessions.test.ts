/**
 * ONE SESSION'S RESIDUE (1.0 spec 07 §3.6).
 *
 * The handover asked for six things per session; five are already stored or
 * recomputable. These two are not, and the harder one is the sequence.
 *
 * `seq` IS A PAIR — an epoch and a number (01 §3.1) — and the case that
 * matters is the session whose counter RESTARTED. Across two epochs,
 * `first .. last` is not a span: it is two unrelated counters subtracted from
 * each other, and printing that number would be a confident statement about
 * work nobody can order. The refusal is 01's, arriving at the counting layer
 * rather than being re-argued here.
 *
 * `end_reason` keeps a reported end apart from an inferred one because the
 * trial found 104 of 127 sessions never closed: folding them would count
 * mostly the second and call it the first.
 */
import { describe, expect, test } from "bun:test";

import { agentSessions, pilotCounters, pilotSessions } from "../src/db/schema.ts";
import { PILOT_MAX_SESSIONS } from "../src/constants.ts";
import { recordPilotSession } from "../src/services/pilot.ts";
import { recordSessionEvent } from "../src/services/session-events.ts";
import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  registerTestSession,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const SESSION = "cc_11111111-2222-4333-8444-555555555555";
const NOW = new Date(TEST_START_ISO);

const setup = async (
  options: { readonly enrolled: boolean } = { enrolled: true },
): Promise<{ harness: TestHarness; developer: TestDeveloper }> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick-psessions@example.com",
  );
  await registerTestSession(harness, developer.apiKey, {
    id: SESSION,
    repo: REPO,
  });
  if (options.enrolled) {
    await harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: true }),
    );
  }
  return { harness, developer };
};

const deps = (harness: TestHarness) => ({
  db: harness.db,
  now: () => NOW,
});

/** One event on this session's counter, positioned or not. */
const seedEvent = async (
  harness: TestHarness,
  epoch: string | null,
  n: number | null,
  refId: string,
): Promise<void> => {
  await recordSessionEvent(deps(harness), {
    sessionId: SESSION,
    kind: "file.modified",
    ...(epoch === null || n === null
      ? // An emitter that could not allocate — one of the real ways a record
        // arrives with no place in the order (01 §3.4).
        { seq: undefined, absentReason: "allocation_failed" as const }
      : { seq: { epoch, n } }),
    seqKind: "emitted",
    refKind: "session",
    refId,
  });
};

const store = async (
  harness: TestHarness,
  developer: TestDeveloper,
  endReason: "reported" | "reaped" = "reported",
): Promise<void> => {
  await recordPilotSession(deps(harness), {
    sessionId: SESSION,
    repo: REPO,
    developerId: developer.developerId,
    endReason,
  });
};

const rows = (harness: TestHarness) => harness.db.select().from(pilotSessions);

describe("one session's residue", () => {
  test("a repo that never enrolled stores nothing", async () => {
    // Arrange
    const { harness, developer } = await setup({ enrolled: false });

    // Act
    await store(harness, developer);

    // Assert
    expect(await rows(harness)).toHaveLength(0);
  });

  test("a single-epoch session gets its span", async () => {
    // Arrange — positions 1, 2 and 4 on one counter: three events, and one
    // position that never arrived.
    const { harness, developer } = await setup();
    await seedEvent(harness, "ep_a", 1, "a");
    await seedEvent(harness, "ep_a", 2, "b");
    await seedEvent(harness, "ep_a", 4, "c");

    // Act
    await store(harness, developer);

    // Assert
    const stored = await rows(harness);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.seqEpoch).toBe("ep_a");
    expect(stored[0]?.seqFirst).toBe(1);
    expect(stored[0]?.seqLast).toBe(4);
    // A GAP IS A MISSING POSITION: the counter reached four, three arrived.
    expect(stored[0]?.seqGaps).toBe(1);
    expect(stored[0]?.seqEpochs).toBe(1);
  });

  test("a RESTARTED counter refuses the span rather than inventing one", async () => {
    // Arrange — the case this column exists for. Two epochs means `first`
    // and `last` belong to different counters, and their difference is a
    // confident number about work nobody can order.
    const { harness, developer } = await setup();
    await seedEvent(harness, "ep_a", 7, "a");
    await seedEvent(harness, "ep_b", 1, "b");

    // Act
    await store(harness, developer);

    // Assert
    const stored = await rows(harness);
    expect(stored[0]?.seqEpochs).toBe(2);
    expect(stored[0]?.seqFirst).toBeNull();
    expect(stored[0]?.seqLast).toBeNull();
    expect(stored[0]?.seqGaps).toBeNull();
    expect(stored[0]?.seqEpoch).toBeNull();
  });

  test("unpositioned records are COUNTED, not skipped", async () => {
    // Arrange — a session with half its events unordered must not look like
    // one with all of them ordered.
    //
    // THREE, NOT TWO, and the third is the point: registering the session
    // appends its own `session.started`, and the test helper sends no
    // position with it. The count is over every event on this session, not
    // only the ones a test remembered to seed — which is what makes it a
    // measurement of the instrumentation rather than of the fixture.
    const { harness, developer } = await setup();
    await seedEvent(harness, "ep_a", 1, "a");
    await seedEvent(harness, null, null, "b");
    await seedEvent(harness, null, null, "c");

    // Act
    await store(harness, developer);

    // Assert
    expect((await rows(harness))[0]?.seqNullRecords).toBe(3);
  });

  test("a reported end and an inferred one are different facts", async () => {
    // Arrange — the trial found 104 of 127 sessions never closed, so folding
    // these would count mostly the second and call it the first.
    const { harness, developer } = await setup();

    // Act
    await store(harness, developer, "reaped");

    // Assert
    expect((await rows(harness))[0]?.endReason).toBe("reaped");
  });

  test("coverage is stored as five enum-only triples, with no instants", async () => {
    // Arrange — non-negotiable 6: what is stored is what the hub SAID, in
    // words it chose. A `gapSince` here would be an instant about a session
    // that has ended.
    const { harness, developer } = await setup();

    // Act
    await store(harness, developer);

    // Assert
    const coverage = (await rows(harness))[0]?.coverage as readonly Record<
      string,
      unknown
    >[];
    expect(coverage).toHaveLength(5);
    for (const row of coverage) {
      expect(Object.keys(row).sort()).toEqual(["reason", "source", "state"]);
    }
  });

  test("the 51st is REFUSED and COUNTED, never dropped silently", async () => {
    // Arrange — fill the set by hand rather than by registering fifty
    // sessions: the cap is what is under test, not the registration path.
    // A measurement that hit its own ceiling and said nothing would report
    // fifty sessions as though that were the population.
    const { harness, developer } = await setup();
    const filler = Array.from({ length: PILOT_MAX_SESSIONS }, (_unused, i) => ({
      id: `cc_fill_${String(i)}`,
      developerId: developer.developerId,
      agentKind: "claude-code",
      repo: REPO,
      branch: "main",
      baseCommit: "abc1234",
      status: "done" as const,
      startedAt: NOW,
      lastHeartbeatAt: NOW,
    }));
    await harness.db.insert(agentSessions).values(filler);
    await harness.db.insert(pilotSessions).values(
      filler.map((row) => ({
        sessionId: row.id,
        repo: REPO,
        observedAt: NOW,
        endReason: "reported" as const,
        coverage: [],
        seqNullRecords: 0,
        seqEpochs: 0,
      })),
    );

    // Act — the fifty-first
    await store(harness, developer);

    // Assert — not stored…
    expect(await rows(harness)).toHaveLength(PILOT_MAX_SESSIONS);
    // …and the refusal is a number somebody can read.
    const counters = await harness.db.select().from(pilotCounters);
    const refused = counters.find(
      (row) => row.counter === "pilot_sessions_refused",
    );
    expect(Number(refused?.value ?? 0)).toBe(1);
  });

  test("a revived session's SECOND end is the one that stands", async () => {
    // Arrange — `reviveReapedSession` undoes an inferred end when a record
    // arrives from that session, so the same id reaches this writer twice.
    // The later end is the true one, and there is still exactly one row.
    const { harness, developer } = await setup();
    await store(harness, developer, "reaped");

    // Act
    await store(harness, developer, "reported");

    // Assert
    const stored = await rows(harness);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.endReason).toBe("reported");
  });

  test("a revived session in a FULL set keeps its own slot — its second end is not a refusal", async () => {
    // Arrange — 49 other sessions plus this one, reaped: the set is full, and
    // this session already holds a slot (found by adversarial review)
    const { harness, developer } = await setup();
    const filler = Array.from({ length: PILOT_MAX_SESSIONS - 1 }, (_unused, i) => ({
      id: `cc_fill_${String(i)}`,
      developerId: developer.developerId,
      agentKind: "claude-code",
      repo: REPO,
      branch: "main",
      baseCommit: "abc1234",
      status: "done" as const,
      startedAt: NOW,
      lastHeartbeatAt: NOW,
    }));
    await harness.db.insert(agentSessions).values(filler);
    await harness.db.insert(pilotSessions).values(
      filler.map((row) => ({
        sessionId: row.id,
        repo: REPO,
        observedAt: NOW,
        endReason: "reported" as const,
        coverage: [],
        seqNullRecords: 0,
        seqEpochs: 0,
      })),
    );
    await store(harness, developer, "reaped");

    // Act — revived, then ended for real
    await store(harness, developer, "reported");

    // Assert
    const own = (await rows(harness)).find((row) => row.sessionId === SESSION);
    expect(own?.endReason).toBe("reported");
    const refused = (await harness.db.select().from(pilotCounters)).find(
      (row) => row.counter === "pilot_sessions_refused",
    );
    expect(refused).toBeUndefined();
  });
});

