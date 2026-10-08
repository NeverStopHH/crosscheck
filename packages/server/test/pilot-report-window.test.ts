/**
 * A REPORT WINDOW HOLDS THE SESSIONS THAT WORKED IN IT (DESIGN.md "One
 * session, many topics"; services/session-window.ts).
 *
 * The owner's one long-lived session started weeks before any report window
 * a person asks for. Windowed by its START, none of last week's work counted;
 * windowed by its TARGETS' times — first seen or last seen — it does. A
 * target sighted again (a duplicate ingest) moves `last_seen_at`, so an old
 * file re-touched this week dates the session into this week too.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { agentSessions, teamSettings, workContextTargets, workContexts } from "../src/db/schema.ts";
import { readPilotReport } from "../src/services/pilot-report.ts";
import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createHarnessWithSession,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const NOW = new Date(TEST_START_ISO);
const DAY = 86_400_000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);
const WINDOW_DAYS = 7;

interface World {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
}

const setup = async (): Promise<World> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick-window@example.com");
  await harness.app.request("/api/team-settings", jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: true }));
  await harness.db.update(teamSettings).set({ pilotLabelsSince: daysAgo(60) }).where(eq(teamSettings.repo, REPO));
  return { harness, developer };
};

/** A session that started `startedDaysAgo`, with one context and one target last seen `seenDaysAgo`. */
const longLived = async (world: World, id: string, startedDaysAgo: number, seenDaysAgo: number | null): Promise<void> => {
  await world.harness.db.insert(agentSessions).values({
    id,
    developerId: world.developer.developerId,
    agentKind: "claude-code",
    repo: REPO,
    branch: "detached@0123456",
    baseCommit: "abc1234",
    status: "implementing",
    startedAt: daysAgo(startedDaysAgo),
    lastHeartbeatAt: daysAgo(0),
  });
  await world.harness.db.insert(workContexts).values({
    id: `wc_${id}`,
    sessionId: id,
    title: "feat/topic @ api",
    status: "implementing",
    createdAt: daysAgo(startedDaysAgo),
  });
  if (seenDaysAgo !== null) {
    await world.harness.db.insert(workContextTargets).values({
      workContextId: `wc_${id}`,
      kind: "file",
      value: "src/a.ts",
      source: "tool_edit",
      createdAt: daysAgo(startedDaysAgo),
      lastSeenAt: daysAgo(seenDaysAgo),
    });
  }
};

const report = (world: World) =>
  readPilotReport(
    { db: world.harness.db, now: () => NOW },
    { repo: REPO, days: WINDOW_DAYS, viewerDeveloperId: world.developer.developerId },
  );

describe("the pilot report's window", () => {
  test("holds a session that started weeks before it when its work was seen inside it", async () => {
    // Arrange: one session, thirty days old, last seen working yesterday
    const world = await setup();
    await longLived(world, "cc_long", 30, 1);

    // Act
    const out = await report(world);

    // Assert: a rate over one session, not "no sessions"
    expect(out.precision.openedPer100).toEqual({ kind: "measured", value: 0 });
  });

  test("leaves out a session whose start and whose work are both before it", async () => {
    // Arrange: thirty days old, last seen working three weeks ago
    const world = await setup();
    await longLived(world, "cc_quiet", 30, 21);
    await longLived(world, "cc_empty", 30, null);

    // Act
    const out = await report(world);

    // Assert
    expect(out.precision.openedPer100).toEqual({ kind: "unavailable", reason: "no_sessions" });
  });
});

describe("a target sighted again moves its last-seen time", () => {
  test("a duplicate ingest moves last_seen_at and never created_at", async () => {
    // Arrange: a target first ingested at the harness clock
    const { harness, developer } = await createHarnessWithSession();
    const target = recordEnvelope("target", { workContextId: WORK_CONTEXT_ID, kind: "file", value: "src/a.ts" });
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody()), target] });
    const read = async () =>
      (await harness.db.select().from(workContextTargets).where(eq(workContextTargets.value, "src/a.ts")))[0];
    const first = await read();
    await harness.db
      .update(workContextTargets)
      .set({ createdAt: daysAgo(30), lastSeenAt: daysAgo(30) })
      .where(eq(workContextTargets.value, "src/a.ts"));

    // Act: the same file sighted again
    await postRecords(harness, developer, {
      records: [recordEnvelope("target", { workContextId: WORK_CONTEXT_ID, kind: "file", value: "src/a.ts", source: "git_diff" })],
    });

    // Assert — a first touch carries created_at only (the batch's rule:
    // last_seen_at moves on a RE-touch, test/target-last-seen.test.ts)
    const again = await read();
    expect(first?.lastSeenAt).toBeNull();
    expect(again?.createdAt?.getTime()).toBe(daysAgo(30).getTime());
    expect((again?.lastSeenAt?.getTime() ?? 0) > daysAgo(30).getTime()).toBe(true);
  });
});
