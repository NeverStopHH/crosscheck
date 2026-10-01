/**
 * THE FIVE PROOFS, READ BACK (1.0 spec 07 §5, §7).
 *
 * The rows are seeded DIRECTLY rather than through the routes: this is a read
 * model, and the cases that matter turn on exact instants — a target touched
 * one hour after a pointer was opened versus three days after — that a route
 * stamps with its own clock.
 *
 * WHAT THIS FILE HOLDS, by acceptance test:
 *
 *   PIL-1  every channel is its own bucket, `unknown` included, never folded;
 *   PIL-2  an opened pointer is printed WITH the prior work it named;
 *   PIL-4  a surface that counted nothing is `null` — "not instrumented" —
 *          never a row of zeros that reads like a perfect surface;
 *   PIL-5  an attribution only ever made under a gap is EXCLUDED, not scored;
 *   PIL-7  a restarted sequence is counted as restarted, not as a span;
 *
 * and the rule every figure obeys: measured, or `unavailable` with a reason.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  agentSessions,
  hintDeliveries,
  pilotAttributions,
  pilotCounters,
  pilotMarks,
  pilotSessions,
  pinFiles,
  pins,
  teamSettings,
  workContextTargets,
  workContexts,
} from "../src/db/schema.ts";
import {
  PILOT_DISCOVERY_COHORT_SESSIONS,
  PILOT_REPLICATION_COHORT_SESSIONS,
  PILOT_REPORT_MAX_LABEL_REASONS,
  PILOT_SESSION_SET_CAP,
  PILOT_TARGET_INTERVENTION_PRECISION,
} from "../src/constants.ts";
import { readPilotReport } from "../src/services/pilot-report.ts";
import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const NOW = new Date(TEST_START_ISO);
const HOUR = 3_600_000;
const at = (hoursAgo: number): Date => new Date(NOW.getTime() - hoursAgo * HOUR);

interface World {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
}

/**
 * Labels became available this long before the harness clock — far earlier
 * than any session these tests write, unless a test says otherwise, so the
 * labelled figures see every session (07 §12, second review: they count only
 * sessions that started once labels existed).
 */
const LABELS_LONG_AGO_HOURS = 1000;

const setup = async (
  options: { readonly enrolled?: boolean; readonly labelsSinceHoursAgo?: number } = {},
): Promise<World> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick-report@example.com",
  );
  if (options.enrolled ?? true) {
    await harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: true }),
    );
    await harness.db
      .update(teamSettings)
      .set({ pilotLabelsSince: at(options.labelsSinceHoursAgo ?? LABELS_LONG_AGO_HOURS) })
      .where(eq(teamSettings.repo, REPO));
  }
  return { harness, developer };
};

const session = async (world: World, id: string, startedHoursAgo = 100) => {
  await world.harness.db.insert(agentSessions).values({
    id,
    developerId: world.developer.developerId,
    agentKind: "claude-code",
    repo: REPO,
    branch: "main",
    baseCommit: "abc1234",
    status: "implementing",
    startedAt: at(startedHoursAgo),
    lastHeartbeatAt: at(startedHoursAgo),
  });
};

const context = async (
  world: World,
  id: string,
  sessionId: string,
  title: string,
  landedHoursAgo: number | null = null,
) => {
  await world.harness.db.insert(workContexts).values({
    id,
    sessionId,
    title,
    status: "implementing",
    landedAt: landedHoursAgo === null ? null : at(landedHoursAgo),
    createdAt: at(99),
  });
};

const touch = async (
  world: World,
  contextId: string,
  files: readonly string[],
  hoursAgo: number,
) => {
  await world.harness.db.insert(workContextTargets).values(
    files.map((value) => ({
      workContextId: contextId,
      kind: "file" as const,
      value,
      createdAt: at(hoursAgo),
    })),
  );
};

const deliver = async (
  world: World,
  id: string,
  sessionId: string,
  refId: string,
  channel: string,
  deliveredHoursAgo: number,
  pulledHoursAgo: number | null,
) => {
  await world.harness.db.insert(hintDeliveries).values({
    id,
    sessionId,
    refKind: "work_context",
    refId,
    channel: channel as "unknown",
    deliveredAt: at(deliveredHoursAgo),
    pulledAt: pulledHoursAgo === null ? null : at(pulledHoursAgo),
  });
};

const report = (world: World, days = 56) =>
  readPilotReport(
    { db: world.harness.db, now: () => NOW },
    { repo: REPO, days },
  );

/** One human label on one delivery, by the test developer, an hour ago. */
const label = async (
  world: World,
  deliveryId: string,
  mark: "helpful" | "noise" | "unclear" | "off_target",
  reason: string | null = null,
  hoursAgo = 1,
) => {
  await world.harness.db.insert(pilotMarks).values({
    id: `pm_${deliveryId}`,
    repo: REPO,
    refKind: "hint_delivery",
    refId: deliveryId,
    mark,
    markedBy: world.developer.developerId,
    captureMode: "human",
    createdAt: at(hoursAgo),
    reason,
  });
};

/** A finished session in the set, in the cohort named. */
const inCohort = async (
  world: World,
  id: string,
  cohort: "discovery" | "replication" | "legacy",
  epochs = 1,
) => {
  await world.harness.db.insert(pilotSessions).values({
    sessionId: id,
    repo: REPO,
    observedAt: at(10),
    endReason: "reported",
    cohort,
    coverage: [],
    seqNullRecords: 0,
    seqEpochs: epochs,
  });
};

/**
 * `sessions` sessions, `perSession` unsolicited deliveries to each, ids
 * `hd_<session>_<n>`; returns the delivery ids in order.
 */
