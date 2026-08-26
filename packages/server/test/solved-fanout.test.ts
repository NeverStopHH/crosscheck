/**
 * The COST of the solved-match listing, which is the one thing the functional
 * tests cannot see.
 *
 * `listSolvedMatches` runs on the SessionStart path, inside a 1000 ms hook
 * budget that also pays for presence, contexts, absences and questions. Its
 * shared-target tier used to be a self-join of `work_context_targets` against
 * itself: every pair of contexts sharing a value became a row, and the LIMIT
 * could only apply after the ORDER BY had materialized all of them. That is
 * quadratic in the number of contexts sharing ONE value — a lockfile, or the
 * error every session hits — and a seeded probe measured it at 1.2 SECONDS
 * with 2000 contexts sharing one fingerprint on a hub of 10^4 contexts. The
 * briefing does not degrade there, it disappears: the hook cuts the call at
 * its budget and fails open, silently, on exactly the busy hub where a team
 * memory is worth the most.
 *
 * So this seeds the crowded shape and bounds the WALL CLOCK. It is a cost
 * test, not a benchmark: the ceiling is generous enough that no loaded runner
 * trips it, and far below the quadratic behaviour it exists to catch. The
 * measurement is printed on every run, because a bound nobody reads is a
 * bound nobody notices moving.
 *
 * The correctness half is asserted first and matters more: the crowd must not
 * cost the answer.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  agentSessions,
  claims,
  workContextTargets,
  workContexts,
} from "../src/db/schema.ts";
import { listSolvedMatches } from "../src/services/solved-matches.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const FINGERPRINT = "sha256:1111222233334444555566667777888899990000";
const HOT_FILE = "bun.lock";
/**
 * Contexts sharing BOTH hot values. 400 of them are ~160 000 ordered pairs
 * per value under the old self-join, and ~800 target rows under a bounded
 * read — the gap the ceiling below turns into a test.
 */
const CROWD = 400;
/** Generous: the bounded shape measures at a few per cent of this. */
const CEILING_MS = 400;

const NOW = new Date("2026-08-26T09:00:00.000Z");
const daysAgo = (days: number): Date =>
  new Date(NOW.getTime() - days * 24 * 3600 * 1000);

