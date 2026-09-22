/**
 * PLANNING AND SPENDING THE REVALIDATION BOUND (1.0 spec 02 §3.6, CCB-9).
 *
 * A tree's claims are not one question. Each carries its own observation
 * commit, and — where its author declared one — its own surface, so the unit
 * of work is a distinct **(commit, path-set) group**, not a distinct commit.
 * The spec writes `CLAIM_REVALIDATION_MAX_COMMITS` as a cap on distinct
 * commits; applied that way it bounds nothing, because with the `declared`
 * basis one commit can carry as many path sets as there are claims. THE CAP
 * COUNTS GROUPS — what is actually spent — and the cut is reported.
 *
 * NEWEST-FIRST BEFORE THE CUT, by the newest claim in each group. That is a
 * PROXY for commit recency and is named as one: the true order would cost a
 * git call per commit, which is the cost the bound exists to avoid, and a
 * claim's observation commit is HEAD at or before the moment it was written.
 * The proxy decides only WHICH groups get measured, never what a measurement
 * means, so a wrong guess costs coverage rather than correctness and the
 * claims it skips keep whatever reading was last recorded — `unknown` where
 * there is none — rather than reading `current`.
 *
 * WHAT NEVER HAPPENS HERE: this module maps no drift result to a validity
 * state. It reports; the hub derives. One authority.
 */
import {
  CLAIM_REVALIDATION_MAX_COMMITS,
  CLAIM_REVALIDATION_MAX_GIT_CALLS,
  MAX_CLAIM_SURFACE_PATHS,
} from "../constants.ts";
import { checkClaimDrift } from "../git/claim-drift.ts";
import type { ClaimRevalidationEntry } from "@crosscheck/schema";
import type { Diagnosis } from "../http/hub.ts";

/** Most git processes one group can cost: the hash leg plus its follow-up. */
const GIT_CALLS_PER_GROUP = 2;

/**
 * The one call a pull spends before any group: naming the ref's commit
 * (git/claim-drift.ts resolveRefCommit). Counted against the same cap, so the
 * cap is a true ceiling on processes rather than a ceiling on most of them.
 */
const REF_RESOLUTION_CALLS = 1;

/**
 * How many groups one pull may measure: the named group bound, or whatever
 * the process cap still affords after the ref resolution — whichever is less.
 */
export const REVALIDATION_GROUPS_PER_PULL = Math.min(
  CLAIM_REVALIDATION_MAX_COMMITS,
  Math.floor(
    (CLAIM_REVALIDATION_MAX_GIT_CALLS - REF_RESOLUTION_CALLS) /
      GIT_CALLS_PER_GROUP,
  ),
);

export interface RevalidationGroup {
  /** The observation commit every claim in this group shares. */
  readonly observedAtCommit: string;
  /** The surface every claim in this group shares, already capped. */
  readonly paths: readonly string[];
  /**
   * How many paths the cap removed before this group existed.
   *
   * CARRIED SO THE GIT LEG CAN REFUSE. `checkClaimDrift` compares what it
   * kept against what it was given, and the cut happens up here — so without
   * this number the surface looks whole to the only code that could refuse an
   * `unchanged` over it.
   */
  readonly droppedPaths: number;
  /** Where that surface came from: the author, or the whole work context. */
  readonly basis: "declared" | "context_targets";
  /** Claims answered by one check. */
  readonly claimIds: readonly string[];
  /** Newest claim in the group, the ordering proxy above. */
  readonly newestAt: number;
}

export interface RevalidationPlan {
  /** Groups to measure, newest-first, already cut to the bound. */
  readonly groups: readonly RevalidationGroup[];
  /** How many groups the tree had before the cut: the honest denominator. */
  readonly total: number;
}

/** The work context's own file targets: the fallback surface, which over-fires. */
/**
 * The work context's file targets, capped — AND HOW MANY THE CAP DROPPED.
 *
 * THE COUNT IS THE WHOLE POINT. This cut used to be silent, and
 * `checkClaimDrift`'s completeness guard could not see it: the slice happens
 * HERE, so by the time the guard compared its own input against its own
 * filtered output there was nothing left to notice. A work context with 40
 * file targets lost ten of them and the answer came back `unchanged`, about a
 * surface that had never been measured whole.
 *
 * `context_targets` is the DEFAULT basis — it is what every claim that did not
 * declare its own paths falls back to — so this is the ordinary path rather
 * than an edge case.
 */