const interventions = async (
  world: World,
  sessions: number,
  perSession: number,
): Promise<readonly string[]> => {
  await session(world, "s_prior", 100);
  await context(world, "wc_prior", "s_prior", "prior work");
  const ids: string[] = [];
  for (let s = 0; s < sessions; s += 1) {
    await session(world, `s_${String(s)}`, 20);
    for (let n = 0; n < perSession; n += 1) {
      const id = `hd_${String(s)}_${String(n)}`;
      await deliver(world, id, `s_${String(s)}`, "wc_prior", "prompt_hint", 10, null);
      ids.push(id);
    }
  }
  return ids;
};

describe("a repo that never enrolled", () => {
  test("reports nothing measured — and says so on every figure", async () => {
    // Arrange — rows exist, but nobody agreed to be measured
    const world = await setup({ enrolled: false });
    await session(world, "s_a");
    await session(world, "s_b");
    await context(world, "wc_b", "s_b", "prior work");
    await deliver(world, "hd_1", "s_a", "wc_b", "briefing", 50, 49);

    // Act
    const out = await report(world);

    // Assert — not zeros that read as "nothing happened"
    expect(out.enrolled).toBe(false);
    expect(out.duplicateWork.surfaced).toBe(0);
    expect(out.precision.openedPer100).toEqual({
      kind: "unavailable",
      reason: "not_instrumented",
    });
    expect(out.integrity.every((row) => row.counters === null)).toBe(true);
  });
});

describe("proof 1 — duplicate work surfaced", () => {
  test("PIL-1: every channel is its own bucket, unknown included", async () => {
    // Arrange — one delivery per channel, and one with no channel at all
    // (a row older than the column), which must read `unknown`.
    const world = await setup();
    await session(world, "s_a");
    await session(world, "s_b");
    await context(world, "wc_b", "s_b", "prior work");
    await deliver(world, "hd_brief", "s_a", "wc_b", "briefing", 50, null);
    await deliver(world, "hd_hint", "s_a", "wc_b", "prompt_hint", 50, null);
    await deliver(world, "hd_trip", "s_a", "wc_b", "tripwire", 50, null);
    await world.harness.db.insert(hintDeliveries).values({
      id: "hd_old",
      sessionId: "s_a",
      refKind: "work_context",
      refId: "wc_b",
      deliveredAt: at(50),
    });

    // Act
    const out = await report(world);

    // Assert — the buckets add up to the total, and none is folded away
    expect(out.duplicateWork.byChannel).toEqual({
      unknown: 1,
      briefing: 1,
      prompt_hint: 1,
      tripwire: 1,
      suspect: 0,
    });
    expect(out.duplicateWork.surfaced).toBe(4);
  });

  test("PIL-2: an opened pointer names the prior work it pointed at", async () => {
    // Arrange — two sessions opened the same pointer
    const world = await setup();
    await session(world, "s_a");
    await session(world, "s_c");
    await session(world, "s_b");
    await context(world, "wc_b", "s_b", "the session store migration");
    await deliver(world, "hd_1", "s_a", "wc_b", "briefing", 50, 49);
    await deliver(world, "hd_2", "s_c", "wc_b", "prompt_hint", 40, 39);

    // Act
    const out = await report(world);

    // Assert — a number never travels without what it counted
    expect(out.duplicateWork.opened).toBe(2);
    expect(out.duplicateWork.priorWork).toEqual([
      {
        workContextId: "wc_b",
        title: "the session store migration",
        openedBySessions: 2,
      },
    ]);
  });

  test("converged: opened, then worked on the same files within the window", async () => {
    // Arrange — opened 49h ago; two shared files touched 48h ago, inside the
    // 48-hour window after opening.
    const world = await setup();
    await session(world, "s_a");
    await session(world, "s_b");
    await context(world, "wc_a", "s_a", "mine");
    await context(world, "wc_b", "s_b", "prior work");
    await touch(world, "wc_b", ["src/a.ts", "src/b.ts"], 90);
    await deliver(world, "hd_1", "s_a", "wc_b", "briefing", 50, 49);
    await touch(world, "wc_a", ["src/a.ts", "src/b.ts"], 48);

    // Act
    const out = await report(world);

    // Assert
    expect(out.duplicateWork.converged).toBe(1);
    expect(out.duplicateWork.openedAnyway).toBe(0);
  });

  test("work on the same files AFTER the window closed is not convergence", async () => {
    // Arrange — opened 60h ago; the shared files were touched 5h ago, long
    // after the 48 hours in which building on it could be credited to it.
    const world = await setup();
    await session(world, "s_a");
    await session(world, "s_b");
    await context(world, "wc_a", "s_a", "mine");
    await context(world, "wc_b", "s_b", "prior work");
    await touch(world, "wc_b", ["src/a.ts", "src/b.ts"], 90);
    await deliver(world, "hd_1", "s_a", "wc_b", "briefing", 61, 60);
    await touch(world, "wc_a", ["src/a.ts", "src/b.ts"], 5);

    // Act
    const out = await report(world);

    // Assert
    expect(out.duplicateWork.converged).toBe(0);
  });

  test("opened anyway: told, never looked, and did the same work", async () => {
    // Arrange — the pointer was shown and never opened; afterwards the
    // receiving session touched two of the pointed work's files.
    const world = await setup();
    await session(world, "s_a");
    await session(world, "s_b");
    await context(world, "wc_a", "s_a", "mine");
    await context(world, "wc_b", "s_b", "prior work");
    await touch(world, "wc_b", ["src/a.ts", "src/b.ts"], 90);
    await deliver(world, "hd_1", "s_a", "wc_b", "briefing", 50, null);
    await touch(world, "wc_a", ["src/a.ts", "src/b.ts"], 40);

    // Act
    const out = await report(world);

    // Assert — a duplicate investigation, opened anyway
    expect(out.duplicateWork.openedAnyway).toBe(1);
    expect(out.duplicateWork.converged).toBe(0);
  });

  test("overlap from BEFORE the pointer was shown counts toward neither", async () => {
    // Arrange — the receiving session had already touched those files; the
    // pointer changed nothing and cannot be credited or blamed.
    const world = await setup();
    await session(world, "s_a");
    await session(world, "s_b");
    await context(world, "wc_a", "s_a", "mine");
    await context(world, "wc_b", "s_b", "prior work");
    await touch(world, "wc_b", ["src/a.ts", "src/b.ts"], 90);
    await touch(world, "wc_a", ["src/a.ts", "src/b.ts"], 80);
    await deliver(world, "hd_1", "s_a", "wc_b", "briefing", 50, null);

    // Act
    const out = await report(world);

    // Assert
    expect(out.duplicateWork.openedAnyway).toBe(0);
  });
});

