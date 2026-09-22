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
import { and, asc, count, desc, eq, gte, inArray, or } from "drizzle-orm";
import type {
  ClaimCommitBinding,
  ClaimRevalidationBasis,
  ClaimValidity,
  ClaimValidityState,
} from "@crosscheck/schema";

import {
  CLAIM_REVALIDATION_RETENTION_DAYS,
  CLAIM_VALIDITY_SUMMARY_MAX_CLAIMS,
} from "../constants.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
import {
  agentSessions,
  claimEdges,
  claimRevalidations,
  claimSurfaces,
  claims,
} from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";

/** The one edge kind that retires a claim; the same literal four services read. */
const SUPERSEDES_EDGE_KIND = "supersedes";

/** The four inputs, as the row shapes the callers already hold. */
export interface ClaimValidityInput {
  readonly kind: string;
  readonly status: string;
  readonly observedAtCommit: string | null;
  readonly commitBinding: ClaimCommitBinding;
}

export interface ClaimRevalidationReading {
  readonly result: string;
  readonly basis: ClaimRevalidationBasis;
  readonly touchingCommits: readonly string[];
  readonly touchingTotal: number | null;
  /**
   * The ref state the reading was taken against. Stored since the feature
   * landed and shipped by nothing, so the sentence built from the reading
   * claimed more than the reading supported — see ClaimValiditySchema.
   */
  readonly refCommit: string | null;
  readonly revalidatedAt: Date;
}

/** The author-declared status that means "this turned out to be wrong". */
const REJECTED_STATUS = "rejected";

/**
 * THE ONE KIND WHOSE `rejected` STATUS IS NOT A RETRACTION — and the reason
 * `invalidated` has to ask about kind at all.
 *
 * A `rejected_approach` claim RECORDS a rejection: "retrying the refresh call
 * does not help". `rejected` is that kind's natural resting status, not the
 * author taking the finding back — and DESIGN.md §4 privileges exactly this
 * category above every other ("negative knowledge cannot anchor a wrong
 * theory, only save a dead end").
 *
 * Reading the status alone, as spec 02 §3.5's table does, makes every piece of
 * negative knowledge `invalidated` from the moment it is written: answered by
 * its own status forever, never `stale`, never naming the commits that
 * rewrote its code — and rendered as "its author rejected it", which says the
 * opposite of what the author wrote. Nick's own example of the problem this
 * module exists for, "raising the timeout does nothing", is a rejected
 * approach; it must be able to GO STALE when the reader is rebuilt, which is
 * the only thing that turns it from gold into superstition.
 *
 * So this kind walks the code axis like every other claim. Every other kind's
 * `rejected` still means a retraction and still reads `invalidated`.
 */
const REJECTION_IS_THE_FINDING_KIND = "rejected_approach";

/**
 * Resolution order, FIRST MATCH WINS. This is the whole definition.
 *
 *   superseded   a `supersedes` edge points AT this claim
 *   invalidated  the author RETRACTED it: status `rejected` on a kind whose
 *                rejection is not itself the finding (see the constant above)
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
    refCommit: revalidation?.refCommit ?? null,
    touchingCommits: [...(revalidation?.touchingCommits ?? [])],
    touchingTotal: revalidation?.touchingTotal ?? null,
    lastRevalidatedAt: revalidation?.revalidatedAt.toISOString() ?? null,
    supersededByClaimId,
  };
  return { ...base, state: resolveState(claim, revalidation, supersededByClaimId) };
};

/** The author took it back — as opposed to having written down a rejection. */
const isRetracted = (claim: ClaimValidityInput): boolean =>
  claim.status === REJECTED_STATUS &&
  claim.kind !== REJECTION_IS_THE_FINDING_KIND;

