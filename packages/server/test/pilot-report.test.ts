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
  pilotSessions,
  pinFiles,
  pins,
  workContextTargets,
  workContexts,
} from "../src/db/schema.ts";
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

const setup = async (
  options: { readonly enrolled: boolean } = { enrolled: true },
): Promise<World> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick-report@example.com",
  );
  if (options.enrolled) {
    await harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: true }),
    );
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

describe("the 50-session set", () => {
  test("PIL-7: spanned, restarted and not-recorded sessions are kept apart", async () => {
    // Arrange
    const world = await setup();
    for (const [id, epochs] of [
      ["s_1", 1],
      ["s_2", 2],
      ["s_3", 0],
    ] as const) {
      await session(world, id);
      await world.harness.db.insert(pilotSessions).values({
        sessionId: id,
        repo: REPO,
        observedAt: at(10),
        endReason: "reported",
        coverage: [],
        seqNullRecords: 0,
        seqEpochs: epochs,
      });
    }

    // Act
    const out = await report(world);

    // Assert
    expect(out.sessionSet).toEqual({
      used: 3,
      cap: 50,
      refused: 0,
      spanned: 1,
      restarted: 1,
      notRecorded: 1,
    });
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

    // Act
    const text = JSON.stringify(await report(world));

    // Assert
    expect(text).not.toContain(world.developer.developerId);
    expect(text).not.toContain("Nick");
  });
});
