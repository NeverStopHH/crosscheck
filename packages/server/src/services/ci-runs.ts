/**
 * INGEST FOR CI RUNS (spec 05 §3.2, §3.7, §4).
 *
 * One row per lane per attempt, and the non-green tests that attempt saw.
 *
 * THE ID IS DETERMINISTIC over the lane, the commit, the attempt and the
 * re-run kind — the `hint_deliveries` shape. A CI runner that retries its POST
 * after a timeout must not produce a second row claiming the same job ran
 * twice: a duplicated attempt would count twice toward a base window and could
 * turn "stably green over five runs" into "stably green over five copies of
 * one run", which is the same lie the flake filter exists to prevent.
 *
 * TIMESTAMPS ARE CLAMPED, because both of them are sender-controlled and the
 * sender is a machine nobody in the team owns. An unclamped `started_at` far
 * in the future can never be overtaken by honest evidence and can never fall
 * out of retention — one forged value would pin a lane's window open forever.
 * This is the same defence `commit_evidence` applies to a git author date.
 *
 * A RE-RUN MUST NAME A RUN OF ITS OWN LANE AND COMMIT. The check is here and
 * not on the wire because only the hub can see the target row. Accepting a
 * cross-lane or cross-commit target would let a green run somewhere else clear
 * a red one here — an exoneration assembled out of two unrelated facts, which
 * is the failure the lane rule exists to prevent.
 */
import { and, desc, eq, gt, lt, or } from "drizzle-orm";
import { MAX_COMMIT_CLOCK_SKEW_MS } from "@crosscheck/schema";
import type { CiRunReport } from "@crosscheck/schema";

import { CI_RETENTION_DAYS } from "../constants.ts";
import { ciRuns, ciTestResults } from "../db/schema.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import type { Clock } from "../types.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ID_PREFIX = "cir_";
const ID_HASH_CHARS = 32;

export interface CiIngestDeps {
  readonly db: Db;
  readonly now: Clock;
}

export type CiIngestStatus = "accepted" | "duplicate" | "rejected";

export interface CiIngestOutcome {
  readonly status: CiIngestStatus;
  readonly id: string;
  readonly issues?: readonly string[];
}

/**
 * `cir_` + sha256 over everything that makes an attempt a distinct attempt.
 *
 * `rerun_kind` is INSIDE the hash and that is deliberate: a `same_job` re-run
 * and the primary run it repeats share a lane, a commit and — on GitHub — a
 * run attempt, because a second `bun test` inside one job does not increment
 * `GITHUB_RUN_ATTEMPT`. Without the kind in the key the re-run would collide
 * with the run it is supposed to be evidence about, and the hub would answer
 * `duplicate` to the one row the flake filter is waiting for.
 */
export const ciRunId = (report: {
  readonly provider: string;
  readonly repo: string;
  readonly commitSha: string;
  readonly workflow: string;
  readonly job: string;
  readonly leg: string;
  readonly ref: string;
  readonly runAttempt: number;
  readonly rerunKind: string;
}): string =>
  `${ID_PREFIX}${new Bun.CryptoHasher("sha256")
    .update(
      [
        report.provider,
        report.repo,
        report.commitSha,
        report.workflow,
        report.job,
        report.leg,
        report.ref,
        String(report.runAttempt),
        report.rerunKind,
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, ID_HASH_CHARS)}`;

const rejected = (id: string, issue: string): CiIngestOutcome => ({
  status: "rejected",
  id,
  issues: [issue],
});

/**
 * Does the named target exist, and is it the same lane at the same commit?
 *
 * Returns the issue to report, or null when the target is acceptable.
 */
const rerunTargetIssue = async (
  db: DbExecutor,
  report: CiRunReport,
): Promise<string | null> => {
  if (report.rerunOf === null) {
    return null;
  }
  const rows = await db
    .select({
      repo: ciRuns.repo,
      commitSha: ciRuns.commitSha,
      provider: ciRuns.provider,
      workflow: ciRuns.workflow,
      job: ciRuns.job,
      leg: ciRuns.leg,
      ref: ciRuns.ref,
    })
    .from(ciRuns)
    .where(eq(ciRuns.id, report.rerunOf))
    .limit(1);
  const target = rows[0];
  if (target === undefined) {
    return `rerunOf names no run this hub holds (${report.rerunOf})`;
  }
  const sameLane =
    target.repo === report.repo &&
    target.commitSha === report.commitSha &&
    target.provider === report.provider &&
    target.workflow === report.workflow &&
    target.job === report.job &&
    target.leg === report.leg &&
    target.ref === report.ref;
  return sameLane
    ? null
    : "rerunOf names a run of a different lane or commit — a re-run of " +
        "something else is not a re-run, and treating it as one would let a " +
        "green run elsewhere clear a red one here";
};

/**
 * Prunes what has aged out AND what claims to be from the future.
 *
 * The age test alone can never retire a forged future row — a timestamp ahead
 * of now is never older than the cutoff — so such a row would sit in every
 * base window for good. Both timestamps are checked because the sender
 * controls both.
 */
