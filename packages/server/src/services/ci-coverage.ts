/**
 * HOW MUCH OF THIS COMMIT'S CI THIS HUB ACTUALLY HEARD (1.0 spec 05 §3.6).
 *
 * NO PERCENTAGE, NO SCALAR, NO BADGE (§8.1). A single number would be read as
 * a score, and the four states here are not ordered: `unavailable` is not a
 * worse `complete`, it is a different sentence. A repo with no reporter has
 * nothing to be incomplete ABOUT.
 *
 * THE DEFAULT IS `unavailable`, AND IT STAYS THE DEFAULT. Every repo that has
 * never reported reads `unavailable` until one does — never `complete` on the
 * strength of an empty table. That is the inversion this project refuses, in
 * one line: nothing arriving is not the same as nothing being wrong.
 *
 * `lanesExpected` IS DERIVED, NEVER DECLARED. A declared list of lanes goes
 * stale silently, and a stale expectation reports `incomplete` forever for a
 * job somebody deleted months ago — which trains a team to ignore the field.
 * So expectation is read off behaviour: a lane counts as expected once it has
 * appeared in ALL of the last `CI_LANE_QUORUM_COMMITS` distinct commits of this
 * ref. A job added yesterday is not yet expected; a job deleted yesterday stops
 * being expected once the quorum rolls past it, and nobody maintains a list.
 *
 * THE STATE IS NOT A REASON. 03 owns `CoverageReason` and its enum has no CI
 * members; this returns a state and 03 maps it (§9.1). Minting a reason here
 * would be this spec writing into another's vocabulary, which is how two
 * enumerations end up disagreeing about the same fact.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import type { CiLane } from "@crosscheck/schema";

import { CI_LANE_QUORUM_COMMITS } from "../constants.ts";
import { ciRuns } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";
import { ciBehaviorDeltas } from "./ci-delta.ts";

export type CiCoverageState =
  | "complete"
  | "incomplete"
  | "unknown"
  | "unavailable";

export interface CiCoverage {
  readonly state: CiCoverageState;
  /** Lanes the quorum says should report here — derived from behaviour. */
  readonly lanesExpected: number;
  /** Of those, how many reported a primary run at this commit. */
  readonly lanesReported: number;
  /**
   * Lanes whose run cannot assert what it ran — `truncated` (the row cap was
   * hit) or `crashed` (the runner died). Counted apart from a lane that never
   * reported, because the remedies differ: one is a run to re-trigger, the
   * other a reporter to look at.
   */
  readonly truncatedLanes: number;
  /** Non-green tests whose verdict is waiting on somebody pressing re-run. */
  readonly awaitingRerun: number;
  /** The newest collection time across this commit's runs, ISO, or null. */
  readonly collectedAt: string | null;
}

/** Every repo that has never reported reads this, and it is never a failure. */
const UNAVAILABLE: CiCoverage = {
  state: "unavailable",
  lanesExpected: 0,
  lanesReported: 0,
  truncatedLanes: 0,
  awaitingRerun: 0,
  collectedAt: null,
};

/**
 * One lane as a Set-able string. Internal — never rendered, never stored.
 *
 * SEPARATED BY A CHARACTER A LANE FIELD CANNOT HOLD. Joined on a space, a
 * workflow "a" with job "b c" and a workflow "a b" with job "c" would be the
 * same key, and two lanes collapsing into one is a base that silently halves.
 * Written as an escape rather than as a raw NUL byte in the source: a control
 * character nobody can see in a diff is a separator nobody can review.
 */
const laneKey = (lane: {
  provider: string;
  workflow: string;
  job: string;
  leg: string;
}): string =>
  `${lane.provider}\u0000${lane.workflow}\u0000${lane.job}\u0000${lane.leg}`;

interface RunRow {
  readonly commitSha: string;
  readonly provider: string;
  readonly workflow: string;
  readonly job: string;
  readonly leg: string;
  readonly ref: string;
  readonly outcome: string;
  readonly collectedAt: Date;
}