describe("proof 2 — collisions", () => {
  test("ghost lines are UNAVAILABLE with their reason, never zero", async () => {
    // Arrange
    const world = await setup();

    // Act
    const out = await report(world);

    // Assert — a zero here would read as "no ghost collisions"
    expect(out.collisions.ghostFlagged).toEqual({
      kind: "unavailable",
      reason: "ghost_lines_not_recorded",
    });
    expect(out.collisions.ciRegressed.kind).toBe("unavailable");
    // Nothing flagged, so "both landed" has no denominator either.
    expect(out.collisions.bothLanded).toEqual({
      kind: "unavailable",
      reason: "nothing_flagged",
    });
  });

  test("a repo whose window held no session able to ask reads unavailable, not zero", async () => {
    // Arrange — only a Cursor session (found by adversarial review: this was
    // a measured 0, which reads as "no collisions")
    const world = await setup();
    await world.harness.db.insert(agentSessions).values({
      id: "s_cursor",
      developerId: world.developer.developerId,
      agentKind: "cursor-ide",
      repo: REPO,
      branch: "main",
      baseCommit: "abc1234",
      status: "implementing",
      startedAt: at(10),
      lastHeartbeatAt: at(10),
    });

    // Act
    const out = await report(world);

    // Assert
    expect(out.collisions.tripwireFlagged).toEqual({
      kind: "unavailable",
      reason: "no_asking_host",
    });
  });

  test("a session that could ask and was never flagged is a measured zero", async () => {
    // Arrange
    const world = await setup();
    await session(world, "s_claude", 10);

    // Act & Assert — here zero means zero
    expect((await report(world)).collisions.tripwireFlagged).toEqual({
      kind: "measured",
      value: 0,
    });
  });

  test("a tripwire flag whose two sides both landed is counted", async () => {
    // Arrange — the receiving session's work and the flagged work both
    // reached the default branch: the collision really happened.
    const world = await setup();
    await session(world, "s_a");
    await session(world, "s_b");
    await context(world, "wc_a", "s_a", "mine", 10);
    await context(world, "wc_b", "s_b", "theirs", 12);
    await deliver(world, "hd_1", "s_a", "wc_b", "tripwire", 50, null);

    // Act
    const out = await report(world);

    // Assert
    expect(out.collisions.tripwireFlagged).toEqual({
      kind: "measured",
      value: 1,
    });
    expect(out.collisions.bothLanded).toEqual({ kind: "measured", value: 1 });
  });
});

/**
 * WHAT COUNTS AS "OPENED", AND WHOSE WORK IT NAMES (corrected by adversarial
 * review). A blanket pull stamp from a later read, a pull that predates its
 * delivery, and a pointer at another repo's work were all read as this repo's
 * evidence of a pointer opened.
 */
describe("proof 1 — what an open is", () => {
  const endSession = async (world: World, id: string, endedHoursAgo: number) => {
    await world.harness.db
      .update(agentSessions)
      .set({ endedAt: at(endedHoursAgo) })
      .where(eq(agentSessions.id, id));
  };

  test("a pull after the receiving session ended is not an open", async () => {
    // Arrange — s_old was shown the pointer, ignored it and did the same
    // work; the developer read the context weeks later from another session,
    // and the legacy stamp marked s_old's delivery too
    const world = await setup();
    await session(world, "s_prior");
    await context(world, "wc_prior", "s_prior", "Widen the filter row");
    await touch(world, "wc_prior", ["src/a.ts", "src/b.ts"], 90);
    await session(world, "s_old", 80);
    await endSession(world, "s_old", 50);
    await context(world, "wc_old", "s_old", "the same work, again");
    await deliver(world, "hd_1", "s_old", "wc_prior", "prompt_hint", 70, 10);
    await touch(world, "wc_old", ["src/a.ts", "src/b.ts"], 60);

    // Act
    const out = await report(world);

    // Assert — not opened, and the duplicate work it did still counts
    expect(out.duplicateWork.opened).toBe(0);
    expect(out.duplicateWork.openedAnyway).toBe(1);
  });

  test("a pull before its delivery is not an open", async () => {
    // Arrange
    const world = await setup();
    await session(world, "s_prior");
    await context(world, "wc_prior", "s_prior", "Widen the filter row");
    await session(world, "s_x");
    await deliver(world, "hd_1", "s_x", "wc_prior", "prompt_hint", 10, 20);

    // Act & Assert
    expect((await report(world)).duplicateWork.opened).toBe(0);
  });

  test("another repo's work is never named as this repo's prior work", async () => {
    // Arrange — a delivery's ref is the client's word; this one points at a
    // work context in a repo that never enrolled
    const world = await setup();
    await world.harness.db.insert(agentSessions).values({
      id: "s_b",
      developerId: world.developer.developerId,
      agentKind: "claude-code",
      repo: "github.com/acme/secret",
      branch: "main",
      baseCommit: "abc1234",
      status: "implementing",
      startedAt: at(100),
      lastHeartbeatAt: at(100),
    });
    await context(world, "wc_b", "s_b", "SECRET-B-TITLE");
    await session(world, "s_x");
    await deliver(world, "hd_1", "s_x", "wc_b", "prompt_hint", 10, 5);

    // Act
    const out = await report(world);

    // Assert
    expect(JSON.stringify(out)).not.toContain("SECRET-B-TITLE");
    expect(out.duplicateWork.priorWork).toEqual([]);
  });
});

