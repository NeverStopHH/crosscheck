/**
 * THE TWO EVIDENCE AXES, DERIVED FRESH PER READ (1.0 spec 08 §3.1).
 *
 * Nothing here is stored. The claim does not change; the world around its
 * check does — a run pruned past `CI_RETENTION_DAYS` moves a claim from
 * `repository_verified` back to `tool_observed`, and that is the honest answer
 * at that moment rather than a regression. Storing the label would freeze an
 * answer that was only true on the day it was computed.
 *
 * THE HUB RE-CHECKS NOTHING. It holds no repository, runs no commands and
 * makes no outbound calls (05 §8.4). Every rung below is decided by resolving
 * one pointer against rows this hub already has, and where that cannot settle
 * the question the answer is the WEAKER rung with a reason naming why — never
 * the stronger one on the strength of an empty table.
 *
 * FAILING CLOSED IS THE WHOLE DESIGN. Principle 5: missing evidence may weaken
 * a conclusion, it must never strengthen one. Every absence in this file
 * resolves downward.
 */
import { and, eq, inArray } from "drizzle-orm";

import type {
  EvidenceAxes,
  EvidenceSupportReason,
  VerificationRefKind,
} from "@crosscheck/schema";
import { VERIFICATION_REF_KINDS } from "@crosscheck/schema";

import type { DbExecutor } from "../db/client.ts";
import {
  ciRuns,
  ciTestResults,
  claimRevalidations,
  workContextTargets,
} from "../db/schema.ts";

/** What this module needs off a claim row; the caller already selected them. */
export interface ClaimAxesRow {
  readonly id: string;
  readonly workContextId: string;
  readonly verificationRef: string | null;
  /** `"none"` means the claim is bound to no commit at all (spec 02). */
  readonly commitBinding: string;
  readonly observedAtCommit: string | null;
}

export interface EvidenceAxesInput {
  readonly db: DbExecutor;
  readonly repo: string;
  readonly claims: readonly ClaimAxesRow[];
}

interface ParsedRef {
  readonly kind: VerificationRefKind;
  readonly value: string;
}

/**
 * `"<kind>:<value>"` — split at the FIRST colon only.
 *
 * The value itself contains colons in both kinds that exist: a fingerprint is
 * `sha256:<hex>` and a test id is `"<file>::<describe chain>::<name>"`.
 * Splitting on every colon would mangle both, and a mangled value resolves
 * against nothing — which would surface as `ref_unresolved`, a sentence about
 * the world, for what is really a parser bug.
 */
export const parseVerificationRef = (raw: string): ParsedRef | null => {
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    return null;
  }
  const kind = raw.slice(0, separator);
  const value = raw.slice(separator + 1);
  const known = VERIFICATION_REF_KINDS.find((candidate) => candidate === kind);
  return known === undefined ? null : { kind: known, value };
};

const unsupported = (reason: EvidenceSupportReason): EvidenceAxes => ({
  // EVERY CLAIM IN 1.0 IS `agent_derived`, and it is measured rather than
  // assumed (§1.3, §3.2): zero writers have ever produced a human capture
  // mode, and since §3.2a the wire cannot express one. `HumanAuthorityProbe`
  // is the seam for the day a human claim route exists; until then it answers
  // false unconditionally, which is the read-model's half of AT-3.
  who: "agent_derived",
  support: "unsupported",
  supportReason: reason,
  observedAt: null,
  verifiedAtCommit: null,
});

const toolObserved = (
  reason: EvidenceSupportReason,
  observedAt: string | null,
): EvidenceAxes => ({
  who: "agent_derived",
  support: "tool_observed",
  supportReason: reason,
  observedAt,
  verifiedAtCommit: null,
});

const repositoryVerified = (
  observedAt: string | null,
  verifiedAtCommit: string,
): EvidenceAxes => ({
  who: "agent_derived",
  support: "repository_verified",
  supportReason: "red_then_green",
  observedAt,
  verifiedAtCommit,
});

/**
 * The composite key for a fingerprint lookup.
 *
 * `JSON.stringify` of the pair rather than a separator character: a work
 * context id and a `sha256:` value both come from elsewhere, and any separator
 * I pick is a guess about what they cannot contain. An earlier version used a
 * NUL byte, which is unambiguous but wrote a literal 0x00 into this source
 * file and made git treat the whole module as binary — unreviewable.
 */
const fingerprintKey = (workContextId: string, value: string): string =>
  JSON.stringify([workContextId, value]);

/**
 * ONE QUERY for every error-fingerprint ref in the batch, never one per claim.
 *
 * Keyed by `(work_context_id, value)` because a fingerprint is only evidence
 * on the context that OBSERVED it: the same failure hash on somebody else's
 * context says a similar thing broke for them, not that this claim's check was
 * run. The `(kind, value)` index and the primary key both serve this.
 */
