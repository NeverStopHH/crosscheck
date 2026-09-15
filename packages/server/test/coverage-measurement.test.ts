/**
 * The two tests that produce NUMBERS (03 COV-8 and COV-11).
 *
 * COV-8 — the budget is measured, not asserted. §6 states no millisecond
 * figure and says so; this is where one comes from.
 *
 *   WHERE THE MEASUREMENT BELONGS, and why it is not where the spec pointed.
 *   COV-8 names `connector-claude/test/capture-latency.test.ts`. That harness
 *   measures PostToolUse and PreToolUse against a DEAD hub (127.0.0.1:1); it
 *   never invokes SessionStart and never stands a hub up, so it cannot
 *   measure "SessionStart p95 with coverage riding /api/absences" at all.
 *
 *   More to the point, the CONNECTOR'S cost is unchanged BY CONSTRUCTION:
 *   this spec adds zero hub round trips on every hook path, so a
 *   process-level p95 would measure machine noise rather than this change.
 *   What this change actually adds is HUB-SIDE WORK inside a response the
 *   hook already waits for, and that is what is measured here — against the
 *   bound that really binds — the connector's per-request timeout — because a
 *   response slower than it reaches the connector as nothing at all.
 *
 *   The end-to-end hook budgets stay where they already were:
 *   connector-claude/test/hook-time-budget.test.ts drives the real binary
 *   against the 1000 / 800 / 1600 ms ceilings.
 *
 * COV-11 — the state distribution, measured before merge rather than argued
 * about. §5.1's noise argument and §10.4's default both assume `incomplete`
 * is occasional. Unscoped, over the measured trial's shape, it is not. The
 * test ASSERTS NO THRESHOLD: its job is to make that decision reviewable on
 * data, which is what the first draft of the spec could not do.
 */
import { describe, expect, test } from "bun:test";

import { SESSION_REAP_STALE_HOURS } from "../src/constants.ts";
import {
  agentSessions,
  commitEvidence,
  workContextTargets,
  workContexts,
} from "../src/db/schema.ts";
import { listAbsences } from "../src/services/absences.ts";
import { isJudgeable, readCoverage } from "../src/services/coverage.ts";
import {
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

/**
 * THE NAMED ALLOWANCE, and it is not a number somebody liked: it is the
 * connector's per-request timeout. A response slower than this reaches the
 * connector as nothing at all — fail-open, no absences, no coverage — which
 * is the failure this measurement exists to prevent. The server package does
 * not depend on the connector, so the value is restated here and pinned
 * against its source:
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.HTTP_TIMEOUT_MS)'
 * PRINTS: 400
 */
const HUB_RESPONSE_ALLOWANCE_MS = 400;

const REPO = "github.com/acme/api";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The measured trial (connector-core/src/state/capture-health.ts:23-30). */
const TRIAL_SESSIONS = 127;
const TRIAL_NEVER_CLOSED = 104;
/** Distinct files the fixture's sessions touch — the pin-sized questions. */
const TRIAL_FILES = 40;

const at = (offsetMs: number): Date =>
  new Date(new Date(TEST_START_ISO).getTime() + offsetMs);

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
};

interface TrialFixture {
  readonly harness: TestHarness;
  readonly viewerId: string;
  readonly files: readonly string[];
}

/**
 * A repo shaped like the measured trial: 127 sessions, 104 of which never
 * closed (the hub reaps them after SESSION_REAP_STALE_HOURS), each touching
 * one file of a 40-file surface.
 */