describe("proof 3 — attribution accuracy", () => {
  const seedPin = async (
    world: World,
    id: string,
    commit: string,
    brokeAtCommit: string | null = "b0b0b0b",
  ) => {
    await world.harness.db.insert(pins).values({
      id,
      repo: REPO,
      surface: "playback",
      verifiedBy: world.developer.developerId,
      verifiedAtCommit: commit,
      verifiedAt: at(200),
      checkRecipe: "bun test",
      captureMode: "human",
      brokeAt: at(40),
      brokeAtCommit,
      createdAt: at(200),
    });
    await world.harness.db.insert(pinFiles).values({
      pinId: id,
      repo: REPO,
      path: "src/player.ts",
      status: "present",
    });
  };

  const repairPin = async (world: World, repairs: string, hoursAgo = 5) => {
    await world.harness.db.insert(pins).values({
      id: `${repairs}_fix`,
      repo: REPO,
      surface: "playback",
      verifiedBy: world.developer.developerId,
      verifiedAtCommit: "def5678",
      verifiedAt: at(hoursAgo),
      checkRecipe: "bun test",
      captureMode: "human",
      repairsPinId: repairs,
      repairsPinVersion: 1,
      createdAt: at(hoursAgo),
    });
  };

  const answer = async (
    world: World,
    id: string,
    pinId: string,
    topSessionId: string,
    judgeable: boolean,
    answeredHoursAgo = 30,
  ) => {
    await world.harness.db.insert(pilotAttributions).values({
      id,
      repo: REPO,
      pinId,
      outcome: "ranked",
      falsifier: "recorded_break",
      topSessionId,
      topLift: 0.8,
      candidates: 2,
      coverageJudgeable: judgeable,
      answeredAt: at(answeredHoursAgo),
    });
  };

  test("PIL-5: an attribution only ever made under a gap is EXCLUDED", async () => {
    // Arrange — two attributions. One was only ever given while a lane was
    // blind; the other was given under full coverage.
    const world = await setup();
    await session(world, "s_x");
    await session(world, "s_y");
    await seedPin(world, "pin_1", "abc1234");
    await answer(world, "pa_1", "pin_1", "s_x", false);
    await answer(world, "pa_2", "pin_1", "s_y", true);

    // Act
    const out = await report(world);

    // Assert — the gap answer is neither a hit nor a miss
    expect(out.attribution.attributions).toBe(2);
    expect(out.attribution.excluded).toBe(1);
    expect(out.attribution.noRepairYet).toBe(1);
  });

  test("asking the same question twice is ONE attribution, two answers", async () => {
    // Arrange — scoring each re-run would measure how often somebody re-ran
    // suspect, not whether it was right.
    const world = await setup();
    await session(world, "s_x");
    await seedPin(world, "pin_1", "abc1234");
    await answer(world, "pa_1", "pin_1", "s_x", true);
    await answer(world, "pa_2", "pin_1", "s_x", true);

    // Act
    const out = await report(world);

    // Assert
    expect(out.attribution.answers).toBe(2);
    expect(out.attribution.attributions).toBe(1);
  });

  test("the fix range starts where the break was RECORDED, not where it last worked", async () => {
    // Arrange — the pin was verified working at abc1234 and recorded broken
    // at b0b0b0b. Diffing from abc1234 would include the break itself, so any
    // session that touched the pinned file would read as a hit.
    const world = await setup();
    await session(world, "s_x");
    await context(world, "wc_x", "s_x", "rework playback");
    await touch(world, "wc_x", ["src/player.ts", "src/config.ts"], 60);
    await seedPin(world, "pin_1", "abc1234", "b0b0b0b");
    await repairPin(world, "pin_1");
    await answer(world, "pa_1", "pin_1", "s_x", true);

    // Act
    const out = await report(world);

    // Assert — the pinned files every candidate touched are handed over
    // SEPARATELY from what only this session touched, because only the
    // second can tell one candidate from another.
    expect(out.attribution.repaired).toEqual([
      {
        pinId: "pin_1",
        repairPinId: "pin_1_fix",
        brokenCommit: "b0b0b0b",
        repairCommit: "def5678",
        pinnedFiles: ["src/player.ts"],
        namedFiles: ["src/config.ts"],
      },
    ]);
    expect(out.attribution.noRepairYet).toBe(0);
  });

  test("a break recorded without its commit is counted, never scored", async () => {
    // Arrange — breaks recorded before the commit was stored
    const world = await setup();
    await session(world, "s_x");
    await seedPin(world, "pin_1", "abc1234", null);
    await repairPin(world, "pin_1");
    await answer(world, "pa_1", "pin_1", "s_x", true);

    // Act
    const out = await report(world);

    // Assert
    expect(out.attribution.repaired).toEqual([]);
    expect(out.attribution.repairedWithoutBreakCommit).toBe(1);
  });

  test("one verdict per repaired break: the last answer before the repair", async () => {
    // Arrange — three answers on one break. The breaker was named first, an
    // innocent later, and the fixer only after the repair existed. Scoring all
    // three would count one fix three times, and the fixer's answer was given
    // with the fix already in hand.
    const world = await setup();
    for (const id of ["s_breaker", "s_innocent", "s_fixer"]) {
      await session(world, id);
      await context(world, `wc_${id}`, id, id);
    }
    await touch(world, "wc_s_breaker", ["src/player.ts", "src/config.ts"], 60);
    await touch(world, "wc_s_innocent", ["src/player.ts", "docs/notes.md"], 60);
    await touch(world, "wc_s_fixer", ["src/player.ts"], 4);
    await seedPin(world, "pin_1", "abc1234");
    await repairPin(world, "pin_1", 5);
    await answer(world, "pa_1", "pin_1", "s_breaker", true, 30);
    await answer(world, "pa_2", "pin_1", "s_innocent", true, 20);
    await answer(world, "pa_3", "pin_1", "s_fixer", true, 2);

    // Act
    const out = await report(world);

    // Assert — the innocent's answer is the one people last acted on
    expect(out.attribution.repaired).toHaveLength(1);
    expect(out.attribution.repaired[0]?.namedFiles).toEqual(["docs/notes.md"]);
    expect(out.attribution.supersededAnswers).toBe(1);
    expect(out.attribution.answersAfterRepair).toBe(1);
  });
});