const resolveFingerprints = async (
  db: DbExecutor,
  wanted: readonly { readonly workContextId: string; readonly value: string }[],
): Promise<ReadonlyMap<string, Date | null>> => {
  const found = new Map<string, Date | null>();
  if (wanted.length === 0) {
    return found;
  }
  const rows = await db
    .select({
      workContextId: workContextTargets.workContextId,
      value: workContextTargets.value,
      createdAt: workContextTargets.createdAt,
    })
    .from(workContextTargets)
    .where(
      and(
        eq(workContextTargets.kind, "error_fingerprint"),
        inArray(
          workContextTargets.workContextId,
          wanted.map((entry) => entry.workContextId),
        ),
        inArray(
          workContextTargets.value,
          wanted.map((entry) => entry.value),
        ),
      ),
    );
  for (const row of rows) {
    found.set(fingerprintKey(row.workContextId, row.value), row.createdAt);
  }
  return found;
};

/** Every ci_test id in this batch that this repo has ever reported a row for. */
const resolveCiTests = async (
  db: DbExecutor,
  repo: string,
  testIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  if (testIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .selectDistinct({ testId: ciTestResults.testId })
    .from(ciTestResults)
    .where(
      and(eq(ciTestResults.repo, repo), inArray(ciTestResults.testId, testIds)),
    );
  return new Set(rows.map((row) => row.testId));
};

/**
 * THE FOUR LEGS OF `repository_verified` (§3.5), for ONE claim.
 *
 * 1. the claim is bound to a commit — else `no_binding`;
 * 2. the ref kind is `ci_test` — a fingerprint can show a failure was
 *    observed, never that a fix landed, so it stops at `observed_failure`;
 * 3. a `completed` run in ONE lane where the test is NON-GREEN at the bound
 *    commit;
 * 4. a `completed` run IN THAT SAME LANE where the test is ABSENT from the
 *    non-green list, at a commit this claim's surface was re-checked at.
 *
 * BEFORE AND AFTER COME FROM THE ROWS, NOT FROM A CLOCK AND NOT FROM A SHA
 * COMPARISON (§2). The red is at the claim's OWN bound commit — an exact
 * match, no ordering required. The green is at a
 * `claim_revalidations.ref_commit`, which spec 02 writes when it re-checks the
 * claim's surface at a newer HEAD, so it is later BY CONSTRUCTION. Two
 * runners' `started_at` values never enter it, which is the point: a
 * sender-controlled clamped timestamp is a ratchet, not an ordering.
 *
 * NARROWED FROM THE SPEC, AND THE SPEC NOW SAYS SO: §3.5 leg 3 also accepted a
 * red at "an ancestor inside that lane's base window". That is not buildable
 * here — deciding whether one commit is an ancestor of another needs the
 * repository, and the hub has none. Accepting a red at any OTHER commit in the
 * window instead would be strictly wrong: it would pair a failure from an
 * unrelated branch with a green here and call the result verified. So the red
 * must sit at the bound commit itself, which UNDER-reports and never
 * over-reports.
 *
 * ONLY A `completed` RUN ESTABLISHES A GREEN. A crashed or truncated run's
 * empty non-green list is an ABSENCE, and reading "nothing failed" off it is
 * exactly the inversion this project exists to refuse.
 */
const ciVerification = async (
  db: DbExecutor,
  repo: string,
  claim: ClaimAxesRow,
  testId: string,
): Promise<EvidenceAxes> => {
  // LEG 1 — no commit, no verification. Checked first because every leg below
  // is an argument about what happened AT a commit.
  if (claim.commitBinding === "none" || claim.observedAtCommit === null) {
    return toolObserved("no_binding", null);
  }
  const boundCommit = claim.observedAtCommit;

  // LEG 3 — the red, at the bound commit, in a completed run.
  const redRuns = await db
    .select({
      provider: ciRuns.provider,
      workflow: ciRuns.workflow,
      job: ciRuns.job,
      leg: ciRuns.leg,
      collectedAt: ciRuns.collectedAt,
    })
    .from(ciRuns)
    .innerJoin(ciTestResults, eq(ciTestResults.ciRunId, ciRuns.id))
    .where(
      and(
        eq(ciRuns.repo, repo),
        eq(ciRuns.commitSha, boundCommit),
        eq(ciRuns.outcome, "completed"),
        eq(ciTestResults.testId, testId),
      ),
    );
  const red = redRuns[0];
  if (red === undefined) {
    // The hub holds a row for this test but saw it fail at no commit this
    // claim is bound to. It was observed; it was not shown to have been
    // broken and then fixed.
    return toolObserved("ci_observed", null);
  }
  const observedAt = red.collectedAt.toISOString();

  // LEG 4 — the green, in the SAME lane, at a commit 02 re-checked this
  // claim's surface at. No revalidation means nobody has looked since, which
  // is an absence and therefore the weaker rung.
  const revalidations = await db
    .select({ refCommit: claimRevalidations.refCommit })
    .from(claimRevalidations)
    .where(eq(claimRevalidations.claimId, claim.id));
  const laterCommits = revalidations
    .map((row) => row.refCommit)
    .filter((commit) => commit !== boundCommit);
  if (laterCommits.length === 0) {
    return toolObserved("ci_observed", observedAt);
  }

  const greenCandidates = await db
    .select({ id: ciRuns.id, commitSha: ciRuns.commitSha })
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.repo, repo),
        eq(ciRuns.provider, red.provider),
        eq(ciRuns.workflow, red.workflow),
        eq(ciRuns.job, red.job),
        eq(ciRuns.leg, red.leg),
        eq(ciRuns.outcome, "completed"),
        inArray(ciRuns.commitSha, laterCommits),
      ),
    );
  if (greenCandidates.length === 0) {
    // A red that can no longer be paired: either nothing ran at the later
    // commit, or the run that did has aged out of CI_RETENTION_DAYS. Both are
    // "the pair is not re-derivable from what this hub holds".
    return toolObserved("pruned_by_retention", observedAt);
  }

  // ABSENT FROM THE NON-GREEN LIST IS THE GREEN. ci_test_results holds
  // non-green rows, so a test that is NOT there in a completed run is a test
  // that passed — and it is only readable that way because the run asserts its
  // list is complete.
  const stillFailing = await db
    .select({ ciRunId: ciTestResults.ciRunId })
    .from(ciTestResults)
    .where(
      and(
        inArray(
          ciTestResults.ciRunId,
          greenCandidates.map((run) => run.id),
        ),
        eq(ciTestResults.testId, testId),
      ),
    );
  const failingRunIds = new Set(stillFailing.map((row) => row.ciRunId));
  const green = greenCandidates.find((run) => !failingRunIds.has(run.id));
  return green === undefined
    ? toolObserved("ci_observed", observedAt)
    : repositoryVerified(observedAt, green.commitSha);
};

