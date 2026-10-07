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
import type { Embedder } from "../src/services/embedder.ts";
import { NORMALIZED_DOC_VERSION } from "../src/services/normalized-doc.ts";
import { runStartupUpgrades } from "../src/services/startup-upgrades.ts";
import type { StartupLog } from "../src/services/startup-upgrades.ts";
import { FAKE_EMBEDDER_MODEL, createFakeEmbedder } from "./fixtures/fake-embedder.ts";
import {
  VALID_SESSION_BODY,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
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
const seed = async (embedder: Embedder | null = null): Promise<World> => {
  const harness = await createTestHarness({ embedder });
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

/** Which embedder's vector her context carries; null while it has none. */
const vectorModelOf = async (world: World): Promise<unknown> => {
  const rows = await world.harness.db.execute<{ model: unknown }>(
    sql`SELECT CASE WHEN embedding IS NULL THEN NULL ELSE embedding_model END AS model FROM work_contexts WHERE id = ${CONTEXT}`,
  );
  return rows.rows[0]?.model;
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

describe("a rebuilt doc gets its vector back when the hub has an embedder (review round 5, M2)", () => {
  // A rebuild clears the context's embedding (services/normalized-doc.ts):
  // until her next ingest the vector tier could not find her work at all.

  test("the toggle re-embeds what it rebuilt, both ways", async () => {
    // Arrange
    const world = await seed(createFakeEmbedder());
    expect(await vectorModelOf(world)).toBe(FAKE_EMBEDDER_MODEL);
    const put = async (optOut: boolean): Promise<void> => {
      const response = await world.harness.app.request("/api/settings/presence", jsonRequest("PUT", world.robin.apiKey, { optOut }));
      expect(response.status).toBe(200);
    };

    // Act
    await put(true);
    const afterOptOut = await vectorModelOf(world);
    await put(false);

    // Assert
    expect(afterOptOut).toBe(FAKE_EMBEDDER_MODEL);
    expect(await vectorModelOf(world)).toBe(FAKE_EMBEDDER_MODEL);
  });

  test("the boot pass re-embeds what it rebuilt", async () => {
    // Arrange
    const embedder = createFakeEmbedder();
    const world = await seed(embedder);
    await optOutOnAnEarlierRelease(world);

    // Act
    await rebuildOptedOutLocationIndexes({ ...deps(world), embedder });

    // Assert
    expect(await vectorModelOf(world)).toBe(FAKE_EMBEDDER_MODEL);
  });
});

/**
 * THE DOC UPGRADE DOES NOT SPARE HER TITLES (the batch merge with the drafts
 * branch). That branch's upgrade STAMPS a declared-only doc current without
 * rebuilding it (services/doc-upgrade.ts), and her location-titled doc on a
 * hub from before both releases is declared-only: the stamp alone would mark
 * her branch title current. Her rebuild is keyed on her marker
 * (location_index_built_at), never on doc_version — the boot pass runs before
 * serving and the upgrades after it (index.ts), and the other order ends the
 * same.
 */
describe("a pre-upgrade hub: her declared-only, location-titled doc ends without her title, and current", () => {
  const SILENT: StartupLog = { info: () => undefined, error: () => undefined };

  /** Her context with one vouched claim, indexed before she opted out, its doc never stamped. */
  const preUpgradeHub = async (): Promise<World> => {
    const world = await seed();
    const posted = await postRecords(world.harness, world.robin, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_robin_lisbon", workContextId: CONTEXT, authorSessionId: ROBIN_S, body: "the old key stays valid for one window" }),
          { sessionId: ROBIN_S },
        ),
      ],
    });
    expect(posted.data?.rejected).toBe(0);
    await optOutOnAnEarlierRelease(world);
    await world.harness.db.execute(sql`UPDATE work_contexts SET doc_version = 0 WHERE id = ${CONTEXT}`);
    return world;
  };

  const docOf = async (world: World): Promise<{ readonly doc: string; readonly version: number }> => {
    const rows = await world.harness.db.execute<{ doc: string; version: number }>(
      sql`SELECT normalized_doc AS doc, doc_version AS version FROM work_contexts WHERE id = ${CONTEXT}`,
    );
    const row = rows.rows[0];
    if (row === undefined) {
      throw new Error(`no work context ${CONTEXT}`);
    }
    return { doc: row.doc, version: Number(row.version) };
  };

  const expectRebuiltWithoutHerTitle = async (world: World): Promise<void> => {
    const after = await docOf(world);
    expect(after.doc).not.toContain("lisbon");
    expect(after.version).toBe(NORMALIZED_DOC_VERSION);
    expect(await nickFinds(world, SECRET_BRANCH)).toBe(false);
    expect(await nickFinds(world, "refresh token rotation")).toBe(true);
  };

  test("in the boot's order: her rebuild before serving, the upgrades after", async () => {
    // Arrange
    const world = await preUpgradeHub();
    const before = await docOf(world);
    expect(before.doc).toContain("lisbon");
    expect(before.version).toBeLessThan(NORMALIZED_DOC_VERSION);

    // Act
    await rebuildOptedOutLocationIndexes(deps(world));
    await runStartupUpgrades({ db: world.harness.db, embedder: null, log: SILENT });

    // Assert
    await expectRebuiltWithoutHerTitle(world);
  });

  test("in the other order: a stamp first does not spare her doc the rebuild", async () => {
    // Arrange
    const world = await preUpgradeHub();

    // Act
    const upgrades = await runStartupUpgrades({ db: world.harness.db, embedder: null, log: SILENT });
    const stampedWithHerTitle = await docOf(world);
    await rebuildOptedOutLocationIndexes(deps(world));

    // Assert
    expect(upgrades.docs?.stamped).toBe(1);
    expect(stampedWithHerTitle.doc).toContain("lisbon");
    await expectRebuiltWithoutHerTitle(world);
  });
});