/**
 * The lanes expected on this ref, by quorum.
 *
 * INTERSECTION, NOT UNION, and that is the whole guard. A union would make one
 * lane that ran once, months ago, expected forever — and every commit after it
 * `incomplete` for a job nobody has. The intersection says: only lanes that
 * have shown up EVERY time recently are ones whose silence means anything.
 *
 * FEWER THAN THE QUORUM'S WORTH OF COMMITS MEANS NO EXPECTATION AT ALL. A repo
 * that started reporting yesterday has no behaviour to read expectation off,
 * and inventing one from two commits would let a lane's first absence read as
 * a failure rather than as a hub that has not watched long enough.
 *
 * THE COMMIT BEING JUDGED IS NOT IN ITS OWN WINDOW, and leaving it in was a
 * defect a test caught before this shipped. Expectation is an INTERSECTION, so
 * a lane that stayed silent here would be absent from this commit's own set —
 * and the intersection would drop it. The lane's silence would then remove it
 * from the very set whose silence is what `incomplete` reports, so a missing
 * lane could never be missing. That is the exonerating direction again: the
 * gap erases the evidence of itself. History decides what should happen here;
 * this commit is what is being measured against it, never a voter on it.
 */
const expectedLanes = async (
  db: DbExecutor,
  repo: string,
  ref: string,
  excludeCommit: string,
): Promise<ReadonlySet<string>> => {
  const rows = await db
    .select({
      commitSha: ciRuns.commitSha,
      provider: ciRuns.provider,
      workflow: ciRuns.workflow,
      job: ciRuns.job,
      leg: ciRuns.leg,
      startedAt: ciRuns.startedAt,
    })
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.repo, repo),
        eq(ciRuns.ref, ref),
        eq(ciRuns.rerunKind, "none"),
      ),
    )
    .orderBy(desc(ciRuns.startedAt));

  // The last N DISTINCT commits BEFORE this one.
  const commits: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.commitSha === excludeCommit || seen.has(row.commitSha)) {
      continue;
    }
    seen.add(row.commitSha);
    commits.push(row.commitSha);
    if (commits.length >= CI_LANE_QUORUM_COMMITS) {
      break;
    }
  }
  if (commits.length < CI_LANE_QUORUM_COMMITS) {
    return new Set();
  }

  const window = new Set(commits);
  const perCommit = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!window.has(row.commitSha)) {
      continue;
    }
    const lanes = perCommit.get(row.commitSha) ?? new Set<string>();
    lanes.add(laneKey(row));
    perCommit.set(row.commitSha, lanes);
  }

  const sets = [...perCommit.values()];
  const first = sets[0];
  if (first === undefined) {
    return new Set();
  }
  return new Set(
    [...first].filter((key) => sets.every((lanes) => lanes.has(key))),
  );
};

export interface CiCoverageInput {
  readonly db: DbExecutor;
  readonly repo: string;
  readonly commitSha: string;
  readonly defaultRef: string;
  readonly now: Date;
}

/**
 * The `ci` coverage source for one commit.
 *
 * THE REF COMES FROM THE RUNS, not from the caller. A commit can sit on several
 * refs, and the one that matters is the one CI actually ran on — a
 * caller-supplied ref would let the quorum be computed against a branch this
 * commit never had a lane on, and every lane would then read as missing.
 */