/**
 * The axes for a batch of claims.
 *
 * BATCHED ON THE TWO CHEAP RUNGS, per-claim only where a claim has a `ci_test`
 * ref that actually resolved — which is the rung that needs this claim's own
 * commit and its own revalidations, and cannot be answered set-wise. The
 * caller bounds the batch (`DIAGNOSIS_MAX_CLAIMS`), so the per-claim work is
 * bounded with it.
 */
export const readEvidenceAxes = async (
  input: EvidenceAxesInput,
): Promise<ReadonlyMap<string, EvidenceAxes>> => {
  const { db, repo, claims } = input;
  const axes = new Map<string, EvidenceAxes>();

  const parsed = new Map<string, ParsedRef>();
  for (const claim of claims) {
    if (claim.verificationRef === null) {
      axes.set(claim.id, unsupported("no_verification_ref"));
      continue;
    }
    const ref = parseVerificationRef(claim.verificationRef);
    if (ref === null) {
      // The pointer is not `<kind>:<value>`, or names a kind this version does
      // not know. DISTINCT FROM `ref_unresolved` on purpose: one is a claim we
      // cannot read, the other a claim we read and could not find. Collapsing
      // them would hide a newer producer's ref behind "no such row".
      axes.set(claim.id, unsupported("ref_malformed"));
      continue;
    }
    parsed.set(claim.id, ref);
  }

  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const fingerprintWanted = [...parsed.entries()]
    .filter(([, ref]) => ref.kind === "error_fingerprint")
    .map(([claimId, ref]) => ({
      workContextId: byId.get(claimId)?.workContextId ?? "",
      value: ref.value,
    }));
  const fingerprints = await resolveFingerprints(db, fingerprintWanted);
  const ciTestIds = [...parsed.values()]
    .filter((ref) => ref.kind === "ci_test")
    .map((ref) => ref.value);
  const knownCiTests = await resolveCiTests(db, repo, ciTestIds);

  for (const [claimId, ref] of parsed) {
    const claim = byId.get(claimId);
    if (claim === undefined) {
      continue;
    }
    if (ref.kind === "error_fingerprint") {
      const key = fingerprintKey(claim.workContextId, ref.value);
      const at = fingerprints.get(key);
      if (at === undefined) {
        axes.set(claimId, unsupported("ref_unresolved"));
        continue;
      }
      // A FINGERPRINT STOPS HERE, ALWAYS. It is the hash of a failure that was
      // seen; nothing about it can say a fix landed, so it can never reach
      // `repository_verified` however much else is true.
      //
      // `at` may itself be null, and that null means AGE UNKNOWN rather than
      // UNOBSERVED — work_context_targets.created_at is nullable by design,
      // and the row's existence is what settles the rung.
      axes.set(
        claimId,
        toolObserved("observed_failure", at === null ? null : at.toISOString()),
      );
      continue;
    }
    if (!knownCiTests.has(ref.value)) {
      axes.set(claimId, unsupported("ref_unresolved"));
      continue;
    }
    axes.set(claimId, await ciVerification(db, repo, claim, ref.value));
  }

  return axes;
};
