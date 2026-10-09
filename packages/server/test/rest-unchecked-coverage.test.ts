/**
 * A COLLISION RECHECK THAT NEVER RAN LEAVES THE HUB'S COVERAGE ALONE
 * (integration review of batch 2, M3) — the review's probe, the other way
 * round. One owed recheck of a reaped session, booked by the REAL reaper and
 * read into the REAL wire report, turned the repo's agent_event rung
 * `incomplete / telemetry_lost` — so `isJudgeable` went false and the absence
 * answer said "agent telemetry on this repo was lost" — for the fourteen-day
 * window, although every record was delivered. It is a per-file count on the
 * developer's machine (connector-core test/rest-unchecked-scope.test.ts), and
 * the report the register carries no longer names it.
 */
import { describe, expect, test } from "bun:test";
import { rm, utimes } from "node:fs/promises";

import { EMPTY_LOSS_REPORT } from "@crosscheck/schema";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "../../connector-core/src/constants.ts";
import { repoKey, sessionStatePath } from "../../connector-core/src/config/paths.ts";
import { readTelemetryLossReport } from "../../connector-core/src/spool/loss-report.ts";
import { readCaptureLosses } from "../../connector-core/src/state/loss-ledger.ts";
import { reapStaleSessionStates } from "../../connector-core/src/state/session-reap.ts";
import { deriveSessionState, writeSessionState } from "../../connector-core/src/state/session-state.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";
import { readCoverage } from "../src/services/coverage.ts";
import { VALID_SESSION_BODY, createTestDeveloper, createTestHarness, registerTestSession } from "./helpers.ts";

const HUB_URL = "http://127.0.0.1:9";
const REPO = VALID_SESSION_BODY.repo;

describe("a rest whose recheck never ran, at the hub (review batch 2, M3)", () => {
  test("a reaped session's owed recheck is counted on the machine and leaves the repo's coverage complete", async () => {
    // Arrange: a dead session that still owed one recheck, reaped for real.
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const now = harness.clock.now();
    const deadAt = new Date(now.getTime() - (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY);
    const home = await makeHome("rest-coverage");
    try {
      await writeSessionState(home, {
        ...deriveSessionState({
          hostSessionKey: "dead-host",
          repoId: REPO,
          repoRoot: "/tmp/acme-api",
          hubUrl: HUB_URL,
          developerId: "dev_self",
          startedAt: deadAt.toISOString(),
        }),
        tripwireCheckedFiles: [{ file: "src/a.ts", at: deadAt.toISOString() }],
      });
      await utimes(sessionStatePath(home, "dead-host"), deadAt, deadAt);
      await reapStaleSessionStates(home, now);

      // Act: the next session registers with the machine's loss report.
      const report = await readTelemetryLossReport(home, repoKey(HUB_URL, REPO));
      const registered = await registerTestSession(harness, developer.apiKey, { losses: report });
      const coverage = await readCoverage({ db: harness.db, now: harness.clock.now }, developer.developerId, REPO);
      const agent = coverage.sources.find((row) => row.source === "agent_event");

      // Assert: booked where the developer reads it, and no gap on the hub.
      expect((await readCaptureLosses(home, repoKey(HUB_URL, REPO))).byKind["rest_unchecked"]).toBe(1);
      expect(report).toEqual(EMPTY_LOSS_REPORT);
      expect(registered.status).toBe(200);
      expect(agent?.state).not.toBe("incomplete");
      expect(agent?.reason).not.toBe("telemetry_lost");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
