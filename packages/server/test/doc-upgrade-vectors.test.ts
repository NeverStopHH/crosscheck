/**
 * NO VECTOR IS LOST FOR GOOD (review round 4, H2). A rebuild nulls the
 * context's embedding (a vector of the old doc no longer describes the new
 * one) and stamps the version in the same UPDATE — so anything that kept the
 * re-embed from landing used to lose the vector for good: an embedder that
 * threw (the error was swallowed and the context counted re-embedded), a
 * start with no embedder configured, a kill between the rebuild and the
 * embed. Nothing re-embedded a null vector afterwards.
 *
 * Now each page is embedded in one call right after it is rebuilt, only
 * stored vectors are counted, and with an embedder configured every start
 * re-embeds whatever has no vector — or one from another model — so each
 * loss heals on the next start that has an embedder.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import type { Db } from "../src/db/client.ts";
import type { Embedder } from "../src/services/embedder.ts";
import { backfillEmbeddings } from "../src/services/embedding-backfill.ts";
import { upgradeNormalizedDocs } from "../src/services/doc-upgrade.ts";
import { createFakeEmbedder } from "./fixtures/fake-embedder.ts";
import { inMemoryUpgradeHub, seedPreRoundContexts } from "./fixtures/upgrade-hub.ts";

interface VectorRow {
  readonly id: string;
  readonly has_embedding: boolean;
  readonly embedding_model: string | null;
}

const vectors = async (db: Db): Promise<readonly VectorRow[]> =>
  (await db.execute(sql`SELECT id, embedding IS NOT NULL AS has_embedding, embedding_model FROM work_contexts ORDER BY id`))
    .rows as unknown as readonly VectorRow[];

/** An embedder whose `failOn`-th call throws, as a provider's 503 would. */
const flaky = (failOn: number): Embedder => {
  const fake = createFakeEmbedder();
  let calls = 0;
  return {
    model: fake.model,
    embed: async (texts) => {
      calls += 1;
      if (calls === failOn) {
        throw new Error("HTTP 503 from the embedding provider");
      }
      return fake.embed(texts);
    },
  };
};

/** An embedder whose every call hangs: the process is killed before it answers. */
const hanging = (model: string): Embedder => ({
  model,
  embed: () => new Promise(() => undefined),
});

const giveOldVectors = async (db: Db, ids: readonly string[], embedder: Embedder, model: string) => {
  for (const id of ids) {
    const [vector] = await embedder.embed([`old doc ${id}`]);
    await db.execute(sql`UPDATE work_contexts SET embedding = ${JSON.stringify(vector)}::vector, embedding_model = ${model} WHERE id = ${id}`);
  }
};

describe("a rebuild never keeps the vector of the doc it replaced", () => {
  test("a keyless rebuild clears the old vector and its model, so the drafts' meaning leaves the vector tier", async () => {
    // Arrange: a vector minted from the pre-round doc, drafts folded in
    const { harness } = await inMemoryUpgradeHub();
    const ids = await seedPreRoundContexts(harness.db, 1);
    const fake = createFakeEmbedder();
    await giveOldVectors(harness.db, ids, fake, fake.model);

    // Act
    await upgradeNormalizedDocs({ db: harness.db, embedder: null });

    // Assert
    expect(await vectors(harness.db)).toEqual([{ id: ids[0] ?? "", has_embedding: false, embedding_model: null }]);
  });
});

describe("the rebuild embeds what it rebuilt, and counts only what landed", () => {
  test("an embedder that throws on one page heals on the next start", async () => {
    // Arrange: three contexts, one page each; the second embed call fails
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 3);

    // Act
    const first = await upgradeNormalizedDocs({ db: harness.db, embedder: flaky(2) }, { batch: 1 });
    const afterFirst = await vectors(harness.db);
    const nextStart = await backfillEmbeddings({ db: harness.db, embedder: createFakeEmbedder() });

    // Assert: the failure is counted as one, not as a re-embed, and healed
    expect(first).toEqual({ contexts: 3, stamped: 0, reembedded: 2, embedFailures: 1 });
    expect(afterFirst.map((row) => row.has_embedding)).toEqual([true, false, true]);
    expect(nextStart).toEqual({ embedded: 1, failed: 0 });
    expect((await vectors(harness.db)).every((row) => row.has_embedding)).toBe(true);
  });

  test("a page is embedded in one call, not one call per context", async () => {
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 5);
    const fake = createFakeEmbedder();
    const batches: number[] = [];
    const counting: Embedder = { model: fake.model, embed: (texts) => (batches.push(texts.length), fake.embed(texts)) };

    await upgradeNormalizedDocs({ db: harness.db, embedder: counting });

    expect(batches).toEqual([5]);
  });
});