describe("proof 4 — sessions over sessions", () => {
  test("a session that opened five pointers is ONE session that opened something", async () => {
    // Arrange — the target is "one session in twelve received something it
    // opened"; counting deliveries read 500 per 100 over one session
    const world = await setup();
    await session(world, "s_prior", 100);
    await context(world, "wc_prior", "s_prior", "prior");
    await session(world, "s_x", 20);
    for (let index = 0; index < 5; index += 1) {
      await deliver(world, `hd_${String(index)}`, "s_x", "wc_prior", "prompt_hint", 10, 5);
    }

    // Act — a window that holds s_x and not s_prior
    const out = await report(world, 1);

    // Assert
    expect(out.precision.sessions).toBe(1);
    expect(out.precision.openedPer100).toEqual({ kind: "measured", value: 100 });
  });
});

describe("proof 4 — proactive precision", () => {
  test("a rate over zero sessions is unavailable, not zero", async () => {
    // Arrange
    const world = await setup();

    // Act
    const out = await report(world);

    // Assert
    expect(out.precision.openedPer100).toEqual({
      kind: "unavailable",
      reason: "no_sessions",
    });
  });

  test("opened per hundred sessions counts unsolicited pointers only", async () => {
    // Arrange — four sessions; two opened unsolicited pointers, one opened a
    // `suspect` answer, which is PULLED and is not proactive.
    const world = await setup();
    for (const id of ["s_a", "s_b", "s_c", "s_d"]) {
      await session(world, id);
    }
    await context(world, "wc_d", "s_d", "prior work");
    await deliver(world, "hd_1", "s_a", "wc_d", "briefing", 50, 49);
    await deliver(world, "hd_2", "s_b", "wc_d", "prompt_hint", 50, 49);
    await deliver(world, "hd_3", "s_c", "wc_d", "suspect", 50, 49);

    // Act
    const out = await report(world);

    // Assert — 2 of 4 sessions = 50 per hundred
    expect(out.precision.sessions).toBe(4);
    expect(out.precision.openedPer100).toEqual({ kind: "measured", value: 50 });
  });
});

describe("proof 5 — coverage integrity", () => {
  test("PIL-4: a surface that counted nothing is not instrumented, not perfect", async () => {
    // Arrange — one surface answered and was counted; the rest never were
    const world = await setup();
    await world.harness.db.insert(pilotCounters).values({
      repo: REPO,
      day: TEST_START_ISO.slice(0, 10),
      surface: "api-suspect",
      counter: "answers_emitted",
      value: 3,
      updatedAt: NOW,
    });

    // Act
    const out = await report(world);

    // Assert
    const suspect = out.integrity.find((row) => row.surface === "api-suspect");
    const absences = out.integrity.find(
      (row) => row.surface === "api-absences",
    );
    expect(suspect?.counters).toEqual({ answers_emitted: 3 });
    expect(absences?.counters).toBeNull();
  });
});

describe("the session set", () => {
  test("PIL-7: spanned, restarted and not-recorded sessions are kept apart", async () => {
    // Arrange
    const world = await setup();
    for (const [id, epochs] of [
      ["s_1", 1],
      ["s_2", 2],
      ["s_3", 0],
    ] as const) {
      await session(world, id);
      await inCohort(world, id, "discovery", epochs);
    }

    // Act
    const out = await report(world);

    // Assert
    expect(out.sessionSet).toEqual({
      used: 3,
      cap: PILOT_SESSION_SET_CAP,
      refused: 0,
      legacyRefused: 0,
      beforeLabels: 0,
      discovery: 3,
      discoveryCap: PILOT_DISCOVERY_COHORT_SESSIONS,
      replication: 0,
      replicationCap: PILOT_REPLICATION_COHORT_SESSIONS,
      legacy: 0,
      spanned: 1,
      restarted: 1,
      notRecorded: 1,
    });
  });
});

/**
 * PROOF 4, REVISED (07 §12, 2026-09-30): human labels, and the four figures
 * the review asked for. The example is the review's own — four helpful and
 * ten noise interventions read as two healthy per-100 rates while precision
 * was 4/14 — and every figure prints beside the coverage that says how many
 * interventions were labelled at all.
 */
