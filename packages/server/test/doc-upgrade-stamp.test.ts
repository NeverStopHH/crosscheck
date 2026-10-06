/**
 * DECLARED-ONLY CONTEXTS ARE STAMPED A PAGE AT A TIME (round 5 follow-up to
 * review round 4, L2). The doc upgrade stamps every declared-only context
 * current without a rebuild; as one UPDATE, the freeze probe's 20 000 of them
 * held every request for ~400 ms — past the connector's 400 ms hook timeout.
 * Now each UPDATE takes one page, with a turn of the event loop between
 * pages: a callback queued before the pass runs right after the FIRST page.
 */
import { describe, expect, test } from "bun:test";

import type { Db } from "../src/db/client.ts";
import { upgradeNormalizedDocs } from "../src/services/doc-upgrade.ts";
import { inMemoryUpgradeHub, seedPreRoundContexts } from "./fixtures/upgrade-hub.ts";

const STAMP = "stamp";
const TURN = "turn";

/** The db, recording every UPDATE that sets the doc version alone — a stamp. */
const recordingStamps = (db: Db, events: string[]): Db =>
  new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== "update") {
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      return (table: never) => {
        const builder = target.update(table);
        return new Proxy(builder, {
          get(builderTarget, builderProp, builderReceiver) {
            const member = Reflect.get(builderTarget, builderProp, builderReceiver) as unknown;
            if (builderProp !== "set") {
              return typeof member === "function" ? (member as (...args: unknown[]) => unknown).bind(builderTarget) : member;
            }
            return (values: Record<string, unknown>) => {
              if (Object.keys(values).join() === "docVersion") {
                events.push(STAMP);
              }
              return builderTarget.set(values as never);
            };
          },
        });
      };
    },
  });

describe("the doc upgrade's stamp of declared-only contexts", () => {
  test("stamps one page per UPDATE, with a turn of the event loop between pages", async () => {
    // Arrange: five declared-only contexts, two to a page
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 5, { withDraft: false });
    const events: string[] = [];
    setImmediate(() => events.push(TURN));

    // Act
    const report = await upgradeNormalizedDocs(
      { db: recordingStamps(harness.db, events), embedder: null },
      { stampBatch: 2 },
    );

    // Assert: page, turn, page, last page — the callback did not wait for all of them
    expect(report.stamped).toBe(5);
    expect(events).toEqual([STAMP, TURN, STAMP, STAMP]);
  });

  test("a hub whose declared-only count is a whole number of pages stamps every one", async () => {
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 4, { withDraft: false });
    await seedPreRoundContexts(harness.db, 3, { prefix: "wd_" });

    const report = await upgradeNormalizedDocs({ db: harness.db, embedder: null }, { stampBatch: 2 });

    expect(report).toMatchObject({ contexts: 3, stamped: 4 });
    expect(await upgradeNormalizedDocs({ db: harness.db, embedder: null }, { stampBatch: 2 })).toMatchObject({
      contexts: 0,
      stamped: 0,
    });
  });
});