const trialRepo = async (
  options: {
    readonly neverClosed?: number;
    /**
     * Whether the sessions the reaper closed ever reported a file target.
     * Default true — and that default is why this fixture could not exhibit
     * the scoping hole it was written to measure: a reaped session WITH a
     * target row is visible to a scoped read, and one reaped before it
     * reported anything is the case that used to vanish from it.
     */
    readonly reapedReportTargets?: boolean;
  } = {},
): Promise<TrialFixture> => {
  const neverClosedCount = options.neverClosed ?? TRIAL_NEVER_CLOSED;
  const reapedReportTargets = options.reapedReportTargets ?? true;
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick@example.com",
  );
  const files = Array.from(
    { length: TRIAL_FILES },
    (_unused, index) => `src/mod/file${String(index).padStart(3, "0")}.ts`,
  );
  const sessions = Array.from({ length: TRIAL_SESSIONS }, (_unused, index) => {
    const neverClosed = index < neverClosedCount;
    const heartbeat = at(-(index + 1) * 90 * MINUTE_MS);
    return {
      id: `ses_${String(index).padStart(3, "0")}`,
      developerId: developer.developerId,
      agentKind: "claude-code",
      repo: REPO,
      branch: "main",
      baseCommit: "a1b2c3d4",
      status: "analyzing" as const,
      startedAt: new Date(heartbeat.getTime() - 30 * MINUTE_MS),
      lastHeartbeatAt: heartbeat,
      // A reap closes it on a guess after six hours of silence; a reported
      // end closes it as a fact.
      endedAt: neverClosed
        ? new Date(heartbeat.getTime() + SESSION_REAP_STALE_HOURS * HOUR_MS)
        : new Date(heartbeat.getTime() + MINUTE_MS),
      reapedAt: neverClosed
        ? new Date(heartbeat.getTime() + SESSION_REAP_STALE_HOURS * HOUR_MS)
        : null,
    };
  });
  await harness.db.insert(agentSessions).values(sessions);
  const reporting = sessions.filter(
    (session, index) =>
      reapedReportTargets || index >= neverClosedCount || session.reapedAt === null,
  );
  await harness.db.insert(workContexts).values(
    reporting.map((session) => ({
      id: `wc_${session.id}`,
      sessionId: session.id,
      title: "work",
      status: "analyzing" as const,
      createdAt: session.lastHeartbeatAt,
    })),
  );
  await harness.db.insert(workContextTargets).values(
    reporting.map((session, index) => ({
      workContextId: `wc_${session.id}`,
      kind: "file" as const,
      value: files[index % TRIAL_FILES] ?? "src/a.ts",
      source: "tool_edit" as const,
      createdAt: at(-index * MINUTE_MS),
    })),
  );
  await harness.db.insert(commitEvidence).values({
    repo: REPO,
    authorEmail: "nick@example.com",
    authorName: "nick-git",
    latestCommitAt: at(-2 * HOUR_MS),
    commitCount: 40,
    windowDays: 14,
    collectedAt: at(-HOUR_MS),
    reportedBy: developer.developerId,
  });
  return { harness, viewerId: developer.developerId, files };
};

describe("COV-8: what coverage costs the response it rides", () => {
  test("p95 of GET /api/absences' work stays inside one request timeout", async () => {
    // Arrange: the trial-shaped repo, so the numbers are about a real corpus
    const { harness, viewerId } = await trialRepo();
    const deps = { db: harness.db, now: harness.clock.now };
    const rounds = 20;
    const before: number[] = [];
    const after: number[] = [];

    // Act: (a) the work this endpoint did BEFORE this spec, (b) the work it
    // does now — the listing for the findings, plus coverage, whose git rung
    // asks the absence question again UNBOUNDED, because the listing's own
    // answer is a cut rather than a census.
    for (let round = 0; round < rounds; round += 1) {
      const startBefore = performance.now();
      await listAbsences(deps, viewerId, REPO);
      before.push(performance.now() - startBefore);

      const startAfter = performance.now();
      await listAbsences(deps, viewerId, REPO);
      await readCoverage(deps, viewerId, REPO);
      after.push(performance.now() - startAfter);
    }
    const p95Before = percentile(before, 0.95);
    const p95After = percentile(after, 0.95);
    process.stdout.write(
      `\nCOV-8  /api/absences p95: ${p95Before.toFixed(1)} ms before, ` +
        `${p95After.toFixed(1)} ms with coverage ` +
        `(+${(p95After - p95Before).toFixed(1)} ms), over ${String(rounds)} rounds ` +
        `on ${String(TRIAL_SESSIONS)} sessions; allowance ${String(HUB_RESPONSE_ALLOWANCE_MS)} ms\n`,
    );

    // Assert: the named allowance is HUB_RESPONSE_ALLOWANCE_MS and nothing softer — a
    // response slower than the per-request timeout reaches the connector as
    // nothing at all, which is the failure this is measured to prevent.
    expect(p95After).toBeLessThan(HUB_RESPONSE_ALLOWANCE_MS);
  });

  test("p95 of a scoped read — the prompt path's shape — stays inside it too", async () => {
    // Arrange: the tripwire and pin-lane reads are scoped to a file set, and
    // the scope adds an EXISTS over work_context_targets.
    const { harness, viewerId, files } = await trialRepo();
    const deps = { db: harness.db, now: harness.clock.now };
    const rounds = 20;
    const scoped: number[] = [];

    // Act
    for (let round = 0; round < rounds; round += 1) {
      const start = performance.now();
      await readCoverage(deps, viewerId, REPO, {
        scope: {
          sinceIso: at(-24 * HOUR_MS).toISOString(),
          paths: files.slice(0, 5),
        },
      });
      scoped.push(performance.now() - start);
    }
    const p95 = percentile(scoped, 0.95);
    process.stdout.write(
      `COV-8  scoped readCoverage p95: ${p95.toFixed(1)} ms over ` +
        `${String(rounds)} rounds; allowance ${String(HUB_RESPONSE_ALLOWANCE_MS)} ms\n`,
    );

    // Assert
    expect(p95).toBeLessThan(HUB_RESPONSE_ALLOWANCE_MS);
  });
});

