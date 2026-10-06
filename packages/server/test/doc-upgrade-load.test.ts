/**
 * THE HUB KEEPS ANSWERING WHILE THE START-UP DOC UPGRADE RUNS (review round
 * 4, H1). PGlite runs each statement synchronously and a chain of awaited
 * queries settles through microtasks only, so a pass that never yielded held
 * every incoming request until it finished: the review's load probe measured
 * one request at 18 873 ms during a 30 000-context keyless pass. The pass now
 * yields to the event loop between pages; a request issued while it runs is
 * answered within RESPONSIVE_BOUND_MS.
 */
import { describe, expect, test } from "bun:test";

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
/** When, into the pass, the request is issued. */
const ISSUE_AFTER_MS = 20;
const LOAD_TEST_TIMEOUT_MS = 120_000;

interface Answered {
  readonly waitedMs: number;
  readonly duringPass: boolean;
}

/** Issues a teammate's request ISSUE_AFTER_MS from now and times its answer. */
const requestDuring = (hub: UpgradeHub, isPassDone: () => boolean): Promise<Answered> => {
  const scheduledAt = performance.now();
  return new Promise<Answered>((resolve, reject) => {
    setTimeout(() => {
      const params = new URLSearchParams({ repo: VALID_SESSION_BODY.repo });
      Promise.resolve(hub.harness.app.request(`/api/drafts?${params.toString()}`, jsonRequest("GET", hub.nick.apiKey)))
        .then((response) => response.arrayBuffer())
        .then(() => {
          resolve({ waitedMs: performance.now() - scheduledAt - ISSUE_AFTER_MS, duringPass: !isPassDone() });
        }, reject);
    }, ISSUE_AFTER_MS);
  });
};

/** Runs `pass` and, while it runs, one timed request. */
const timeRequestDuring = async <T>(hub: UpgradeHub, pass: () => Promise<T>) => {
  let passDone = false;
  const running = pass().then((report) => {
    passDone = true;
    return report;
  });
  const answered = await requestDuring(hub, () => passDone);
  return { answered, report: await running };
};

describe("the hub keeps answering while the doc upgrade runs", () => {
  test(
    "a request issued during a keyless pass is answered within the bound, and the pass is still running",
    async () => {
      // Arrange
      const hub = await inMemoryUpgradeHub();
      await seedPreRoundContexts(hub.harness.db, PASS_CONTEXTS);

      // Act: the pass starts; a teammate's request arrives a moment later
      const { answered, report } = await timeRequestDuring(hub, () =>
        upgradeNormalizedDocs({ db: hub.harness.db, embedder: null }),
      );

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