describe("every start with an embedder re-embeds what has no current vector", () => {
  test("a keyless start followed by a start with an embedder restores every vector", async () => {
    // Arrange: two pre-round contexts with vectors of their old docs
    const { harness } = await inMemoryUpgradeHub();
    const ids = await seedPreRoundContexts(harness.db, 2);
    const fake = createFakeEmbedder();
    await giveOldVectors(harness.db, ids, fake, fake.model);

    // Act: this boot had no embedder configured; the next one does
    await upgradeNormalizedDocs({ db: harness.db, embedder: null });
    const keyless = await vectors(harness.db);
    const restored = await backfillEmbeddings({ db: harness.db, embedder: fake });

    // Assert
    expect(keyless.map((row) => row.has_embedding)).toEqual([false, false]);
    expect(restored).toEqual({ embedded: 2, failed: 0 });
    expect(await vectors(harness.db)).toEqual(ids.map((id) => ({ id, has_embedding: true, embedding_model: fake.model })));
  });

  test("a kill between the rebuild and the embed heals on the next start", async () => {
    // Arrange: the embed of the first page never answers — the process dies there
    const { harness } = await inMemoryUpgradeHub();
    const ids = await seedPreRoundContexts(harness.db, 4);
    const fake = createFakeEmbedder();
    void upgradeNormalizedDocs({ db: harness.db, embedder: hanging(fake.model) }, { batch: 2 });
    await waitUntil(async () => (await rebuiltCount(harness.db)) >= 2);

    // Act: the next start, with a working embedder
    await upgradeNormalizedDocs({ db: harness.db, embedder: fake }, { batch: 2 });
    await backfillEmbeddings({ db: harness.db, embedder: fake });

    // Assert: every context rebuilt, every one with a vector
    expect(await rebuiltCount(harness.db)).toBe(ids.length);
    expect((await vectors(harness.db)).every((row) => row.has_embedding)).toBe(true);
  });

  test("a vector from another model is re-embedded with the current one", async () => {
    const { harness } = await inMemoryUpgradeHub();
    const ids = await seedPreRoundContexts(harness.db, 1, { withDraft: false });
    const fake = createFakeEmbedder();
    await giveOldVectors(harness.db, ids, fake, "some-older-model");

    expect(await backfillEmbeddings({ db: harness.db, embedder: fake })).toEqual({ embedded: 1, failed: 0 });
    expect((await vectors(harness.db))[0]?.embedding_model).toBe(fake.model);
  });

  test("a vector cleared by hand, its model left in place, is re-embedded", async () => {
    // Arrange: an operator forces a re-embed by clearing the vector only
    const { harness } = await inMemoryUpgradeHub();
    const ids = await seedPreRoundContexts(harness.db, 1, { withDraft: false });
    const fake = createFakeEmbedder();
    await giveOldVectors(harness.db, ids, fake, fake.model);
    await harness.db.execute(sql`UPDATE work_contexts SET embedding = NULL`);

    // Act
    const restored = await backfillEmbeddings({ db: harness.db, embedder: fake });

    // Assert
    expect(restored).toEqual({ embedded: 1, failed: 0 });
    expect((await vectors(harness.db))[0]?.has_embedding).toBe(true);
  });

  test("a doc rebuilt while its embed is in flight keeps no vector of the old doc", async () => {
    // Arrange: while the provider answers, an ingest rebuilds the context's doc
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 1, { withDraft: false });
    const fake = createFakeEmbedder();
    const ingestMidEmbed: Embedder = {
      model: fake.model,
      embed: async (texts) => {
        await harness.db.execute(sql`UPDATE work_contexts SET normalized_doc = normalized_doc || E'\nobservation: late finding'`);
        return fake.embed(texts);
      },
    };

    // Act
    const raced = await backfillEmbeddings({ db: harness.db, embedder: ingestMidEmbed });
    const afterRace = await vectors(harness.db);
    const nextStart = await backfillEmbeddings({ db: harness.db, embedder: fake });

    // Assert: the stale vector is not stored; the next start embeds the new doc
    expect(raced).toEqual({ embedded: 0, failed: 1 });
    expect(afterRace[0]?.has_embedding).toBe(false);
    expect(nextStart).toEqual({ embedded: 1, failed: 0 });
  });

  test("a start whose vectors are all current embeds nothing", async () => {
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 2);
    const fake = createFakeEmbedder();
    await upgradeNormalizedDocs({ db: harness.db, embedder: fake });

    expect(await backfillEmbeddings({ db: harness.db, embedder: fake })).toEqual({ embedded: 0, failed: 0 });
  });
});

const rebuiltCount = async (db: Db): Promise<number> =>
  ((await db.execute(sql`SELECT count(*)::int AS n FROM work_contexts WHERE doc_version > 0`)).rows[0] as { n: number }).n;

const POLL_MS = 10;
const POLL_LIMIT_MS = 5000;

const waitUntil = async (condition: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil: gave up");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
};
