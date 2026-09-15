/**
 * A CLAIM'S VALIDITY — how much a recorded assertion is still worth about the
 * CODE, on the git axis rather than on a clock (1.0 spec 02 §3.5).
 *
 * THE POINT, IN NICK'S WORDS: a memory system may hold bad memories, but an
 * engineering knowledge system must not turn time-dependent findings into
 * timeless truths. "Raising the timeout does nothing" is gold today and
 * collective technical superstition after the reader was rebuilt.
 *
 * DERIVED ON READ, NEVER STORED. A stored verdict outlives its evidence: the
 * revalidation row it comes from is pruned at
 * CLAIM_REVALIDATION_RETENTION_DAYS, and a claim must go back to `unknown`
 * when that happens rather than keep a verdict nobody can still justify.
 *
 * ── ONE AUTHORITY, AND WHAT BECAME OF THE OTHERS ───────────────────────────
 *
 * The spec claimed one authority; the tree had SIX predicates about whether a
 * claim is "still live". They are not six definitions — they are six readers
 * of ONE fact, the `supersedes` EDGE — and this function is the only thing
 * that turns that fact (plus a binding and a revalidation) into a VALIDITY
 * STATE. Written down here because the next reader will find all six:
 *
 *   FEEDS THIS FUNCTION
 *   · services/referee.ts findSupersededBy — reused verbatim as the
 *     `supersededByClaimId` argument on the referee route.
 *   · services/diagnosis.ts — the tree already loads every edge touching its
 *     claims (listEdgesTouching), so the superseded leg costs NO extra query
 *     there; only hints and referee need the batched IN (…).
 *
 *   STAY INDEPENDENT, AND WHY
 *   · services/hints.ts notSuperseded(db) — the same edge, applied as a QUERY
 *     FILTER before the window rather than as a state afterwards. Removing it
 *     would mean loading retracted rows to drop them later.
 *   · services/solved.ts — asks whether a TREE is solved, not whether a claim
 *     is current; it happens to read the same edge on the solving claim and
 *     on its rivals.
 *   · services/contradictions.ts sideIsLive — reads BOTH the edge and
 *     `status <> 'superseded'`, and is about pairing two live positions.
 *   · connector mcp/render.ts solvedAtFromTree — edge-derived, inside ONE
 *     tree the connector already holds. No hub call to add.
 *
 * `claims.status === "superseded"` stays the AUTHOR'S WORD and stops being a
 * gate: the edge outranks it. The one place it still appears as a gate is
 * connector-side (hints/select.ts), kept deliberately as defence in depth
 * against a forging hub — that file says so at the call site.
 *
 * `last_revalidated_at` is a FRESHNESS-OF-ANSWER fact, the kind
 * `commit_evidence.collected_at` already is. It is never arithmetic for a
 * verdict: computing `now() - lastRevalidatedAt` would re-invent the clock
 * definition this module exists to replace.
 *
 * The vocabulary is defined once (schema, re-exported through its barrel) and
 * DECIDED once (here). Every other module receives a state it did not compute
 * and maps it to a sentence through an exhaustive Record, the way
 * FILE_DRIFT_SENTENCES already does for SolvedFileDrift.
 *
 * VERIFY: grep -rlE 'CLAIM_VALIDITY_STATES' packages/schema/src/enums.ts packages/server/src packages/connector-core/src packages/cli/src
 * PRINTS: packages/schema/src/enums.ts
 * PRINTS: packages/server/src/services/claim-validity.ts
 */
import { asc, inArray } from "drizzle-orm";
import type {
  ClaimCommitBinding,
  ClaimRevalidationBasis,
  ClaimValidity,
  ClaimValidityState,
} from "@crosscheck/schema";

import { claimRevalidations, claimSurfaces } from "../db/schema.ts";
import type { Db } from "../db/client.ts";

/** The three inputs, as the row shapes the callers already hold. */
export interface ClaimValidityInput {
  readonly status: string;
  readonly observedAtCommit: string | null;
  readonly commitBinding: ClaimCommitBinding;
}

export interface ClaimRevalidationReading {
  readonly result: string;
  readonly basis: ClaimRevalidationBasis;
  readonly touchingCommits: readonly string[];
  readonly touchingTotal: number | null;
  readonly revalidatedAt: Date;
}

/** The author-declared status that means "this turned out to be wrong". */
const REJECTED_STATUS = "rejected";

