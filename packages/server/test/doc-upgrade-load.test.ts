/**
 * THE HUB KEEPS ANSWERING WHILE THE START-UP DOC UPGRADE RUNS (review round
 * 4, H1). PGlite runs each statement synchronously and a chain of awaited
 * queries settles through microtasks only, so a pass that never yielded held
 * every incoming request until it finished: the review's load probe measured
 * one request at 18 873 ms during a 30 000-context keyless pass. The pass now
 * yields to the event loop after every rebuilt context; a request issued
 * while it runs is answered within RESPONSIVE_BOUND_MS.
 *
 * AFTER EVERY CONTEXT, NOT EVERY PAGE (CI, 2026-10-13). With a turn between
 * pages only, a request waited out the page it landed in: about 70 ms on a
 * laptop, but a 100-context page took about 390 ms on a slow macos-latest
 * runner, and the request there waited 624 ms.
 *
 * THE REQUEST ARRIVES WHILE THE PASS REBUILDS, not at a fixed moment after it
 * starts. Issued 20 ms in, it sometimes landed in the turns the pass takes
 * before its first page, and was answered there: on ubuntu-latest a pass that
 * never yielded inside its pages then passed this test (mutation proof, CI
 * run 38479737885). It is now issued, through a timer as a teammate's request
 * arrives, when the pass opens its first rebuild.
 */
import { describe, expect, test } from "bun:test";

import { DOC_UPGRADE_BATCH } from "../src/constants.ts";
import type { Db } from "../src/db/client.ts";
import { upgradeNormalizedDocs } from "../src/services/doc-upgrade.ts";
import { backfillEmbeddings } from "../src/services/embedding-backfill.ts";
import { createFakeEmbedder } from "./fixtures/fake-embedder.ts";
import { inMemoryUpgradeHub, seedPreRoundContexts } from "./fixtures/upgrade-hub.ts";
import type { UpgradeHub } from "./fixtures/upgrade-hub.ts";
import { jsonRequest, VALID_SESSION_BODY } from "./helpers.ts";

/** Enough pages that a pass which never yields outlasts the bound many times. */
const PASS_CONTEXTS = 3000;
/** The longest a request may wait on a running pass. */
const RESPONSIVE_BOUND_MS = 500;
/** When, into the vector backfill, the request is issued. */
const ISSUE_AFTER_MS = 20;
/** A teammate's request arrives as a timer: the next turn of the event loop that runs timers. */
const ON_THE_NEXT_TURN_MS = 0;
const LOAD_TEST_TIMEOUT_MS = 120_000;

interface Answered {
  readonly waitedMs: number;
  readonly duringPass: boolean;
}

/** Issues a teammate's request `afterMs` from now and times its answer. */
const requestDuring = (hub: UpgradeHub, isPassDone: () => boolean, afterMs: number): Promise<Answered> => {
  const scheduledAt = performance.now();
  return new Promise<Answered>((resolve, reject) => {
    setTimeout(() => {
      const params = new URLSearchParams({ repo: VALID_SESSION_BODY.repo });
      Promise.resolve(hub.harness.app.request(`/api/drafts?${params.toString()}`, jsonRequest("GET", hub.nick.apiKey)))
        .then((response) => response.arrayBuffer())
        .then(() => {
          resolve({ waitedMs: performance.now() - scheduledAt - afterMs, duringPass: !isPassDone() });
        }, reject);
    }, afterMs);
  });
};

/** Runs `pass` and, ISSUE_AFTER_MS into it, one timed request. */
const timeRequestDuring = async <T>(hub: UpgradeHub, pass: () => Promise<T>) => {
  let passDone = false;
  const running = pass().then((report) => {
    passDone = true;
    return report;
  });
  const answered = await requestDuring(hub, () => passDone, ISSUE_AFTER_MS);
  return { answered, report: await running };
};

/**
 * The hub's db for the doc upgrade, whose first transaction — the pass's
 * first rebuild (doc-upgrade.ts rebuildLocked) — calls `onFirst` before it
 * runs. The rest of the db is the hub's own.
 */
const onFirstRebuild = (db: Db, onFirst: () => void): Db => {
  const opened = { isFirst: true };
  return new Proxy(db, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      if (property !== "transaction") {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        if (opened.isFirst) {
          opened.isFirst = false;
          onFirst();
        }
        return value.apply(target, args);
      };
    },
  });
};

/** Runs the keyless doc upgrade in pages of `batch` and, as it opens its first rebuild, one timed request. */
const timeRequestDuringUpgrade = async (hub: UpgradeHub, batch: number) => {
  let passDone = false;
  const issued: Promise<Answered>[] = [];
  const db = onFirstRebuild(hub.harness.db, () => {
    issued.push(requestDuring(hub, () => passDone, ON_THE_NEXT_TURN_MS));
  });
  const report = await upgradeNormalizedDocs({ db, embedder: null }, { batch });
  passDone = true;
  const [answered] = await Promise.all(issued);
  if (answered === undefined) {
    throw new Error("the pass rebuilt nothing, so no request was issued during it");
  }
  return { answered, report };
};

describe("the hub keeps answering while the doc upgrade runs", () => {
  test(
    "a request issued during a keyless pass is answered within the bound, and the pass is still running",
    async () => {
      // Arrange
      const hub = await inMemoryUpgradeHub();
      await seedPreRoundContexts(hub.harness.db, PASS_CONTEXTS);

      // Act: the pass starts; a teammate's request arrives as it rebuilds
      const { answered, report } = await timeRequestDuringUpgrade(hub, DOC_UPGRADE_BATCH);

      // Assert
      expect(report.contexts).toBe(PASS_CONTEXTS);
      expect(answered.duringPass).toBe(true);
      expect(answered.waitedMs).toBeLessThan(RESPONSIVE_BOUND_MS);
    },
    LOAD_TEST_TIMEOUT_MS,
  );

  test(
    "a page is no wall: a request issued during a pass one page long is answered while it runs",
    async () => {
      // Arrange
      const hub = await inMemoryUpgradeHub();
      await seedPreRoundContexts(hub.harness.db, PASS_CONTEXTS);

      // Act: every context in one page
      const { answered, report } = await timeRequestDuringUpgrade(hub, PASS_CONTEXTS);

      // Assert
      expect(report.contexts).toBe(PASS_CONTEXTS);
      expect(answered.duringPass).toBe(true);
      expect(answered.waitedMs).toBeLessThan(RESPONSIVE_BOUND_MS);
    },
    LOAD_TEST_TIMEOUT_MS,
  );

  test(
    "a request issued during the vector backfill is answered within the bound",
    async () => {
      // Arrange: every context has a doc and no vector (a keyless hub's last pass)
      const hub = await inMemoryUpgradeHub();
      await seedPreRoundContexts(hub.harness.db, PASS_CONTEXTS);
      const embedder = createFakeEmbedder();

      // Act
      const { answered, report } = await timeRequestDuring(hub, () =>
        backfillEmbeddings({ db: hub.harness.db, embedder }),
      );

      // Assert
      expect(report.embedded).toBe(PASS_CONTEXTS);
      expect(answered.duringPass).toBe(true);
      expect(answered.waitedMs).toBeLessThan(RESPONSIVE_BOUND_MS);
    },
    LOAD_TEST_TIMEOUT_MS,
  );
});
