/**
 * VER-8's measurement half — what the verdict COSTS on `GET /api/suspect`.
 *
 * §6 shipped with an explicit refusal: *"I ran no benchmark, so no millisecond
 * figure appears here; VER-8 requires one before merge."* This is that
 * benchmark, and it is a test rather than a figure in a document because a
 * number written down once is a number that stops being true.
 *
 * WHAT THE ALLOWANCE IS DERIVED FROM, rather than picked. This spec adds
 * exactly two things to the route: `readLiveWaiver`, which is ONE indexed
 * lookup on `(repo, pin_id, pin_version)`, and `computeVerdict`, which is pure
 * — no query, no clock beyond the one handed in. So the allowance is the cost
 * of one extra round trip to an embedded database. A p95 above it does not
 * mean "slow"; it means the added work is doing something other than one
 * indexed read, and that is a fact worth a red build.
 *
 * MEASURED AGAINST ITS OWN BASELINE, IN THE SAME PROCESS. Timing this branch
 * against a git checkout of the parent commit would compare two machines'
 * moods as much as two code paths. The route is timed whole, then the added
 * work is timed alone on the same seeded data, seconds later on one machine.
 *
 * THE NUMBERS ARE PRINTED, NOT ONLY ASSERTED — the shape
 * `connector-core/test/intent-budget.test.ts` uses. A ceiling tells you the
 * build is green; the printed p50/p95 is what somebody reads six months from
 * now when it stops being.
 */
import { describe, expect, test } from "bun:test";

import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { SUSPECT_WINDOW_DAYS } from "../src/constants.ts";

import { readLiveWaiver } from "../src/services/waivers.ts";
import { computeVerdict } from "../src/services/verdict.ts";
import { readCoverage } from "../src/services/coverage.ts";
import { resolveSuspectScope, suspectSessions } from "../src/services/suspect.ts";
import {
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const PIN = "pin_playback";
const PINNED_A = "src/workbench/PlaybackControls.tsx";
const PINNED_B = "src/workbench/usePlayback.ts";
const PINNED_FILES = 2;

/**
 * Enough samples for a p95 to name a real tail rather than one scheduling
 * hiccup, and few enough that this file stays a test rather than a suite.
 */
const SAMPLES = 40;
/** Discarded: the first requests pay for query plans nobody else pays for. */
const WARMUP = 5;
/** Sessions touching the pinned files, so the ranking has work to do. */
const SESSIONS = 6;

/**
 * THE ALLOWANCE, derived: one indexed lookup on an embedded PGlite database,
 * with room for the process to be doing something else at the moment it runs.
 * `intent-budget.test.ts` measures comparable single acquisitions in the low
 * single-digit milliseconds uncontended; ten is that with an order of
 * magnitude of headroom, which is the right shape for a ceiling meant to catch
 * "this became a table scan" rather than "this machine was busy".
 */
const VERDICT_ALLOWANCE_MS = 10;

const PERCENT = 100;
const MS_PER_DAY = 86_400_000;

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] ?? 0;
};

const seedSession = async (
  harness: TestHarness,
  developer: TestDeveloper,
  index: number,
): Promise<void> => {
  const sessionId = `cc_1111111${String(index)}-2222-4333-8444-555555555555`;
  const contextId = `wc_${sessionId}`;
  await postRecords(harness, developer, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: contextId,
          sessionId,
          title: `rework the playback controls, pass ${String(index)}`,
          description: undefined,
          createdAt: TEST_START_ISO,
        }),
        { sessionId },
      ),
      ...[PINNED_A, PINNED_B].map((value) =>
        recordEnvelope(
          "target",
          { workContextId: contextId, kind: "file", value },
          { sessionId },
        ),
      ),
    ],
  });
};

const setup = async (): Promise<{
  harness: TestHarness;
  developer: TestDeveloper;
}> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick@example.com",
  );
  await harness.app.request(
    "/api/pins",
    jsonRequest("POST", developer.apiKey, {
      id: PIN,
      repo: REPO,
      surface: "Play button plays/pauses",
      files: [PINNED_A, PINNED_B],
      check: "open /workbench, press Play",
      presence: PIN_PRESENCE_TERMINAL,
      verifiedAtCommit: "abc1234",
    }),
  );
  for (let index = 0; index < SESSIONS; index += 1) {
    await seedSession(harness, developer, index);
  }
  return { harness, developer };
};

