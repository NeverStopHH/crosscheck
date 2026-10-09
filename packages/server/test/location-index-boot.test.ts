/**
 * AN OPT-OUT FROM BEFORE THE INDEX FOLLOWED THE SETTING, AT PILOT SCALE
 * (batch-2 integration review, M11; the boot pass is round 5's M1).
 *
 * Her location-titled docs were rebuilt BEFORE the port opened — every doc,
 * and with an embedder one embedder call per doc: 17–26 s keyless at 10 000
 * contexts, 88 s with a 5 ms embedder, 17–50 minutes at a real one's
 * latency. Now:
 *
 *   - before serving, her location-titled docs are EMPTIED in one statement
 *     (a doc with no words matches no guess at her branch, and no vector is
 *     left minted from her title), so the privacy promise holds from the
 *     first request on;
 *   - after serving, a background pass rebuilds them a page at a time, with a
 *     turn of the event loop between pages, and re-embeds each page in ONE
 *     embedder call; her index is marked built only once every page is done,
 *     so a start that dies mid-pass is finished by the next one.
 *
 * Until the pass reaches a doc, her context is found by its claims, as a
 * draft-folding doc is during the doc upgrade.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rebuildOptedOutLocationIndexes, withholdPendingLocationTitles } from "../src/services/developer-settings.ts";
import { backfillEmbeddings } from "../src/services/embedding-backfill.ts";
import type { Embedder } from "../src/services/embedder.ts";
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
const CONTEXTS = ["wc_robin_1", "wc_robin_2", "wc_robin_3"] as const;

interface World {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly robin: TestDeveloper;
}

/** An embedder that counts its calls. */
const countingEmbedder = (): { readonly embedder: Embedder; readonly calls: () => number } => {
  const inner = createFakeEmbedder();
  let calls = 0;
  return {
    embedder: {
      model: inner.model,
      embed: (texts) => {
        calls += 1;
        return inner.embed(texts);
      },
    },
    calls: () => calls,
  };
};

/** Her three contexts titled by her branch, each with a vouched finding, indexed while she was visible. */
const seed = async (embedder: Embedder | null = null): Promise<World> => {
  const harness = await createTestHarness({ embedder });
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
  await registerTestSession(harness, robin.apiKey, { id: ROBIN_S, branch: SECRET_BRANCH });
  const posted = await postRecords(harness, robin, {
    records: CONTEXTS.flatMap((id, index) => [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id, sessionId: ROBIN_S, title: `${SECRET_BRANCH} @ api ${String(index)}`, titleSource: "fallback", description: "refresh token rotation" }),
        { sessionId: ROBIN_S },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({ id: `clm_${id}`, workContextId: id, authorSessionId: ROBIN_S, body: "the old key stays valid for one window" }),
        { sessionId: ROBIN_S },
      ),
    ]),
  });
  expect(posted.data?.rejected).toBe(0);
  return { harness, nick, robin };
};

/** How an earlier release recorded an opt-out: the flag, and no rebuild. */
const optOutOnAnEarlierRelease = async (world: World): Promise<void> => {
  await world.harness.db.execute(sql`UPDATE developers SET presence_opt_out = true WHERE id = ${world.robin.developerId}`);
};

const nickFinds = async (world: World, query: string): Promise<readonly string[]> => {
  const params = new URLSearchParams({ repo: REPO, query });
  const response = await world.harness.app.request(`/api/search?${params.toString()}`, jsonRequest("GET", world.nick.apiKey));
  expect(response.status).toBe(200);
  const text = await response.text();
  return CONTEXTS.filter((id) => text.includes(id));
};

const docsOf = async (world: World): Promise<readonly string[]> =>
  (
    await world.harness.db.execute<{ doc: string }>(
      sql`SELECT normalized_doc AS doc FROM work_contexts WHERE id IN (${sql.join(CONTEXTS.map((id) => sql`${id}`), sql`, `)}) ORDER BY id`,
    )
  ).rows.map((row) => row.doc);

