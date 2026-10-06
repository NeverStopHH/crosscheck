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
import { inMemoryUpgradeHub, seedPreRoundContexts } from "./fixtures/upgrade-hub.ts";
import { jsonRequest, VALID_SESSION_BODY } from "./helpers.ts";

/** Enough pages that a pass which never yields outlasts the bound many times. */
const PASS_CONTEXTS = 3000;
/** The longest a request may wait on a running pass. */
const RESPONSIVE_BOUND_MS = 500;
/** When, into the pass, the request is issued. */
const ISSUE_AFTER_MS = 20;
const LOAD_TEST_TIMEOUT_MS = 120_000;

describe("the hub keeps answering while the doc upgrade runs", () => {
  test(
    "a request issued during a keyless pass is answered within the bound, and the pass is still running",
    async () => {
      // Arrange
      const { harness, nick } = await inMemoryUpgradeHub();
      await seedPreRoundContexts(harness.db, PASS_CONTEXTS);
      let passDone = false;

      // Act: the pass starts; a teammate's request arrives a moment later
      const pass = upgradeNormalizedDocs({ db: harness.db, embedder: null }).then((report) => {
        passDone = true;
        return report;
      });
      const scheduledAt = performance.now();
      const answered = await new Promise<{ readonly waitedMs: number; readonly duringPass: boolean }>((resolve, reject) => {
        setTimeout(() => {
          const params = new URLSearchParams({ repo: VALID_SESSION_BODY.repo });
          Promise.resolve(harness.app.request(`/api/drafts?${params.toString()}`, jsonRequest("GET", nick.apiKey)))
            .then((response) => response.arrayBuffer())
            .then(() => {
              resolve({ waitedMs: performance.now() - scheduledAt - ISSUE_AFTER_MS, duringPass: !passDone });
            }, reject);
        }, ISSUE_AFTER_MS);
      });
      const report = await pass;

      // Assert
      expect(report.contexts).toBe(PASS_CONTEXTS);
      expect(answered.duringPass).toBe(true);
      expect(answered.waitedMs).toBeLessThan(RESPONSIVE_BOUND_MS);
    },
    LOAD_TEST_TIMEOUT_MS,
  );
});