describe("the solved-match listing on a crowded hub", () => {
  test(
    "one value shared by hundreds of contexts stays cheap",
    async () => {
      // Arrange
      const harness = await createTestHarness();
      const developer = await createTestDeveloper(harness, "Ken", "ken@acme.dev");
      await harness.db.insert(agentSessions).values([
        {
          id: "ses_old",
          developerId: developer.developerId,
          agentKind: "claude-code",
          repo: REPO,
          branch: "fix/rotation",
          baseCommit: "a1b2c3d4",
          status: "analyzing" as const,
          startedAt: daysAgo(200),
          lastHeartbeatAt: daysAgo(200),
        },
        {
          id: "ses_live",
          developerId: developer.developerId,
          agentKind: "claude-code",
          repo: REPO,
          branch: "feat/live",
          baseCommit: "a1b2c3d4",
          status: "analyzing" as const,
          startedAt: daysAgo(1),
          lastHeartbeatAt: daysAgo(0),
        },
      ]);

      // The answer: an old tree carrying the fingerprint, solved by an
      // evidenced, declared root cause.
      await harness.db.insert(workContexts).values([
        {
          id: "wc_solved",
          sessionId: "ses_old",
          title: "Refresh 500s after key rotation",
          status: "analyzing" as const,
          normalizedDoc: "refresh 500s after key rotation",
          createdAt: daysAgo(200),
          updatedAt: daysAgo(200),
        },
      ]);
      await harness.db.insert(claims).values([
        {
          id: "clm_solved",
          workContextId: "wc_solved",
          authorSessionId: "ses_old",
          kind: "observation" as const,
          status: "likely_root_cause" as const,
          body: "the rotation drops the key id before the importer retries",
          confidence: 0.9,
          captureMode: "agent" as const,
          provenance: "declared" as const,
          evidenceRefs: ["clm_evidence_row"],
          createdAt: daysAgo(199),
        },
      ]);

      // The crowd: live, unsolved, and all sharing the same two values — with
      // each other as much as with the answer.
      const crowdContexts = Array.from({ length: CROWD }, (_, index) => ({
        id: `wc_crowd_${String(index)}`,
        sessionId: "ses_live",
        title: `Lockfile churn ${String(index)}`,
        status: "analyzing" as const,
        normalizedDoc: `lockfile churn ${String(index)}`,
        createdAt: daysAgo(1),
        updatedAt: daysAgo(1),
      }));
      await harness.db.insert(workContexts).values(crowdContexts);
      await harness.db.insert(workContextTargets).values([
        {
          workContextId: "wc_solved",
          kind: "error_fingerprint" as const,
          value: FINGERPRINT,
        },
        { workContextId: "wc_solved", kind: "file" as const, value: HOT_FILE },
        ...crowdContexts.flatMap((context) => [
          {
            workContextId: context.id,
            kind: "error_fingerprint" as const,
            value: FINGERPRINT,
          },
          { workContextId: context.id, kind: "file" as const, value: HOT_FILE },
        ]),
      ]);

      // Act — ANALYZE first, because a planner working from default
      // estimates is measuring guesses rather than this query, and a real hub
      // has statistics. The first call is the warm-up (plan, cache, JIT) and
      // carries the correctness assertion; the SECOND is the measurement, so
      // the ceiling below is about the query's steady state rather than about
      // PGlite starting up.
      const deps = { db: harness.db, now: () => NOW };
      await harness.db.execute(sql`ANALYZE`);
      const matches = await listSolvedMatches(deps, developer.developerId, REPO);
      const startedAt = performance.now();
      await listSolvedMatches(deps, developer.developerId, REPO);
      const elapsedMs = Math.round(performance.now() - startedAt);

      // Assert — the answer first, then the cost
      expect(matches.map((match) => match.workContextId)).toEqual(["wc_solved"]);
      expect(matches[0]?.matchedTargetKind).toBe("error_fingerprint");
      console.log(
        `[solved-fanout] ${String(CROWD)} contexts sharing two values: ${String(elapsedMs)} ms (ceiling ${String(CEILING_MS)})`,
      );
      expect(elapsedMs).toBeLessThan(CEILING_MS);
    },
    30_000,
  );

  /**
   * The live side's own rules, which the bound above moved into a subquery
   * and nothing else pins: "current work" is work on THIS repo, active inside
   * SOLVED_MATCH_ACTIVE_WINDOW_DAYS. Every existing live-side test seeds a
   * solved tree with NO partner at all, and a self-match is excluded anyway —
   * so dropping the live filter entirely broke none of them.
   */
  test("a partner that is stale, or in another repo, is not current work", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(harness, "Ken", "ken@acme.dev");
    await harness.db.insert(agentSessions).values([
      {
        id: "ses_old",
        developerId: developer.developerId,
        agentKind: "claude-code",
        repo: REPO,
        branch: "fix/rotation",
        baseCommit: "a1b2c3d4",
        status: "analyzing" as const,
        startedAt: daysAgo(200),
        lastHeartbeatAt: daysAgo(200),
      },
      {
        id: "ses_here",
        developerId: developer.developerId,
        agentKind: "claude-code",
        repo: REPO,
        branch: "feat/live",
        baseCommit: "a1b2c3d4",
        status: "analyzing" as const,
        startedAt: daysAgo(1),
        lastHeartbeatAt: daysAgo(0),
      },
      {
        id: "ses_elsewhere",
        developerId: developer.developerId,
        agentKind: "claude-code",
        repo: "github.com/acme/web",
        branch: "feat/other",
        baseCommit: "a1b2c3d4",
        status: "analyzing" as const,
        startedAt: daysAgo(1),
        lastHeartbeatAt: daysAgo(0),
      },
    ]);
    await harness.db.insert(workContexts).values([
      {
        id: "wc_solved",
        sessionId: "ses_old",
        title: "Refresh 500s after key rotation",
        status: "analyzing" as const,
        normalizedDoc: "refresh 500s after key rotation",
        createdAt: daysAgo(200),
        updatedAt: daysAgo(200),
      },
      // Same repo, but last touched long before the window opens.
      {
        id: "wc_stale",
        sessionId: "ses_here",
        title: "Old rotation work",
        status: "analyzing" as const,
        normalizedDoc: "old rotation work",
        createdAt: daysAgo(90),
        updatedAt: daysAgo(90),
      },
      // Fresh, but somebody else's checkout.
      {
        id: "wc_elsewhere",
        sessionId: "ses_elsewhere",
        title: "Rotation work in the web app",
        status: "analyzing" as const,
        normalizedDoc: "rotation work in the web app",
        createdAt: daysAgo(1),
        updatedAt: daysAgo(1),
      },
    ]);
    await harness.db.insert(claims).values([
      {
        id: "clm_solved",
        workContextId: "wc_solved",
        authorSessionId: "ses_old",
        kind: "observation" as const,
        status: "likely_root_cause" as const,
        body: "the rotation drops the key id before the importer retries",
        confidence: 0.9,
        captureMode: "agent" as const,
        provenance: "declared" as const,
        evidenceRefs: ["clm_evidence_row"],
        createdAt: daysAgo(199),
      },
    ]);
    const fingerprintTarget = (workContextId: string) => ({
      workContextId,
      kind: "error_fingerprint" as const,
      value: FINGERPRINT,
    });
    await harness.db
      .insert(workContextTargets)
      .values([
        fingerprintTarget("wc_solved"),
        fingerprintTarget("wc_stale"),
        fingerprintTarget("wc_elsewhere"),
      ]);
    const deps = { db: harness.db, now: () => NOW };

    // Act & Assert: neither partner is current work here, so the tree stays
    // where it is.
    expect(await listSolvedMatches(deps, developer.developerId, REPO)).toEqual([]);

    // …and the CONTROL, so the silence above is the window and the repo
    // rather than a listing that never matches anything: one fresh context on
    // THIS repo, and the same tree surfaces.
    await harness.db.insert(workContexts).values([
      {
        id: "wc_now",
        sessionId: "ses_here",
        title: "Rotation 500s again",
        status: "analyzing" as const,
        normalizedDoc: "rotation 500s again",
        createdAt: daysAgo(1),
        updatedAt: daysAgo(1),
      },
    ]);
    await harness.db.insert(workContextTargets).values([fingerprintTarget("wc_now")]);
    const matches = await listSolvedMatches(deps, developer.developerId, REPO);
    expect(matches.map((match) => match.workContextId)).toEqual(["wc_solved"]);
  });
});