const resolveState = (
  claim: ClaimValidityInput,
  revalidation: ClaimRevalidationReading | undefined,
  supersededByClaimId: string | null,
): ClaimValidityState => {
  if (supersededByClaimId !== null) {
    return "superseded";
  }
  if (isRetracted(claim)) {
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
  db: DbExecutor,
  now: Date,
  claimIds: readonly string[],
): Promise<ReadonlyMap<string, ClaimRevalidationReading>> => {
  const unique = [...new Set(claimIds)];
  if (unique.length === 0) {
    return new Map();
  }
  // RETENTION IS PART OF THE DEFINITION, not a side effect of traffic.
  //
  // The module header justifies deriving the state on read with "a stored
  // verdict outlives its evidence: the revalidation row it comes from is
  // pruned at CLAIM_REVALIDATION_RETENTION_DAYS, and a claim must go back to
  // `unknown` when that happens". The prune was reachable only from
  // `ingestClaimRevalidations` — only when somebody POSTs — so a repo nobody
  // revalidates again kept answering `current` indefinitely. Measured at 400
  // days with no POST in between: still `current`, on a reading whose
  // retention had expired thirteen times over.
  //
  // AGE RETIRES A READING THAT CARRIES NO DOWNGRADE, and nothing else. A
  // `changed` row is the positive proof that a claim stopped describing the
  // code; hiding it on a timer would return the claim to `unknown`, which the
  // substance gate ADMITS — missing evidence strengthening a conclusion. The
  // ingest prune follows the same rule, and the two have to agree or a row
  // would be readable and unprunable, or the reverse.
  const readableFrom = new Date(
    now.getTime() - CLAIM_REVALIDATION_RETENTION_DAYS * MS_PER_DAY,
  );
  const rows = await db
    .select()
    .from(claimRevalidations)
    .where(
      and(
        inArray(claimRevalidations.claimId, unique),
        or(
          eq(claimRevalidations.result, "changed"),
          gte(claimRevalidations.revalidatedAt, readableFrom),
        ),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.claimId,
      {
        result: row.result,
        basis: row.basis,
        touchingCommits: row.touchingCommits,
        touchingTotal: row.touchingTotal,
        refCommit: row.refCommit,
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
  db: DbExecutor,
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

/**
 * THE DERIVED STATE OF EACH OF THESE CLAIMS, in three batched queries.
 *
 * Exists so that the caller who just WROTE a revalidation can render the
 * verdict on the same round trip. Without it a reader pulls a tree, the
 * connector computes drift, posts it — and the downgrade first appears on the
 * NEXT pull, which is not what AT-2 asks for ("stays readable but is no longer
 * presented as a current cause", not "will be next time").
 *
 * THE ALTERNATIVE WAS A SECOND DEFINITION. The connector holds the drift
 * result and could map it to a state itself, which is exactly the two-silent-
 * definitions defect this spec exists to prevent: it holds no edges and no
 * stored row, so its opinion would disagree with the hub's the moment a
 * `supersedes` edge or a refused downgrade existed. The hub derives; the
 * connector renders what it is handed.
 */
export const loadClaimValidities = async (
  db: DbExecutor,
  now: Date,
  claimIds: readonly string[],
): Promise<ReadonlyMap<string, ClaimValidity>> => {
  const unique = [...new Set(claimIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const [rows, revalidations, supersededBy] = await Promise.all([
    db
      .select({
        id: claims.id,
        kind: claims.kind,
        status: claims.status,
        observedAtCommit: claims.observedAtCommit,
        commitBinding: claims.commitBinding,
      })
      .from(claims)
      .where(inArray(claims.id, unique)),
    loadRevalidations(db, now, unique),
    loadSupersededBy(db, unique),
  ]);
  return new Map(
    rows.map((row) => [
      row.id,
      claimValidity(
        row,
        revalidations.get(row.id),
        supersededBy.get(row.id) ?? null,
      ),
    ]),
  );
};

/**
 * Which of these claims a `supersedes` edge points AT, and from where.
 *
 * The same edge and the same index `findSupersededBy` reads one claim at a
 * time (services/referee.ts) — batched, because a report names many claims and
 * a query per claim is the N+1 the diagnosis route avoids by holding its edges.
 * Newest edge wins, so a claim revised twice names its latest revision.
 */
export const loadSupersededBy = async (
  db: DbExecutor,
  claimIds: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const unique = [...new Set(claimIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      toClaimId: claimEdges.toClaimId,
      fromClaimId: claimEdges.fromClaimId,
    })
    .from(claimEdges)
    .where(
      and(
        inArray(claimEdges.toClaimId, unique),
        eq(claimEdges.kind, SUPERSEDES_EDGE_KIND),
      ),
    )
    .orderBy(asc(claimEdges.createdAt));
  // Ascending, then last-write-wins: the newest edge ends up in the map.
  return new Map(rows.map((row) => [row.toClaimId, row.fromClaimId]));
};

/**
 * WHAT THIS REPO'S CLAIMS READ AS, as counts — spec 02 §8.5's doctor refusal
 * and §8.9's line, and nothing else.
 *
 * DERIVED, NOT AGGREGATED. Every count here comes from `claimValidity()` via
 * `loadClaimValidities`, never from a `GROUP BY commit_binding` that would be
 * a SECOND definition of currency written in SQL — the defect this module
 * exists to prevent, arriving through the back door of a summary endpoint.
 * The cost is three batched queries over a bounded row set instead of one
 * aggregate over all of them, and the bound is reported rather than hidden.
 *
 * NEWEST FIRST, because the cut has to fall somewhere and a five-year repo's
 * oldest claims are the ones a reader is least likely to be about to act on.
 * `counted / total` says how much of the repo the answer covers;
 * `capture-health.ts`'s rule, that a bound must not be spent at random and
 * must not claim more than it measured.
 *
 * COUNTS ONLY. No id, no body, no path, no developer — doctor prints this to
 * a terminal and the question it answers is "how much of what this team knows
 * can be judged at all", which is a number.
 */
export interface ClaimValiditySummary {
  /** Claims whose state was derived: at most the bound. */
  readonly counted: number;
  /** Claims this repo has. `counted < total` means the bound was spent. */
  readonly total: number;
  /**
   * Claims bound to NO commit. These can never be revalidated — there is no
   * "from" commit, so the rung cannot exist (§8.5) — and they are permanently
   * pointer-only. A count doctor names rather than a silence it keeps.
   */
  readonly unbound: number;
  /** Bound, but nobody has ever measured them against the code (§8.9). */
  readonly neverRevalidated: number;
  /** How many claims read as each state. */
  readonly states: Readonly<Record<ClaimValidityState, number>>;
}

const emptyStates = (): Record<ClaimValidityState, number> => ({
  current: 0,
  stale: 0,
  superseded: 0,
  invalidated: 0,
  unknown: 0,
});

export const summariseClaimValidity = async (
  db: DbExecutor,
  now: Date,
  repo: string,
): Promise<ClaimValiditySummary> => {
  // The repo a claim belongs to is its AUTHOR SESSION'S repo — the same join
  // every other per-repo claim query in this hub makes, and the reason
  // `agent_sessions_repo_idx` exists.
  const rows = await db
    .select({ id: claims.id })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(eq(agentSessions.repo, repo))
    .orderBy(desc(claims.createdAt))
    .limit(CLAIM_VALIDITY_SUMMARY_MAX_CLAIMS);
  const counted = await db
    .select({ n: count() })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(eq(agentSessions.repo, repo));
  const total = counted[0]?.n ?? rows.length;
  const validities = await loadClaimValidities(
    db,
    now,
    rows.map((row) => row.id),
  );
  const states = emptyStates();
  let unbound = 0;
  let neverRevalidated = 0;
  for (const validity of validities.values()) {
    states[validity.state] += 1;
    if (validity.commitBinding === "none") {
      unbound += 1;
      continue;
    }
    // A claim with a binding and no reading. Counted apart from `unbound`
    // because the two have OPPOSITE remedies: one is waiting for somebody to
    // pull or run `crosscheck revalidate`, the other can never be measured at
    // all and a remedy nobody can act on is worse than none.
    if (validity.lastRevalidatedAt === null) {
      neverRevalidated += 1;
    }
  }
  return { counted: validities.size, total, unbound, neverRevalidated, states };
};
