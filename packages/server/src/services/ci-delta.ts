/**
 * DID THIS COMMIT BREAK THIS TEST, OR WAS THE TEST ALREADY UNRELIABLE?
 * (1.0 spec 05 §3.5)
 *
 * A red test is not a fact about a commit. It is a fact about one run of one
 * lane, and turning it into a fact about a commit takes evidence this hub may
 * not have: a base window that was stably green, and a re-run of the SAME
 * commit that came back red. Without both, the honest answer is `unconfirmed`
 * with the reason named — never "probably the commit".
 *
 * THE ORDER OF THE RETURNS IS THE CONTRACT, the way `explanationTimingFor`'s
 * ladder is in spec 06. Each rung refuses for a DIFFERENT reason and sends a
 * reader to a different remedy:
 *
 *   insufficient_base  — this hub has not seen enough of this lane yet. Wait.
 *   not_stably_green   — the test was already failing before this commit.
 *   awaiting_rerun     — nobody has re-run it. Press the button.
 *   rerun_green        — it passed on the same commit: FLAKY, not this commit.
 *   rerun_red          — it failed twice on the same commit: CONFIRMED.
 *
 * Reordering them changes what the hub says without changing what it knows,
 * and every wrong order points the same way: toward `confirmed`, which is the
 * one verdict that accuses a developer. `insufficient_base` must come first
 * for that reason — a hub with no history can otherwise reach step 3, find no
 * non-green run in an EMPTY window, and read "nothing was failing before" off
 * an absence. That is principle 5 exactly: missing evidence may weaken a
 * conclusion, it must never strengthen one.
 *
 * A CRASHED RUN PRODUCES NO DELTA AND ENTERS NO BASE WINDOW. An infrastructure
 * failure — a runner that died, a checkout that never finished — is not a fact
 * about a commit in either direction. Counting it as green would manufacture a
 * base; counting it as red would manufacture an accusation.
 *
 * NOTHING HERE SANITIZES. `testId` is author-written text and travels raw
 * through this module; every surface that prints one frames it. Rendering is
 * the render layer's job and doing half of it here would leave two places to
 * get it wrong.
 */
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";

import type { CiLane } from "@crosscheck/schema";

import {
  CI_BASE_WINDOW_DAYS,
  CI_FLAKE_BASE_RUNS,
  MS_PER_DAY,
} from "../constants.ts";
import { ciRuns, ciTestResults } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";

/**
 * Why a delta says what it says. Every value is a REASON, including the two
 * that resolve — a reader told `confirmed` with no reason cannot tell a
 * verdict from a default.
 */
export type CiDeltaReason =
  | "insufficient_base"
  | "not_stably_green"
  | "awaiting_rerun"
  | "rerun_green"
  | "rerun_red";

export type CiDeltaVerdict = "confirmed" | "unconfirmed" | "flaky";

/**
 * WHICH RUNS THE BASE WINDOW CAME FROM, and it is rendered rather than kept.
 *
 * A lane on a feature branch usually has no history of its own, so the window
 * falls back to the same `(repo, provider, workflow, job, leg)` on the default
 * ref. THE HUB HOLDS NO REPOSITORY and cannot check that the branch descends
 * from that ref — the fallback is an ASSUMPTION, and an assumption a reader
 * cannot see is one they cannot reject.
 */
export type CiBaseWindowSource = "same_ref" | "default_ref_fallback";

export interface CiBehaviorDelta {
  /** Author-written, sanitized at render and never here. */
  readonly testId: string;
  readonly lane: CiLane;
  readonly delta: CiDeltaVerdict;
  readonly reason: CiDeltaReason;
  /** How many runs the window actually held — the honest denominator. */
  readonly baseRuns: number;
  readonly baseWindowSource: CiBaseWindowSource;
  readonly rerunKind: "none" | "same_job" | "new_attempt";
}

interface BaseWindow {
  readonly runIds: readonly string[];
  readonly source: CiBaseWindowSource;
}

/**
 * The most recent `CI_FLAKE_BASE_RUNS` PRIMARY runs of this lane at OTHER
 * commits, newest first.
 *
 * DISTINCT COMMIT, and that is load-bearing rather than tidy. One commit
 * pushed to two refs, or re-run three times, would otherwise fill a five-run
 * window with one commit's behaviour — and a window that is really one commit
 * cannot say whether a test is stably green ACROSS commits, which is the only
 * question it exists to answer.
 *
 * `rerun_kind = 'none'` because a re-run is the SAME commit measured twice: a
 * green re-run inside the base window would be the flake evidence quietly
 * reused as stability evidence.
 *
 * `outcome = 'completed'` because only a completed run ASSERTS that its
 * non-green rows are all of them (§3.3). A crashed run's empty result set is
 * an absence, and reading "nothing failed" off it is the inversion this
 * module's header names.
 */