/**
 * Resolution order, FIRST MATCH WINS. This is the whole definition.
 *
 *   superseded   a `supersedes` edge points AT this claim
 *   invalidated  the author set status `rejected`
 *   unknown      commit_binding is 'none' — nothing to revalidate against
 *   stale        the latest revalidation says `changed`
 *   current      the latest revalidation says `unchanged`
 *   unknown      no row, or the row says `unknown`
 *
 * THE BINDING TEST SITS ABOVE THE REVALIDATION ROWS, and the spec's own table
 * put it last. Under "first match wins" that ordering lets a claim bound to
 * NOTHING read `current` off a stored `unchanged` — which is AT-2's first
 * "fails if" verbatim ("a claim can be surfaced as current with no commit
 * binding"). The state is unreachable through this hub's own writers (a
 * 'none' claim is never revalidated), so the two orderings agree on every
 * reachable row; they differ only where the safe answer matters.
 *
 * NOTHING HERE READS A CLOCK. Two claims of identical age get different
 * verdicts when their code did, and that asymmetry is the product.
 */
export const claimValidity = (
  claim: ClaimValidityInput,
  revalidation: ClaimRevalidationReading | undefined,
  supersededByClaimId: string | null,
): ClaimValidity => {
  const base = {
    observedAtCommit: claim.observedAtCommit,
    commitBinding: claim.commitBinding,
    basis: revalidation?.basis ?? null,
    touchingCommits: [...(revalidation?.touchingCommits ?? [])],
    touchingTotal: revalidation?.touchingTotal ?? null,
    lastRevalidatedAt: revalidation?.revalidatedAt.toISOString() ?? null,
    supersededByClaimId,
  };
  return { ...base, state: resolveState(claim, revalidation, supersededByClaimId) };
};

const resolveState = (
  claim: ClaimValidityInput,
  revalidation: ClaimRevalidationReading | undefined,
  supersededByClaimId: string | null,
): ClaimValidityState => {
  if (supersededByClaimId !== null) {
    return "superseded";
  }
  if (claim.status === REJECTED_STATUS) {
    return "invalidated";
  }
  if (claim.commitBinding === "none") {
    return "unknown";
  }
  if (revalidation?.result === "changed") {
    return "stale";
  }
  if (revalidation?.result === "unchanged") {
    return "current";
  }
  return "unknown";
};

/**
 * Is this claim still a CURRENT statement about the code?
 *
 * `unknown` is NOT current — and it is still injectable, which sounds like a
 * contradiction and is not. "Current" is a positive measurement somebody took;
 * the substance gate refuses the three states that are positive measurements
 * the OTHER way (stale, invalidated, superseded) and lets `unknown` through,
 * because refusing everything unmeasured would silence a whole hub on the day
 * this shipped. hints/select.ts is where that distinction is spent.
 */
export const isCurrent = (validity: ClaimValidity): boolean =>
  validity.state === "current";

/**
 * The latest reading for each of these claims, in ONE batched query.
 *
 * The diagnosis route does not need the edges half (it already holds every
 * edge touching the tree); hints, search and referee do, and each asks for its
 * own page of claims rather than a table scan.
 */
export const loadRevalidations = async (
  db: Db,
  claimIds: readonly string[],
): Promise<ReadonlyMap<string, ClaimRevalidationReading>> => {
  const unique = [...new Set(claimIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await db
    .select()
    .from(claimRevalidations)
    .where(inArray(claimRevalidations.claimId, unique));
  return new Map(
    rows.map((row) => [
      row.claimId,
      {
        result: row.result,
        basis: row.basis,
        touchingCommits: row.touchingCommits,
        touchingTotal: row.touchingTotal,
        revalidatedAt: row.revalidatedAt,
      },
    ]),
  );
};

/**
 * The DECLARED surface of each of these claims, in ONE batched query.
 *
 * Empty for a claim whose author declared nothing, which is not a statement
 * that the claim touches no files: the reader then falls back to the work
 * context's own `file` targets and says so through `basis`.
 */
export const loadClaimSurfaces = async (
  db: Db,
  claimIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> => {
  const unique = [...new Set(claimIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ claimId: claimSurfaces.claimId, path: claimSurfaces.path })
    .from(claimSurfaces)
    .where(inArray(claimSurfaces.claimId, unique))
    .orderBy(asc(claimSurfaces.claimId), asc(claimSurfaces.path));
  const byClaim = new Map<string, string[]>();
  for (const row of rows) {
    const existing = byClaim.get(row.claimId);
    if (existing === undefined) {
      byClaim.set(row.claimId, [row.path]);
      continue;
    }
    existing.push(row.path);
  }
  return byClaim;
};