describe("COV-11: the state distribution, measured before merge", () => {
  test("records how often agent_event reaches complete, unscoped and scoped", async () => {
    // Arrange: 127 sessions, 104 never closed and reaped at six hours
    const { harness, viewerId, files } = await trialRepo();
    const deps = { db: harness.db, now: harness.clock.now };

    // Act
    const wide = await readCoverage(deps, viewerId, REPO);
    const wideComplete =
      wide.sources.find((row) => row.source === "agent_event")?.state ===
      "complete";
    const scopedStates = await Promise.all(
      files.map(async (file) => {
        const record = await readCoverage(deps, viewerId, REPO, {
          scope: { sinceIso: at(-14 * 24 * HOUR_MS).toISOString(), paths: [file] },
        });
        return record.sources.find((row) => row.source === "agent_event")?.state;
      }),
    );
    const scopedComplete = scopedStates.filter(
      (state) => state === "complete",
    ).length;
    process.stdout.write(
      `COV-11 agent_event complete — unscoped: ${wideComplete ? "1 of 1" : "0 of 1"}; ` +
        `scoped to one pinned file: ${String(scopedComplete)} of ${String(files.length)}\n`,
    );

    // Assert: NO THRESHOLD, deliberately. This test exists so §5.1's noise
    // argument and §10.4's default are decided on data rather than on a
    // paragraph — it asserts only that the measurement was taken.
    expect(scopedStates.length).toBe(files.length);
    expect(
      scopedStates.every(
        (state) => state !== undefined && state.length > 0,
      ),
    ).toBe(true);
  });

  test("reaped sessions that never reported a file are still a scoped gap", async () => {
    // Arrange: the trial's shape with the one row the shipped fixture set the
    // other way — 104 sessions the reaper closed BEFORE they reported any
    // work context, which is what a terminal killed before the first edit
    // leaves behind. Those are the sessions whose observation failed hardest,
    // and a scoped read that could not see them was reading `complete` off
    // their absence.
    const { harness, viewerId, files } = await trialRepo({
      reapedReportTargets: false,
    });
    const deps = { db: harness.db, now: harness.clock.now };

    // Act
    const scopedStates = await Promise.all(
      files.map(async (file) => {
        const record = await readCoverage(deps, viewerId, REPO, {
          scope: { sinceIso: at(-14 * 24 * HOUR_MS).toISOString(), paths: [file] },
        });
        return {
          state: record.sources.find((row) => row.source === "agent_event")
            ?.state,
          judgeable: isJudgeable(record),
        };
      }),
    );
    const complete = scopedStates.filter(
      (entry) => entry.state === "complete",
    ).length;
    const judgeable = scopedStates.filter((entry) => entry.judgeable).length;
    process.stdout.write(
      `COV-11 reaped-before-reporting (${String(TRIAL_NEVER_CLOSED)} of ` +
        `${String(TRIAL_SESSIONS)}) — scoped complete: ${String(complete)} of ` +
        `${String(files.length)}; judgeable: ${String(judgeable)} of ` +
        `${String(files.length)}\n`,
    );

    // Assert: not a noise threshold — the invariant. A session the hub closed
    // on a guess cannot be scoped out of a question it might have answered,
    // so no surface on this repo is judgeable.
    expect(judgeable).toBe(0);
  });

  test("the control: the same shape with sessions that CLOSE reaches complete", async () => {
    // Arrange: the identical 127-session corpus, every session reporting its
    // own end. This is the control the measurement above needs to be read
    // against — without it "0 of 40" cannot be told apart from a predicate
    // that is structurally unreachable.
    const { harness, viewerId, files } = await trialRepo({ neverClosed: 0 });
    const deps = { db: harness.db, now: harness.clock.now };

    // Act
    const wide = await readCoverage(deps, viewerId, REPO);
    const scopedStates = await Promise.all(
      files.map(async (file) => {
        const record = await readCoverage(deps, viewerId, REPO, {
          scope: { sinceIso: at(-14 * 24 * HOUR_MS).toISOString(), paths: [file] },
        });
        return record.sources.find((row) => row.source === "agent_event")?.state;
      }),
    );
    const scopedComplete = scopedStates.filter(
      (state) => state === "complete",
    ).length;
    process.stdout.write(
      `COV-11 control (every session reported its end) — unscoped: ${
        wide.sources.find((row) => row.source === "agent_event")?.state ===
        "complete"
          ? "1 of 1"
          : "0 of 1"
      }; scoped: ${String(scopedComplete)} of ${String(files.length)}\n`,
    );

    // Assert: the predicate is reachable. What makes it unreachable in the
    // measurement above is unclosed sessions, not the shape of the rule.
    expect(scopedComplete).toBe(files.length);
  });
});