const contextTargets = (
  diagnosis: Diagnosis,
): { readonly paths: readonly string[]; readonly dropped: number } => {
  const all = diagnosis.targets
    .filter((target) => target.kind === "file")
    .map((target) => target.value);
  return {
    paths: all.slice(0, MAX_CLAIM_SURFACE_PATHS),
    dropped: Math.max(0, all.length - MAX_CLAIM_SURFACE_PATHS),
  };
};

/**
 * One key per (commit, path SET). JSON rather than a joined string, because a
 * path may legally contain the separator a join would use, and two different
 * surfaces must never collapse into one check; sorted, because a set has no
 * order and the hub is not obliged to send one.
 */
const groupKey = (commit: string, paths: readonly string[]): string =>
  JSON.stringify([commit, [...paths].sort()]);

const parsedTime = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * Which groups this tree would revalidate, and how many it has in total.
 *
 * A claim contributes nothing when it has no observation commit: that is
 * `commit_binding = 'none'`, the §8.5 refusal, where there is no "from" commit
 * and the rung cannot exist. Those claims are NOT counted in `total` either.
 * A denominator holding rows no bound could ever reach would make the cut look
 * worse than it is and hide the real one.
 */
export const planClaimRevalidation = (
  diagnosis: Diagnosis,
): RevalidationPlan => {
  const fallback = contextTargets(diagnosis);
  const byKey = new Map<string, RevalidationGroup>();
  for (const claim of diagnosis.claims) {
    const commit = claim.validity?.observedAtCommit ?? null;
    if (commit === null || claim.validity?.commitBinding === "none") {
      continue;
    }
    const declared = claim.affectedPaths ?? [];
    // BOTH CUTS ARE COUNTED, not just the fallback's. A declared surface is
    // capped at MAX_CLAIM_SURFACE_PATHS by the wire schema, so `declared`
    // arrives already bounded and this slice is normally a no-op — but an
    // older or hostile hub is not bound by our schema, and a silent slice
    // here would be the same defect one field over.
    const paths =
      declared.length > 0
        ? declared.slice(0, MAX_CLAIM_SURFACE_PATHS)
        : fallback.paths;
    const dropped =
      declared.length > 0
        ? Math.max(0, declared.length - MAX_CLAIM_SURFACE_PATHS)
        : fallback.dropped;
    if (paths.length === 0) {
      continue;
    }
    const key = groupKey(commit, paths);
    const at = parsedTime(claim.createdAt);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        observedAtCommit: commit,
        paths,
        droppedPaths: dropped,
        basis: declared.length > 0 ? "declared" : "context_targets",
        claimIds: [claim.id],
        newestAt: at,
      });
      continue;
    }
    byKey.set(key, {
      ...existing,
      claimIds: [...existing.claimIds, claim.id],
      newestAt: Math.max(existing.newestAt, at),
    });
  }
  const ordered = [...byKey.values()].sort((a, b) => b.newestAt - a.newestAt);
  return {
    groups: ordered.slice(0, REVALIDATION_GROUPS_PER_PULL),
    total: ordered.length,
  };
};

export interface RevalidationReadings {
  readonly entries: readonly ClaimRevalidationEntry[];
  /** Groups measured, and groups the tree had: CCB-9's reported cut. */
  readonly revalidated: number;
  readonly total: number;
}

/**
 * Measures the planned groups against the reader's clone, every range asked
 * against ONE resolved ref commit — the one each entry names.
 *
 * EVERY LEG FAILS TO `unknown`. `checkClaimDrift` never throws and never
 * returns `unchanged` for a question git declined to answer, so a repo that
 * cannot answer — a shallow clone, a missing object, an exhausted deadline —
 * downgrades nothing and vouches for nothing.
 */
export const readClaimDrift = async (
  root: string,
  refCommit: string,
  plan: RevalidationPlan,
): Promise<RevalidationReadings> => {
  const entries: ClaimRevalidationEntry[] = [];
  for (const group of plan.groups) {
    const drift = await checkClaimDrift(
      root,
      refCommit,
      group.observedAtCommit,
      group.paths,
      // THE CUT TRAVELS WITH THE GROUP. Without it the git leg sees a whole
      // surface and answers `unchanged` for files it never listed.
      group.droppedPaths,
    );
    for (const claimId of group.claimIds) {
      entries.push({
        claimId,
        result: drift.result,
        basis: group.basis,
        refCommit,
        touchingCommits: [...drift.touchingCommits],
        touchingTotal: drift.touchingTotal,
      });
    }
  }
  return { entries, revalidated: plan.groups.length, total: plan.total };
};