const prune = async (
  db: DbExecutor,
  repo: string,
  now: Date,
  futureCeiling: Date,
): Promise<void> => {
  await db
    .delete(ciRuns)
    .where(
      and(
        eq(ciRuns.repo, repo),
        or(
          lt(
            ciRuns.startedAt,
            new Date(now.getTime() - CI_RETENTION_DAYS * MS_PER_DAY),
          ),
          gt(ciRuns.startedAt, futureCeiling),
          gt(ciRuns.collectedAt, futureCeiling),
        ),
      ),
    );
};

export const ingestCiRun = async (
  deps: CiIngestDeps,
  report: CiRunReport,
): Promise<CiIngestOutcome> => {
  const id = ciRunId(report);
  const now = deps.now();
  const futureCeilingMs = now.getTime() + MAX_COMMIT_CLOCK_SKEW_MS;
  const futureCeiling = new Date(futureCeilingMs);
  const startedAt = new Date(
    Math.min(Date.parse(report.startedAt), futureCeilingMs),
  );
  const collectedAt = new Date(
    Math.min(Date.parse(report.collectedAt), futureCeilingMs),
  );

  return deps.db.transaction(async (tx) => {
    // Pruning FIRST, inside the same transaction: a retention pass that ran
    // after the insert could delete the row it just accepted if the sender's
    // clock is far enough behind, and the reporter would read `accepted` for
    // a run the hub does not hold.
    await prune(tx, report.repo, now, futureCeiling);

    const issue = await rerunTargetIssue(tx, report);
    if (issue !== null) {
      return rejected(id, issue);
    }

    const inserted = await tx
      .insert(ciRuns)
      .values({
        id,
        repo: report.repo,
        commitSha: report.commitSha,
        provider: report.provider,
        workflow: report.workflow,
        job: report.job,
        leg: report.leg,
        ref: report.ref,
        runAttempt: report.runAttempt,
        externalRunId: report.externalRunId,
        rerunKind: report.rerunKind,
        rerunOf: report.rerunOf,
        outcome: report.outcome,
        tests: report.tests,
        failures: report.failures,
        skipped: report.skipped,
        durationMs: report.durationMs,
        ambiguousDropped: report.ambiguousDropped,
        startedAt,
        collectedAt,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: ciRuns.id });

    if (inserted[0] === undefined) {
      // The same attempt, reported twice. Nothing is updated: a second report
      // of one attempt carries no new fact, and letting it overwrite would
      // give a retrying runner the power to rewrite a stored outcome.
      return { status: "duplicate", id };
    }

    if (report.results.length > 0) {
      await tx
        .insert(ciTestResults)
        .values(
          report.results.map((result) => ({
            ciRunId: id,
            testId: result.testId,
            repo: report.repo,
            status: result.status,
            durationMs: result.durationMs,
          })),
        )
        // A reporter that sent the same test id twice in one run has already
        // failed to disambiguate it; the primary key refuses the second copy
        // rather than the whole run, because a run is still worth having.
        .onConflictDoNothing();
    }

    return { status: "accepted", id };
  });
};

export interface CiRunRow {
  readonly id: string;
  readonly commitSha: string;
  readonly provider: string;
  readonly workflow: string;
  readonly job: string;
  readonly leg: string;
  readonly ref: string;
  readonly runAttempt: number;
  readonly externalRunId: string;
  readonly rerunKind: string;
  readonly rerunOf: string | null;
  readonly outcome: string;
  readonly tests: number;
  readonly failures: number;
  readonly skipped: number;
  readonly ambiguousDropped: number;
  readonly startedAt: Date;
  readonly collectedAt: Date;
}

/** Every run this hub holds for one commit, newest first. */
export const readCiRuns = async (
  db: DbExecutor,
  repo: string,
  commitSha: string,
): Promise<readonly CiRunRow[]> =>
  db
    .select({
      id: ciRuns.id,
      commitSha: ciRuns.commitSha,
      provider: ciRuns.provider,
      workflow: ciRuns.workflow,
      job: ciRuns.job,
      leg: ciRuns.leg,
      ref: ciRuns.ref,
      runAttempt: ciRuns.runAttempt,
      externalRunId: ciRuns.externalRunId,
      rerunKind: ciRuns.rerunKind,
      rerunOf: ciRuns.rerunOf,
      outcome: ciRuns.outcome,
      tests: ciRuns.tests,
      failures: ciRuns.failures,
      skipped: ciRuns.skipped,
      ambiguousDropped: ciRuns.ambiguousDropped,
      startedAt: ciRuns.startedAt,
      collectedAt: ciRuns.collectedAt,
    })
    .from(ciRuns)
    .where(and(eq(ciRuns.repo, repo), eq(ciRuns.commitSha, commitSha)))
    .orderBy(desc(ciRuns.startedAt));

/** The non-green rows of one run. */
export const readCiTestResults = async (
  db: DbExecutor,
  runId: string,
): Promise<readonly { testId: string; status: string; durationMs: number }[]> =>
  db
    .select({
      testId: ciTestResults.testId,
      status: ciTestResults.status,
      durationMs: ciTestResults.durationMs,
    })
    .from(ciTestResults)
    .where(eq(ciTestResults.ciRunId, runId));