const markerOf = async (world: World): Promise<unknown> =>
  (await world.harness.db.execute<{ at: unknown }>(sql`SELECT location_index_built_at AS at FROM developers WHERE id = ${world.robin.developerId}`))
    .rows[0]?.at;

const vectorModelsOf = async (world: World): Promise<readonly unknown[]> =>
  (
    await world.harness.db.execute<{ model: unknown }>(
      sql`SELECT CASE WHEN embedding IS NULL THEN NULL ELSE embedding_model END AS model FROM work_contexts WHERE id IN (${sql.join(CONTEXTS.map((id) => sql`${id}`), sql`, `)}) ORDER BY id`,
    )
  ).rows.map((row) => row.model);

describe("before serving: her location-titled docs are emptied in one step (M11)", () => {
  test("a colleague's guess at her branch finds nothing from the first request on, and no vector of her title is left", async () => {
    // Arrange
    const world = await seed(createFakeEmbedder());
    await optOutOnAnEarlierRelease(world);
    expect(await nickFinds(world, SECRET_BRANCH)).toEqual([...CONTEXTS]);

    // Act
    const pending = await withholdPendingLocationTitles(world.harness.db);

    // Assert
    expect(pending).toBe(1);
    expect(await nickFinds(world, SECRET_BRANCH)).toEqual([]);
    expect(await docsOf(world)).toEqual(["", "", ""]);
    expect(await vectorModelsOf(world)).toEqual([null, null, null]);
    expect(await markerOf(world)).toBeNull();
  });

  test("a hub with no such opt-out empties nothing", async () => {
    // Arrange
    const world = await seed();

    // Act
    const pending = await withholdPendingLocationTitles(world.harness.db);

    // Assert
    expect(pending).toBe(0);
    expect(await nickFinds(world, SECRET_BRANCH)).toEqual([...CONTEXTS]);
  });
});

describe("after serving: the background pass rebuilds them (M11)", () => {
  test("her work is found by what it is about again, never by her branch, and her index is marked built", async () => {
    // Arrange
    const world = await seed();
    await optOutOnAnEarlierRelease(world);
    await withholdPendingLocationTitles(world.harness.db);

    // Act
    const rebuilt = await rebuildOptedOutLocationIndexes({ db: world.harness.db, now: world.harness.clock.now, embedder: null });

    // Assert
    expect(rebuilt).toBe(1);
    expect(await nickFinds(world, "refresh token rotation")).toEqual([...CONTEXTS]);
    expect(await nickFinds(world, SECRET_BRANCH)).toEqual([]);
    expect(await markerOf(world)).not.toBeNull();
  });

  test("a start that died after emptying her docs is finished by the next one", async () => {
    // Arrange — the first start emptied her docs and died before the pass
    const world = await seed();
    await optOutOnAnEarlierRelease(world);
    await withholdPendingLocationTitles(world.harness.db);

    // Act — the next start
    const again = await withholdPendingLocationTitles(world.harness.db);
    await rebuildOptedOutLocationIndexes({ db: world.harness.db, now: world.harness.clock.now, embedder: null });

    // Assert
    expect(again).toBe(1);
    expect(await nickFinds(world, "refresh token rotation")).toEqual([...CONTEXTS]);
    expect(await nickFinds(world, SECRET_BRANCH)).toEqual([]);
  });

  test("re-embeds a page of rebuilt docs in ONE embedder call", async () => {
    // Arrange
    const counting = countingEmbedder();
    const world = await seed(counting.embedder);
    await optOutOnAnEarlierRelease(world);
    await withholdPendingLocationTitles(world.harness.db);
    const before = counting.calls();

    // Act
    await rebuildOptedOutLocationIndexes({ db: world.harness.db, now: world.harness.clock.now, embedder: counting.embedder });

    // Assert
    expect(counting.calls() - before).toBe(1);
    expect(await vectorModelsOf(world)).toEqual([FAKE_EMBEDDER_MODEL, FAKE_EMBEDDER_MODEL, FAKE_EMBEDDER_MODEL]);
  });

  test("takes a turn of the event loop between pages", async () => {
    // Arrange
    const world = await seed();
    await optOutOnAnEarlierRelease(world);
    await withholdPendingLocationTitles(world.harness.db);
    let turned = false;
    setImmediate(() => {
      turned = true;
    });

    // Act
    const turnedBeforeTheEnd = await rebuildOptedOutLocationIndexes(
      { db: world.harness.db, now: world.harness.clock.now, embedder: null },
      { batch: 1 },
    ).then(() => turned);

    // Assert
    expect(turnedBeforeTheEnd).toBe(true);
  });
});

