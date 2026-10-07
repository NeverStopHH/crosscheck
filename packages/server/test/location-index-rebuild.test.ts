/**
 * OPTED OUT BEFORE THIS RELEASE (review round 5, M1). Round 4 took an
 * opted-out owner's location titles out of the search index when she
 * TOGGLES; a developer who opted out on an earlier release never toggles
 * again, so her docs kept her branch titles and a colleague's guess at her
 * branch still found her work. A pass at boot rebuilds her location-titled
 * docs, once per opt-out: `developers.location_index_built_at` says the
 * index was built for the opt-out she has now.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rebuildOptedOutLocationIndexes } from "../src/services/developer-settings.ts";
import {
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
const ROBIN_S = "cc_00000000-0000-4000-8000-0000000000b1";
const SECRET_BRANCH = "feat/robin-moves-to-lisbon";
const CONTEXT = "wc_robin_lisbon";

interface World {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly robin: TestDeveloper;
}

/** Her context titled by her branch, indexed while she was visible. */
const seed = async (): Promise<World> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
  await registerTestSession(harness, robin.apiKey, { id: ROBIN_S, branch: SECRET_BRANCH });
  const posted = await postRecords(harness, robin, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: CONTEXT, sessionId: ROBIN_S, title: `${SECRET_BRANCH} @ api`, titleSource: "fallback", description: "refresh token rotation" }),
        { sessionId: ROBIN_S },
      ),
    ],
  });
  expect(posted.data?.rejected).toBe(0);
  return { harness, nick, robin };
};

/** How an earlier release recorded an opt-out: the flag, and no rebuild. */
const optOutOnAnEarlierRelease = async (world: World): Promise<void> => {
  await world.harness.db.execute(sql`UPDATE developers SET presence_opt_out = true WHERE id = ${world.robin.developerId}`);
};

const deps = (world: World) => ({ db: world.harness.db, now: world.harness.clock.now, embedder: null });

const nickFinds = async (world: World, query: string): Promise<boolean> => {
  const params = new URLSearchParams({ repo: REPO, query });
  const response = await world.harness.app.request(`/api/search?${params.toString()}`, jsonRequest("GET", world.nick.apiKey));
  expect(response.status).toBe(200);
  return (await response.text()).includes(CONTEXT);
};

const markerOf = async (world: World): Promise<unknown> => {
  const rows = await world.harness.db.execute<{ at: unknown }>(
    sql`SELECT location_index_built_at AS at FROM developers WHERE id = ${world.robin.developerId}`,
  );
  return rows.rows[0]?.at;
};

describe("an opt-out from before this release is taken out of the index at boot, once", () => {
  test("her branch title stops matching a colleague's guess, and her work is still found by what it is about", async () => {
    // Arrange
    const world = await seed();
    await optOutOnAnEarlierRelease(world);
    expect(await nickFinds(world, SECRET_BRANCH)).toBe(true);

    // Act
    const rebuilt = await rebuildOptedOutLocationIndexes(deps(world));

    // Assert
    expect(rebuilt).toBe(1);
    expect(await nickFinds(world, SECRET_BRANCH)).toBe(false);
    expect(await nickFinds(world, "refresh token rotation")).toBe(true);
    expect(await markerOf(world)).not.toBeNull();
  });

  test("a second boot rebuilds nothing", async () => {
    // Arrange
    const world = await seed();
    await optOutOnAnEarlierRelease(world);
    await rebuildOptedOutLocationIndexes(deps(world));

    // Act
    const again = await rebuildOptedOutLocationIndexes(deps(world));

    // Assert
    expect(again).toBe(0);
  });

  test("an opt-out the toggle already rebuilt for is not rebuilt at boot; opting back in clears the mark", async () => {
    // Arrange
    const world = await seed();
    const put = async (optOut: boolean): Promise<void> => {
      const response = await world.harness.app.request("/api/settings/presence", jsonRequest("PUT", world.robin.apiKey, { optOut }));
      expect(response.status).toBe(200);
    };

    // Act
    await put(true);
    const afterToggle = await markerOf(world);
    const atBoot = await rebuildOptedOutLocationIndexes(deps(world));
    await put(false);

    // Assert
    expect(afterToggle).not.toBeNull();
    expect(atBoot).toBe(0);
    expect(await markerOf(world)).toBeNull();
  });
});
