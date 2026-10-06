/**
 * A CONCURRENT INGEST NEVER LOSES ITS CLAIM FROM A REBUILT DOC (review round
 * 4, M1). The pass rebuilds a doc in two steps — read the context's claims,
 * write the doc — and PGlite's FIFO lets a queued ingest run between any two
 * statements outside a transaction. The review pinned the gap that matters:
 * an ingest that commits a vouched claim after the pass read the claims and
 * before it wrote the doc. Its own rebuild then lands first, the pass's
 * stale write lands on top, and the context is stamped current without the
 * claim — for good. Each rebuild now runs in one transaction that locks the
 * row (FOR UPDATE), so the ingest waits and rebuilds after it.
 *
 * The interleave is the review's: the first doc write of the pass is held
 * for a real timer turn with the ingest already in flight — whether the pass
 * runs that write inside a transaction or not.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import type { Db } from "../src/db/client.ts";
import { upgradeNormalizedDocs } from "../src/services/doc-upgrade.ts";
import { inMemoryUpgradeHub, seedPreRoundContexts } from "./fixtures/upgrade-hub.ts";
import { postRecords, recordEnvelope, validClaimBody } from "./helpers.ts";

/** How long the held doc write gives a queued ingest to run. */
const HOLD_MS = 50;

type Hold = () => Promise<void>;

interface UpdateBuilder {
  set: (values: Record<string, unknown>) => { where: (condition: unknown) => PromiseLike<unknown> };
}

/**
 * `update(...)` as the target builds it, except that a DOC write
 * (`set({ normalizedDoc, … }).where(…)`) waits on `hold` before it runs.
 * Every other update is the target's own builder, untouched.
 */
const holdingUpdate =
  (target: { update: (table: never) => unknown }, hold: Hold) =>
  (table: never) => {
    const builder = target.update(table) as UpdateBuilder;
    return new Proxy(builder, {
      get(builderTarget, prop, receiver) {
        if (prop !== "set") {
          const value = Reflect.get(builderTarget, prop, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(builderTarget) : value;
        }
        return (values: Record<string, unknown>) => {
          const set = builderTarget.set(values);
          if (!("normalizedDoc" in values)) {
            return set;
          }
          return {
            where: (condition: unknown) => {
              const query = set.where(condition);
              return {
                then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                  hold()
                    .then(() => query)
                    .then(resolve, reject),
              };
            },
          };
        };
      },
    });
  };

/** The db, with every doc write — top level or inside a transaction — held once. */
const racing = (db: Db, hold: Hold): Db =>
  new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "update") {
        return holdingUpdate(target as never, hold);
      }
      if (prop === "transaction") {
        return (run: (tx: unknown) => Promise<unknown>, config?: unknown) =>
          target.transaction(
            (tx) =>
              run(
                new Proxy(tx, {
                  get(txTarget, txProp, txReceiver) {
                    if (txProp === "update") {
                      return holdingUpdate(txTarget as never, hold);
                    }
                    const value = Reflect.get(txTarget, txProp, txReceiver) as unknown;
                    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(txTarget) : value;
                  },
                }),
              ),
            config as never,
          );
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as Db;

describe("a rebuild and a concurrent ingest", () => {
  test("a vouched claim committed while the pass rebuilds its context stays in the doc", async () => {
    // Arrange: one pre-round context with a draft
    const { harness, nick } = await inMemoryUpgradeHub();
    const [id] = await seedPreRoundContexts(harness.db, 1);
    let ingest: Promise<unknown> = Promise.resolve();
    let held = false;
    const hold: Hold = async () => {
      if (held) {
        return;
      }
      held = true;
      // The ingest is in flight; give it a real turn to run before the write
      ingest = postRecords(harness, nick, {
        records: [recordEnvelope("claim", validClaimBody({ id: "clm_late", workContextId: id, body: "lateconfirmedfinding in the parser" }))],
      });
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    };

    // Act
    await upgradeNormalizedDocs({ db: racing(harness.db, hold), embedder: null });
    await ingest;

    // Assert: the ingest's claim is in the doc the context is stamped with
    const row = (await harness.db.execute(sql`SELECT normalized_doc, doc_version FROM work_contexts WHERE id = ${id}`)).rows[0] as {
      normalized_doc: string;
      doc_version: number;
    };
    expect(held).toBe(true);
    expect(row.normalized_doc).toContain("lateconfirmedfinding");
  });
});
