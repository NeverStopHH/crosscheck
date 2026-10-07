/**
 * An inline finding is a delivery, never an open (1.0 spec 07 §3.1, revised
 * 2026-10; DESIGN.md §4).
 *
 * A prompt hint that carries a claim's substance hands the reader the finding
 * itself, so it needs no get_diagnosis to be useful — and a later read of its
 * tree is the agent pulling MORE, not "the pointer was opened". Booked on its
 * own channel, `prompt_substance`, it is counted where it belongs: surfaced,
 * in a bucket of its own, and in none of the pointer figures — opened,
 * converged, opened anyway, opened per hundred sessions. Folding it in would
 * make the pilot's one behavioural precision signal rise by construction the
 * day hints started carrying their answer.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { SUBSTANCE_DELIVERY_CHANNEL } from "@crosscheck/schema";

import {
  agentSessions,
  hintDeliveries,
  teamSettings,
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
const LABELS_LONG_AGO_HOURS = 1000;
const at = (hoursAgo: number): Date => new Date(NOW.getTime() - hoursAgo * HOUR);

interface World {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
}

/** An enrolled repo with the prior work (s_b / wc_b) a delivery points at. */
const setup = async (): Promise<World> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick-substance@example.com");
  await harness.app.request(
    "/api/team-settings",
    jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: true }),
  );
  await harness.db
    .update(teamSettings)
    .set({ pilotLabelsSince: at(LABELS_LONG_AGO_HOURS) })
    .where(eq(teamSettings.repo, REPO));
  const world = { harness, developer };
  for (const id of ["s_a", "s_b"]) {
    await harness.db.insert(agentSessions).values({
      id,
      developerId: developer.developerId,
      agentKind: "claude-code",
      repo: REPO,
      branch: "main",
      baseCommit: "abc1234",
      status: "implementing",
      startedAt: at(100),
      lastHeartbeatAt: at(100),
    });
  }
  for (const [id, sessionId] of [["wc_a", "s_a"], ["wc_b", "s_b"]] as const) {
    await harness.db.insert(workContexts).values({
      id,
      sessionId,
      title: id === "wc_b" ? "prior work" : "mine",
      status: "implementing",
      createdAt: at(99),
    });
  }
  return world;
};

const touch = async (world: World, contextId: string, hoursAgo: number) => {
  await world.harness.db.insert(workContextTargets).values(
    ["src/a.ts", "src/b.ts"].map((value) => ({
      workContextId: contextId,
      kind: "file" as const,
      value,
      createdAt: at(hoursAgo),
    })),
  );
};

/** One delivery from s_b's tree to s_a, on `channel`, pulled or not. */
const deliver = async (
  world: World,
  channel: "prompt_hint" | typeof SUBSTANCE_DELIVERY_CHANNEL,
  pulledHoursAgo: number | null,
) => {
  await world.harness.db.insert(hintDeliveries).values({
    id: `hd_${channel}`,
    sessionId: "s_a",
    refKind: "work_context",
    refId: "wc_b",
    channel,
    deliveredAt: at(50),
    pulledAt: pulledHoursAgo === null ? null : at(pulledHoursAgo),
  });
};

const report = (world: World) =>
  readPilotReport({ db: world.harness.db, now: () => NOW }, { repo: REPO, days: 56, viewerDeveloperId: world.developer.developerId });

describe("an inline finding is surfaced, in its own bucket", () => {
  test("it counts as surfaced and as prompt_substance, never as prompt_hint", async () => {
    // Arrange
    const world = await setup();
    await deliver(world, SUBSTANCE_DELIVERY_CHANNEL, null);

    // Act
    const out = await report(world);

    // Assert
    expect(out.duplicateWork.surfaced).toBe(1);
    expect(out.duplicateWork.byChannel.prompt_substance).toBe(1);
    expect(out.duplicateWork.byChannel.prompt_hint).toBe(0);
  });
});

describe("an inline finding is never an open", () => {
  test("a later read of its tree is not counted as opened, nor named as prior work", async () => {
    // Arrange — delivered 50h ago, its tree read 49h ago: an open for a
    // pointer, the agent pulling MORE for a finding it already had
    const world = await setup();
    await deliver(world, SUBSTANCE_DELIVERY_CHANNEL, 49);

    // Act
    const out = await report(world);

    // Assert
    expect(out.duplicateWork.opened).toBe(0);
    expect(out.duplicateWork.priorWork).toEqual([]);
  });

  test("the control: the same read after a pointer IS an open", async () => {
    // Arrange
    const world = await setup();
    await deliver(world, "prompt_hint", 49);

    // Act
    const out = await report(world);

    // Assert
    expect(out.duplicateWork.opened).toBe(1);
  });

  test("work on its tree's files afterwards is neither convergence nor 'opened anyway'", async () => {
    // Arrange — the files of the pointed work, touched by the receiver after
    // the finding arrived: for a pointer never opened that is "opened
    // anyway"; for a finding the hint itself carried it is neither
    const world = await setup();
    await touch(world, "wc_b", 90);
    await deliver(world, SUBSTANCE_DELIVERY_CHANNEL, null);
    await touch(world, "wc_a", 40);

    // Act
    const out = await report(world);

    // Assert
    expect(out.duplicateWork.openedAnyway).toBe(0);
    expect(out.duplicateWork.converged).toBe(0);
  });

  test("opened per hundred sessions does not count it", async () => {
    // Arrange
    const world = await setup();
    await deliver(world, SUBSTANCE_DELIVERY_CHANNEL, 49);

    // Act
    const out = await report(world);

    // Assert — measured, and zero: nobody opened a pointer
    expect(out.precision.openedPer100).toEqual({ kind: "measured", value: 0 });
  });
});