describe("proof 4 — human labels", () => {
  test("the review's example: 4 helpful and 10 noise of 40 interventions over 20 sessions", async () => {
    // Arrange — two unsolicited pointers to each of twenty sessions; a
    // person labelled fourteen of the forty
    const world = await setup();
    const ids = await interventions(world, 20, 2);
    for (const id of ids.slice(0, 4)) {
      await label(world, id, "helpful");
    }
    for (const id of ids.slice(4, 14)) {
      await label(world, id, "noise");
    }

    // Act — a window that holds the twenty and not the prior session
    const out = await report(world, 1);

    // Assert — precision 4/14, and neither per-100 rate hides it
    const proof = out.precision;
    expect(proof.sessions).toBe(20);
    expect(proof.interventions).toBe(40);
    expect(proof.helpful).toBe(4);
    expect(proof.noise).toBe(10);
    expect(proof.unclear).toBe(0);
    expect(proof.labelled).toBe(14);
    expect(proof.precision).toEqual({ kind: "measured", value: 4 / 14 });
    expect(proof.precisionTarget).toBe(PILOT_TARGET_INTERVENTION_PRECISION);
    expect(proof.benefitPer100).toEqual({ kind: "measured", value: 20 });
    expect(proof.burdenPer100).toEqual({ kind: "measured", value: 200 });
    expect(proof.labelCoverage).toEqual({ kind: "measured", value: 14 / 40 });
  });

  test("unclear is shown apart and abstains from the precision denominator", async () => {
    // Arrange — "I could not tell" is not "not helpful": scoring it as a
    // miss would make precision fall with the labelers' honesty. It counts
    // toward coverage — the person did look — and prints on its own.
    const world = await setup();
    const ids = await interventions(world, 20, 2);
    for (const id of ids.slice(0, 4)) {
      await label(world, id, "helpful");
    }
    for (const id of ids.slice(4, 14)) {
      await label(world, id, "noise");
    }
    for (const id of ids.slice(14, 17)) {
      await label(world, id, "unclear");
    }

    // Act
    const out = await report(world, 1);

    // Assert
    expect(out.precision.unclear).toBe(3);
    expect(out.precision.labelled).toBe(17);
    expect(out.precision.precision).toEqual({ kind: "measured", value: 4 / 14 });
    expect(out.precision.labelCoverage).toEqual({ kind: "measured", value: 17 / 40 });
  });

  test("an older hub's off_target rows are counted apart, outside precision", async () => {
    // Arrange — the word an earlier build stored; nothing is rewritten. It
    // was the only word its era had, so it cannot stand in a denominator
    // beside a `helpful` that did not exist (second review, H1).
    const world = await setup();
    const ids = await interventions(world, 2, 1);
    await label(world, ids[0] ?? "", "off_target");
    await label(world, ids[1] ?? "", "helpful");

    // Act
    const out = await report(world, 1);

    // Assert
    expect(out.precision.noise).toBe(0);
    expect(out.precision.legacyNoise).toBe(1);
    expect(out.precision.precision).toEqual({ kind: "measured", value: 1 });
  });

  test("precision over no verdict, and coverage over no intervention, are unavailable", async () => {
    // Arrange — one session, one intervention, one `unclear`: somebody
    // looked, nobody judged. A precision of 0 here would read as "nothing
    // helped"; a coverage of 0 on a repo with no interventions as "nobody
    // labels".
    const world = await setup();
    const ids = await interventions(world, 1, 1);
    await label(world, ids[0] ?? "", "unclear");
    const quiet = await setup();
    await session(quiet, "s_quiet", 20);

    // Act
    const out = await report(world, 1);
    const nothing = await report(quiet, 1);

    // Assert
    expect(out.precision.precision).toEqual({ kind: "unavailable", reason: "no_labels" });
    expect(out.precision.labelCoverage).toEqual({ kind: "measured", value: 1 });
    expect(nothing.precision.labelCoverage).toEqual({
      kind: "unavailable",
      reason: "no_interventions",
    });
    expect(nothing.precision.burdenPer100).toEqual({ kind: "measured", value: 0 });
  });

  test("an answer somebody asked for is no intervention: not in burden, not in coverage", async () => {
    // Arrange — one unasked pointer and one `suspect` answer to the same
    // session. The answer was pulled; counting it would make asking a
    // question raise the burden figure and dilute the label coverage.
    const world = await setup();
    const ids = await interventions(world, 1, 1);
    await deliver(world, "hd_asked", "s_0", "wc_prior", "suspect", 10, null);
    await label(world, ids[0] ?? "", "helpful");

    // Act
    const out = await report(world, 1);

    // Assert
    expect(out.precision.interventions).toBe(1);
    expect(out.precision.burdenPer100).toEqual({ kind: "measured", value: 100 });
    expect(out.precision.labelCoverage).toEqual({ kind: "measured", value: 1 });
  });

  test("the opened figure stays, as a behavioural signal beside the human ones", async () => {
    // Arrange — one pointer the agent pulled, and no label on it
    const world = await setup();
    await session(world, "s_prior", 100);
    await context(world, "wc_prior", "s_prior", "prior");
    await session(world, "s_x", 20);
    await deliver(world, "hd_x", "s_x", "wc_prior", "prompt_hint", 10, 5);

    // Act
    const out = await report(world, 1);

    // Assert — opened is measured; helpful is zero, because nobody said so
    expect(out.precision.openedPer100).toEqual({ kind: "measured", value: 100 });
    expect(out.precision.helpful).toBe(0);
    expect(out.precision.benefitPer100).toEqual({ kind: "measured", value: 0 });
  });
});