describe("GET /api/hub-status counts the vectors still to mint (M11)", () => {
  const vectorsPending = async (world: World): Promise<unknown> => {
    const response = await world.harness.app.request("/api/hub-status", jsonRequest("GET", world.nick.apiKey));
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { vectorsPending: unknown } }).data.vectorsPending;
  };

  test("with an embedder: the rebuilt docs not yet embedded, then 0 once the vector backfill has run", async () => {
    // Arrange — her docs rebuilt without their vectors (the pass ran keyless)
    const embedder = createFakeEmbedder();
    const world = await seed(embedder);
    await optOutOnAnEarlierRelease(world);
    await withholdPendingLocationTitles(world.harness.db);
    await rebuildOptedOutLocationIndexes({ db: world.harness.db, now: world.harness.clock.now, embedder: null });

    // Act
    const during = await vectorsPending(world);
    await backfillEmbeddings({ db: world.harness.db, embedder });
    const after = await vectorsPending(world);

    // Assert
    expect(during).toBe(CONTEXTS.length);
    expect(after).toBe(0);
  });

  test("a keyless hub says null: it mints no vectors at all", async () => {
    // Arrange
    const world = await seed();

    // Act
    const pending = await vectorsPending(world);

    // Assert
    expect(pending).toBeNull();
  });
});

describe("a request served between two pages of an opt-out's rebuild (M11)", () => {
  /** More location-titled contexts than one page holds, straight into the table. */
  const MANY = 150;

  test("never finds her by her branch: her docs are emptied before the first page", async () => {
    // Arrange
    const world = await seed();
    await world.harness.db.execute(sql`
      INSERT INTO work_contexts (id, session_id, title, title_source, status, normalized_doc, created_at)
      SELECT 'wc_many_' || lpad(g::text, 4, '0'), ${ROBIN_S}, ${SECRET_BRANCH}, NULL, 'analyzing',
             ${SECRET_BRANCH} || E'\nanalyzing', now()
      FROM generate_series(1, ${MANY}) g`);
    const params = new URLSearchParams({ repo: REPO, query: SECRET_BRANCH });
    let between: Promise<string> = Promise.resolve("never ran");
    setImmediate(() => {
      between = Promise.resolve(world.harness.app.request(`/api/search?${params.toString()}`, jsonRequest("GET", world.nick.apiKey))).then(
        (response) => response.text(),
      );
    });

    // Act
    const response = await world.harness.app.request("/api/settings/presence", jsonRequest("PUT", world.robin.apiKey, { optOut: true }));
    const seenBetween = await between;

    // Assert
    expect(response.status).toBe(200);
    expect(seenBetween).not.toBe("never ran");
    expect(seenBetween).not.toContain("wc_many_");
  });
});

describe("the toggle re-embeds a page in one call too (M11)", () => {
  test("opting out re-embeds her three rebuilt docs in one embedder call, not three", async () => {
    // Arrange
    const counting = countingEmbedder();
    const world = await seed(counting.embedder);
    const before = counting.calls();

    // Act
    const response = await world.harness.app.request("/api/settings/presence", jsonRequest("PUT", world.robin.apiKey, { optOut: true }));

    // Assert
    expect(response.status).toBe(200);
    expect(counting.calls() - before).toBe(1);
    expect((await docsOf(world)).filter((doc) => doc.includes("lisbon"))).toEqual([]);
    expect(await vectorModelsOf(world)).toEqual([FAKE_EMBEDDER_MODEL, FAKE_EMBEDDER_MODEL, FAKE_EMBEDDER_MODEL]);
  });
});