const baseRunsOn = async (
  db: DbExecutor,
  lane: CiLane,
  ref: string,
  excludeCommit: string,
  since: Date,
): Promise<readonly string[]> => {
  // DISTINCT ON the commit, newest first within each. Postgres requires the
  // ORDER BY to lead with the distinct expression, so the lane's own recency
  // ordering is re-applied below and the slice is what bounds the window.
  const rows = await db
    .selectDistinctOn([ciRuns.commitSha], {
      id: ciRuns.id,
      startedAt: ciRuns.startedAt,
    })
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.repo, lane.repo),
        eq(ciRuns.provider, lane.provider),
        eq(ciRuns.workflow, lane.workflow),
        eq(ciRuns.job, lane.job),
        eq(ciRuns.leg, lane.leg),
        eq(ciRuns.ref, ref),
        eq(ciRuns.rerunKind, "none"),
        eq(ciRuns.outcome, "completed"),
        ne(ciRuns.commitSha, excludeCommit),
        gte(ciRuns.startedAt, since),
      ),
    )
    .orderBy(ciRuns.commitSha, desc(ciRuns.startedAt));

  return [...rows]
    .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
    .slice(0, CI_FLAKE_BASE_RUNS)
    .map((row) => row.id);
};

/**
 * The window, on this lane's own ref or — when that one is too thin — on the
 * default ref, SAID EITHER WAY.
 *
 * The fallback is taken only when the lane's own ref cannot fill the window,
 * never to top it up: a window mixing two refs is a base no single label
 * describes, and `baseWindowSource` would then be a field that lies in exactly
 * the case it exists for.
 */
const baseWindow = async (
  db: DbExecutor,
  lane: CiLane,
  defaultRef: string,
  commitSha: string,
  now: Date,
): Promise<BaseWindow> => {
  const since = new Date(now.getTime() - CI_BASE_WINDOW_DAYS * MS_PER_DAY);
  const own = await baseRunsOn(db, lane, lane.ref, commitSha, since);
  if (own.length >= CI_FLAKE_BASE_RUNS || lane.ref === defaultRef) {
    return { runIds: own, source: "same_ref" };
  }
  const fallback = await baseRunsOn(db, lane, defaultRef, commitSha, since);
  // A FALLBACK THAT IS ALSO TOO THIN STAYS THE FALLBACK when it holds more.
  // Reporting the own-ref count then would name a window this delta was not
  // measured against, and `insufficient_base` would point a reader at the
  // wrong ref to wait on.
  return fallback.length > own.length
    ? { runIds: fallback, source: "default_ref_fallback" }
    : { runIds: own, source: "same_ref" };
};

/** Every test id that was non-green in ANY of these runs. */
const nonGreenIn = async (
  db: DbExecutor,
  runIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  if (runIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .selectDistinct({ testId: ciTestResults.testId })
    .from(ciTestResults)
    .where(inArray(ciTestResults.ciRunId, [...runIds]));
  return new Set(rows.map((row) => row.testId));
};

/**
 * A re-run of one primary run.
 *
 * BOTH KINDS COUNT. `same_job` is a second `bun test` over the failed files on
 * the same runner; `new_attempt` is the provider's re-run button on a fresh
 * one. Both are the same commit measured twice, which is what the ladder asks
 * — and WHICH ONE is recorded, because a `same_job` re-run cannot rule out
 * host state (§10 D2) and a reader deciding whether to trust `confirmed` needs
 * to know which of the two they are holding.
 */
interface Rerun {
  readonly id: string;
  readonly kind: "same_job" | "new_attempt";
}

const rerunsOf = async (
  db: DbExecutor,
  runId: string,
): Promise<readonly Rerun[]> => {
  const rows = await db
    .select({ id: ciRuns.id, rerunKind: ciRuns.rerunKind })
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.rerunOf, runId),
        eq(ciRuns.outcome, "completed"),
        ne(ciRuns.rerunKind, "none"),
      ),
    )
    .orderBy(desc(ciRuns.startedAt));
  return rows.flatMap((row) =>
    row.rerunKind === "same_job" || row.rerunKind === "new_attempt"
      ? [{ id: row.id, kind: row.rerunKind }]
      : [],
  );
};

export interface CiDeltaInput {
  readonly db: DbExecutor;
  readonly lane: CiLane;
  /** The repository's default branch ref, for the fallback window. */
  readonly defaultRef: string;
  readonly commitSha: string;
  readonly now: Date;
}