describe("proof 4 — the two cohorts, side by side", () => {
  test("each cohort is measured over its own sessions, whatever the window", async () => {
    // Arrange — two discovery sessions with one intervention each, one
    // labelled helpful; one replication session with two, one labelled
    // noise. The cohort is the population: no window applies.
    const world = await setup();
    await session(world, "s_prior", 100);
    await context(world, "wc_prior", "s_prior", "prior");
    for (const [id, cohort] of [
      ["s_d1", "discovery"],
      ["s_d2", "discovery"],
      ["s_r1", "replication"],
    ] as const) {
      await session(world, id, 500);
      await inCohort(world, id, cohort);
    }
    await deliver(world, "hd_d1", "s_d1", "wc_prior", "briefing", 490, null);
    await deliver(world, "hd_d2", "s_d2", "wc_prior", "briefing", 490, null);
    await deliver(world, "hd_r1a", "s_r1", "wc_prior", "briefing", 490, null);
    await deliver(world, "hd_r1b", "s_r1", "wc_prior", "prompt_hint", 490, null);
    await label(world, "hd_d1", "helpful");
    await label(world, "hd_r1a", "noise");

    // Act — a one-day window that holds none of those sessions
    const out = await report(world, 1);

    // Assert
    expect(out.cohorts.map((row) => row.cohort)).toEqual(["discovery", "replication"]);
    const [discovery, replication] = out.cohorts;
    expect(discovery?.sessions).toBe(2);
    expect(discovery?.interventions).toBe(2);
    expect(discovery?.benefitPer100).toEqual({ kind: "measured", value: 50 });
    expect(discovery?.burdenPer100).toEqual({ kind: "measured", value: 100 });
    expect(discovery?.precision).toEqual({ kind: "measured", value: 1 });
    expect(discovery?.labelCoverage).toEqual({ kind: "measured", value: 0.5 });
    expect(replication?.sessions).toBe(1);
    expect(replication?.interventions).toBe(2);
    expect(replication?.precision).toEqual({ kind: "measured", value: 0 });
    expect(replication?.burdenPer100).toEqual({ kind: "measured", value: 200 });
    // and the window's own figures saw none of it
    expect(out.precision.sessions).toBe(0);
  });

  test("an empty cohort says so on every figure", async () => {
    // Arrange & Act
    const world = await setup();
    const out = await report(world, 1);

    // Assert
    const [discovery] = out.cohorts;
    expect(discovery?.sessions).toBe(0);
    expect(discovery?.cap).toBe(PILOT_DISCOVERY_COHORT_SESSIONS);
    expect(discovery?.benefitPer100).toEqual({ kind: "unavailable", reason: "no_sessions" });
    expect(discovery?.precision).toEqual({ kind: "unavailable", reason: "no_labels" });
  });
});

describe("proof 4 — the reasons people gave", () => {
  test("a reason is listed beside its label, newest first, and the list is bounded", async () => {
    // Arrange — more reasons than the report prints
    const world = await setup();
    const ids = await interventions(world, 1, PILOT_REPORT_MAX_LABEL_REASONS + 2);
    for (const [index, id] of ids.entries()) {
      await label(world, id, "noise", `reason ${String(index)}`, ids.length - index);
    }
    await label(world, "hd_none", "helpful");

    // Act
    const out = await report(world, 1);

    // Assert
    expect(out.precision.reasons).toHaveLength(PILOT_REPORT_MAX_LABEL_REASONS);
    expect(out.precision.reasons[0]).toEqual({
      label: "noise",
      reason: `reason ${String(ids.length - 1)}`,
    });
    expect(out.precision.reasonsBeyondList).toBe(2);
  });

  test("a reason given about another repo's intervention never reaches this repo's report", async () => {
    // Arrange — the one place a reason is rendered is its OWN repo's report
    // (07 §12); one about a delivery to another repo's session belongs there
    const world = await setup();
    await world.harness.db.insert(agentSessions).values({
      id: "s_elsewhere",
      developerId: world.developer.developerId,
      agentKind: "claude-code",
      repo: "github.com/acme/other",
      branch: "main",
      baseCommit: "abc1234",
      status: "implementing",
      startedAt: at(20),
      lastHeartbeatAt: at(20),
    });
    await deliver(world, "hd_elsewhere", "s_elsewhere", "wc_any", "prompt_hint", 10, null);
    await label(world, "hd_elsewhere", "noise", "said about the other repo");

    // Act
    const out = await report(world, 1);

    // Assert
    expect(out.precision.reasons).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("said about the other repo");
  });

  test("a legacy word's reason is listed under noise", async () => {
    // Arrange
    const world = await setup();
    const ids = await interventions(world, 1, 1);
    await label(world, ids[0] ?? "", "off_target", "stale pointer");

    // Act
    const out = await report(world, 1);

    // Assert
    expect(out.precision.reasons).toEqual([{ label: "noise", reason: "stale pointer" }]);
  });
});

/**
 * A HUB THAT RAN THE 0.10 PILOT (07 §12, second review, H1 and M5). Before the
 * upgrade a person could say only `off_target`; `helpful` did not exist, and
 * the walk reaches back one day, so nothing from then can ever be labelled
 * helpful. Counting those rows would print a measured 0% precision that is an
 * artefact of the old vocabulary, not a finding about the product.
 */