describe("VER-8 — what the verdict costs", () => {
  test(
    "the route answers, and the added work stays inside one indexed read",
    async () => {
      // Arrange
      const { harness, developer } = await setup();
      const path = `/api/suspect?repo=${encodeURIComponent(REPO)}&pin=${PIN}`;
      const ask = async (): Promise<Response> =>
        harness.app.request(path, jsonRequest("GET", developer.apiKey));

      for (let index = 0; index < WARMUP; index += 1) {
        await ask();
      }

      // Act — the whole route, as a reader waits for it
      const routeSamples: number[] = [];
      for (let index = 0; index < SAMPLES; index += 1) {
        const started = performance.now();
        const response = await ask();
        routeSamples.push(performance.now() - started);
        expect(response.status).toBe(200);
      }

      // Arrange — the route's PRE-EXISTING work, read once outside the loop.
      // Timing it inside would measure the baseline rather than the addition.
      const now = new Date(TEST_START_ISO);
      const deps = { db: harness.db, now: () => now };
      const resolved = await resolveSuspectScope(deps, REPO, {
        pinId: PIN,
        paths: [],
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) {
        return;
      }
      const view = await suspectSessions(deps, developer.developerId, {
        repo: REPO,
        scope: resolved.scope,
        attribution: "sessions",
      });
      // SCOPED TO THE PINNED FILES, exactly as the route does (03 §3.2a):
      // a coverage record about the whole repo would answer a different
      // question and read a different amount of data.
      const coverage = await readCoverage(deps, developer.developerId, REPO, {
        scope: {
          sinceIso: new Date(
            now.getTime() - SUSPECT_WINDOW_DAYS * MS_PER_DAY,
          ).toISOString(),
          paths: resolved.scope.files,
        },
      });
      const invariant =
        resolved.scope.pinId === null || resolved.scope.pinVersion === null
          ? null
          : {
              pinId: resolved.scope.pinId,
              version: resolved.scope.pinVersion,
            };

      // Act — and the two things THIS SPEC added, alone, on the same data
      const verdictSamples: number[] = [];
      for (let index = 0; index < SAMPLES; index += 1) {
        const started = performance.now();
        const waiver =
          invariant === null
            ? null
            : await readLiveWaiver({
                db: harness.db,
                repo: REPO,
                pinId: invariant.pinId,
                pinVersion: invariant.version,
                now,
              });
        computeVerdict({
          repo: REPO,
          suspect: view,
          coverage,
          delta: null,
          deltaLane: "pin",
          timing: "absent",
          timingReason: "no_intent",
          evidence: {
            who: "agent_derived",
            support: "unsupported",
            supportReason: "no_verification_ref",
            observedAt: null,
            verifiedAtCommit: null,
          },
          invariant,
          liveWaiver: waiver,
          now,
        });
        verdictSamples.push(performance.now() - started);
      }

      const routeP50 = percentile(routeSamples, 0.5);
      const routeP95 = percentile(routeSamples, 0.95);
      const verdictP50 = percentile(verdictSamples, 0.5);
      const verdictP95 = percentile(verdictSamples, 0.95);

      console.log(
        `[verdict-latency] GET /api/suspect p50 ${routeP50.toFixed(2)} ms, ` +
          `p95 ${routeP95.toFixed(2)} ms ` +
          `(${String(SESSIONS)} sessions on ${String(PINNED_FILES)} pinned files, embedded PGlite)`,
      );
      console.log(
        `[verdict-latency] the verdict's own share p50 ${verdictP50.toFixed(2)} ms, ` +
          `p95 ${verdictP95.toFixed(2)} ms ` +
          `(readLiveWaiver + computeVerdict; allowance ${String(VERDICT_ALLOWANCE_MS)} ms = one indexed lookup)`,
      );
      console.log(
        `[verdict-latency] the verdict is ${((verdictP95 / routeP95) * PERCENT).toFixed(1)}% of the route's p95`,
      );

      // Assert — A BENCHMARK THAT MEASURED NOTHING IS GREEN, and that is the
      // failure mode a latency test dies of: `percentile([])` is 0, and 0 is
      // under every ceiling anybody will ever write. So the samples have to
      // exist and the work has to have taken time before the ceiling means
      // anything at all.
      expect(routeSamples.length).toBe(SAMPLES);
      expect(verdictSamples.length).toBe(SAMPLES);
      expect(verdictP50).toBeGreaterThan(0);

      // Assert — the ceiling is on THE ADDED WORK, which is what this spec is
      // accountable for. Putting one on the route's total would make an
      // unrelated regression elsewhere read as a verdict problem.
      expect(verdictP95).toBeLessThan(VERDICT_ALLOWANCE_MS);
    },
    // Generous: 40 route samples on an embedded database, plus seeding. The
    // printed figures are what to read if this ever approaches the timeout.
    120_000,
  );
});