/**
 * The delta for every non-green test in one lane's PRIMARY run at one commit.
 *
 * Returns an EMPTY list rather than throwing when there is no primary run or
 * it crashed. "This hub cannot say" and "this hub says nothing is wrong" are
 * different sentences, and the caller's surface is where that difference gets
 * said — a delta list quietly standing in for both would be the silent absence
 * AT-10 refuses.
 */
export const ciBehaviorDeltas = async (
  input: CiDeltaInput,
): Promise<readonly CiBehaviorDelta[]> => {
  const { db, lane, commitSha } = input;
  const primary = await db
    .select({ id: ciRuns.id, outcome: ciRuns.outcome })
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.repo, lane.repo),
        eq(ciRuns.provider, lane.provider),
        eq(ciRuns.workflow, lane.workflow),
        eq(ciRuns.job, lane.job),
        eq(ciRuns.leg, lane.leg),
        eq(ciRuns.ref, lane.ref),
        eq(ciRuns.commitSha, commitSha),
        eq(ciRuns.rerunKind, "none"),
      ),
    )
    .orderBy(desc(ciRuns.startedAt))
    .limit(1);

  const run = primary[0];
  // A CRASHED RUN IS NOT A QUIET GREEN. Its result set is empty because the
  // runner died, not because the tests passed, so it yields no delta at all
  // rather than a delta about nothing.
  if (run === undefined || run.outcome !== "completed") {
    return [];
  }

  const failing = await db
    .select({ testId: ciTestResults.testId })
    .from(ciTestResults)
    .where(eq(ciTestResults.ciRunId, run.id))
    .orderBy(ciTestResults.testId);
  if (failing.length === 0) {
    return [];
  }

  const window = await baseWindow(
    db,
    lane,
    input.defaultRef,
    commitSha,
    input.now,
  );
  const reruns = await rerunsOf(db, run.id);
  // THE NEWEST RE-RUN DECIDES. An older green followed by a newer red is a
  // test failing NOW, and taking the green would let the first of many re-runs
  // settle the verdict for all of them — in the exonerating direction.
  const rerun = reruns[0];
  const rerunNonGreen =
    rerun === undefined ? new Set<string>() : await nonGreenIn(db, [rerun.id]);
  const everNonGreen = await nonGreenIn(db, window.runIds);

  return failing.map(({ testId }): CiBehaviorDelta => {
    const shared = {
      testId,
      lane,
      baseRuns: window.runIds.length,
      baseWindowSource: window.source,
      rerunKind: rerun?.kind ?? ("none" as const),
    };
    // STEP 2. Too little history to compare against. FIRST, because every rung
    // below reads an absence as evidence, and in an empty window every absence
    // is the absence of DATA rather than the absence of failure.
    if (window.runIds.length < CI_FLAKE_BASE_RUNS) {
      return { ...shared, delta: "unconfirmed", reason: "insufficient_base" };
    }
    // STEP 3. It was already failing before this commit, so this commit is not
    // where a reader should be sent to look.
    if (everNonGreen.has(testId)) {
      return { ...shared, delta: "unconfirmed", reason: "not_stably_green" };
    }
    // STEP 4. Nobody has measured the same commit twice. One red run cannot
    // separate a broken commit from an unreliable test, and guessing between
    // them is the whole thing this filter exists to refuse.
    if (rerun === undefined) {
      return { ...shared, delta: "unconfirmed", reason: "awaiting_rerun" };
    }
    // STEP 5. Green on the second measurement of the SAME commit: the test is
    // flaky. NO ATTRIBUTION IS COMPUTED OR RENDERED for a flaky delta — naming
    // an author beside a test that passes half the time is an accusation the
    // evidence does not support.
    if (!rerunNonGreen.has(testId)) {
      return { ...shared, delta: "flaky", reason: "rerun_green" };
    }
    // STEP 6. Red twice on the same commit, over a stably green base. The one
    // rung that accuses, and the only one reached with every other explanation
    // ruled out by a MEASUREMENT rather than by an absence.
    return { ...shared, delta: "confirmed", reason: "rerun_red" };
  });
};

/**
 * How many of a repo's primary runs this hub can draw a delta from at all —
 * doctor's instrument, the same shape `countIntentPositions` has in spec 06.
 *
 * BOTH HALVES, ALWAYS. The numerator alone would let a hub whose runners keep
 * crashing look exactly like a hub with nothing to report.
 */
export const countCiPrimaryRuns = async (
  db: DbExecutor,
  repo: string,
): Promise<{ completed: number; total: number }> => {
  const rows = await db
    .select({
      completed: sql<number>`count(*) filter (where ${ciRuns.outcome} = 'completed')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(ciRuns)
    .where(and(eq(ciRuns.repo, repo), eq(ciRuns.rerunKind, "none")));
  return { completed: rows[0]?.completed ?? 0, total: rows[0]?.total ?? 0 };
};