describe("labels counted only from when they became available", () => {
  test("probe 3: a 0.10 hub's old rows read no precision and no benefit", async () => {
    // Arrange — thirty sessions and sixty interventions from before the
    // upgrade, six of them marked off_target; labels became available ten
    // hours ago, after all of it
    const world = await setup({ labelsSinceHoursAgo: 10 });
    await session(world, "s_prior", 100);
    await context(world, "wc_prior", "s_prior", "prior work");
    for (let s = 0; s < 30; s += 1) {
      await session(world, `s_old_${String(s)}`, 30);
      await inCohort(world, `s_old_${String(s)}`, "legacy");
      for (const n of [0, 1]) {
        await deliver(world, `hd_old_${String(s)}_${String(n)}`, `s_old_${String(s)}`, "wc_prior", "prompt_hint", 29, null);
      }
    }
    for (let s = 0; s < 6; s += 1) {
      await label(world, `hd_old_${String(s)}_0`, "off_target", null, 28);
    }

    // Act — the default eight-week window holds every old row
    const out = await report(world);

    // Assert — absent, never a measured zero; the old marks are their own count
    expect(out.labelsSinceIso).toBe(at(10).toISOString());
    expect(out.precision.labelledSinceIso).toBe(at(10).toISOString());
    expect(out.precision.precision).toEqual({ kind: "unavailable", reason: "no_labels" });
    expect(out.precision.benefitPer100).toEqual({ kind: "unavailable", reason: "no_sessions" });
    expect(out.precision.noise).toBe(0);
    expect(out.precision.legacyNoise).toBe(6);
    expect(out.sessionSet.legacy).toBe(30);
    expect(out.sessionSet.discovery).toBe(0);
    expect(out.cohorts[0]?.sessions).toBe(0);
    expect(out.cohorts[0]?.precision).toEqual({ kind: "unavailable", reason: "no_labels" });
  });

  test("M5: the window's labelled figures start when labels became available", async () => {
    // Arrange — one session before labels existed and one after, both inside
    // a one-day window, each with an intervention a person called helpful
    const world = await setup({ labelsSinceHoursAgo: 10 });
    await session(world, "s_prior", 100);
    await context(world, "wc_prior", "s_prior", "prior work");
    await session(world, "s_before", 20);
    await session(world, "s_after", 5);
    await deliver(world, "hd_before", "s_before", "wc_prior", "prompt_hint", 19, null);
    await deliver(world, "hd_after", "s_after", "wc_prior", "prompt_hint", 4, null);
    await label(world, "hd_before", "helpful");
    await label(world, "hd_after", "helpful");

    // Act
    const out = await report(world, 1);

    // Assert — only the session that could have been labelled is counted
    expect(out.precision.labelledSinceIso).toBe(at(10).toISOString());
    expect(out.precision.sessions).toBe(1);
    expect(out.precision.interventions).toBe(1);
    expect(out.precision.helpful).toBe(1);
    expect(out.precision.benefitPer100).toEqual({ kind: "measured", value: 100 });
  });

  test("a window that starts after labels did is not clipped", async () => {
    // Arrange
    const world = await setup({ labelsSinceHoursAgo: 100 });

    // Act
    const out = await report(world, 1);

    // Assert
    expect(out.precision.labelledSinceIso).toBe(out.sinceIso);
  });

  test("an old off_target mark is counted beside precision, never inside it", async () => {
    // Arrange — a new helpful label after labels existed, and a 0.10
    // off_target mark from before
    const world = await setup({ labelsSinceHoursAgo: 10 });
    await session(world, "s_prior", 100);
    await context(world, "wc_prior", "s_prior", "prior work");
    await session(world, "s_old", 30);
    await session(world, "s_new", 5);
    await deliver(world, "hd_old", "s_old", "wc_prior", "prompt_hint", 29, null);
    await deliver(world, "hd_new", "s_new", "wc_prior", "prompt_hint", 4, null);
    await label(world, "hd_old", "off_target", null, 28);
    await label(world, "hd_new", "helpful");

    // Act
    const out = await report(world);

    // Assert — precision is the new label's alone
    expect(out.precision.precision).toEqual({ kind: "measured", value: 1 });
    expect(out.precision.noise).toBe(0);
    expect(out.precision.legacyNoise).toBe(1);
  });
});

describe("the set's refusals, by which cap refused them (second review, M2)", () => {
  test("refusals under the 0.10 fifty-session cap are counted apart from the set's own", async () => {
    // Arrange — a 0.10 hub refused thirty sessions at its old cap of fifty;
    // the set now holds two hundred, so those thirty say nothing about it
    const world = await setup();
    const day = at(500).toISOString().slice(0, 10);
    await world.harness.db.insert(pilotCounters).values(
      [
        ["pilot_sessions_refused", 30],
        ["pilot_set_refused", 2],
        ["pilot_sessions_before_labels", 4],
      ].map(([counter, value]) => ({
        repo: REPO,
        day,
        surface: "pilot-sessions",
        counter: String(counter),
        value: Number(value),
        updatedAt: at(500),
      })),
    );

    // Act
    const out = await report(world);

    // Assert
    expect(out.sessionSet.refused).toBe(2);
    expect(out.sessionSet.legacyRefused).toBe(30);
    expect(out.sessionSet.beforeLabels).toBe(4);
  });
});

describe("no person appears anywhere in the report (§8.4)", () => {
  test("no developer id and no developer name, whatever the data", async () => {
    // Arrange — a busy repo: every proof has something to say
    const world = await setup();
    await session(world, "s_a");
    await session(world, "s_b");
    await context(world, "wc_b", "s_b", "prior work");
    await deliver(world, "hd_1", "s_a", "wc_b", "briefing", 50, 49);
    await label(world, "hd_1", "helpful", "saved me an hour");

    // Act
    const text = JSON.stringify(await report(world));

    // Assert — the reason travels, the person who wrote it does not
    expect(text).toContain("saved me an hour");
    expect(text).not.toContain(world.developer.developerId);
    expect(text).not.toContain("Nick");
  });
});