export const readCiCoverage = async (
  input: CiCoverageInput,
): Promise<CiCoverage> => {
  const { db, repo, commitSha } = input;
  const here = (await db
    .select({
      commitSha: ciRuns.commitSha,
      provider: ciRuns.provider,
      workflow: ciRuns.workflow,
      job: ciRuns.job,
      leg: ciRuns.leg,
      ref: ciRuns.ref,
      outcome: ciRuns.outcome,
      collectedAt: ciRuns.collectedAt,
    })
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.repo, repo),
        eq(ciRuns.commitSha, commitSha),
        eq(ciRuns.rerunKind, "none"),
      ),
    )
    .orderBy(desc(ciRuns.collectedAt))) as readonly RunRow[];

  if (here.length === 0) {
    // NOTHING FOR THIS COMMIT, and two different sentences hide here. Telling
    // them apart is the difference between "wait" and "there is nothing to
    // wait for": a repo that reports has a lane on the way, a repo that never
    // has does not. One query decides it, and the default stays `unavailable`.
    const everReported = await db
      .select({ id: ciRuns.id })
      .from(ciRuns)
      .where(eq(ciRuns.repo, repo))
      .limit(1);
    return everReported.length === 0
      ? UNAVAILABLE
      : { ...UNAVAILABLE, state: "unknown" };
  }

  const ref = here[0]?.ref ?? input.defaultRef;
  const onRef = here.filter((row) => row.ref === ref);
  const expected = await expectedLanes(db, repo, ref, commitSha);
  const reportedHere = new Set(onRef.map((row) => laneKey(row)));
  const lanesReported = [...expected].filter((key) =>
    reportedHere.has(key),
  ).length;
  const truncatedLanes = onRef.filter(
    (row) => row.outcome !== "completed" && expected.has(laneKey(row)),
  ).length;

  // AWAITING A RE-RUN IS A COVERAGE FACT, not only a delta one. A commit whose
  // every lane reported but whose red test nobody has measured twice is not
  // `complete`: the question CI was asked — did this commit break something —
  // has no answer yet, and `complete` there would say it does.
  const lanes: readonly CiLane[] = onRef.map((row) => ({
    repo,
    provider: row.provider as CiLane["provider"],
    workflow: row.workflow,
    job: row.job,
    leg: row.leg,
    ref,
  }));
  let awaitingRerun = 0;
  for (const lane of lanes) {
    const deltas = await ciBehaviorDeltas({
      db,
      lane,
      defaultRef: input.defaultRef,
      commitSha,
      now: input.now,
    });
    awaitingRerun += deltas.filter(
      (delta) => delta.reason === "awaiting_rerun",
    ).length;
  }

  const newest = here[0]?.collectedAt ?? null;
  const shared = {
    lanesExpected: expected.size,
    lanesReported,
    truncatedLanes,
    awaitingRerun,
    collectedAt: newest === null ? null : newest.toISOString(),
  };

  // NO EXPECTATION YET IS `unknown`, NEVER `complete`. A hub that has not
  // watched this ref for a quorum's worth of commits knows what arrived and
  // not what should have — and "every expected lane reported" is trivially
  // true when nothing is expected. That is the empty set reading as success,
  // which is the shape principle 5 forbids.
  if (expected.size === 0) {
    return { ...shared, state: "unknown" };
  }
  return {
    ...shared,
    state:
      lanesReported === expected.size &&
      truncatedLanes === 0 &&
      awaitingRerun === 0
        ? "complete"
        : "incomplete",
  };
};

/**
 * The same answer for many commits, for a caller holding a session's worth.
 *
 * SEQUENTIAL ON PURPOSE. PGlite is single-connection, so parallel reads buy
 * nothing and a burst would block the hub's other work — the constraint
 * `record-handlers.ts` states for its own transaction.
 */
export const readCiCoverageFor = async (
  input: Omit<CiCoverageInput, "commitSha"> & {
    readonly commitShas: readonly string[];
  },
): Promise<ReadonlyMap<string, CiCoverage>> => {
  const out = new Map<string, CiCoverage>();
  for (const commitSha of new Set(input.commitShas)) {
    out.set(commitSha, await readCiCoverage({ ...input, commitSha }));
  }
  return out;
};

/** Commits this hub holds any CI for, so a caller can skip the rest. */
export const commitsWithCi = async (
  db: DbExecutor,
  repo: string,
  commitShas: readonly string[],
): Promise<ReadonlySet<string>> => {
  const unique = [...new Set(commitShas)];
  if (unique.length === 0) {
    return new Set();
  }
  const rows = await db
    .selectDistinct({ commitSha: ciRuns.commitSha })
    .from(ciRuns)
    .where(and(eq(ciRuns.repo, repo), inArray(ciRuns.commitSha, unique)));
  return new Set(rows.map((row) => row.commitSha));
};
