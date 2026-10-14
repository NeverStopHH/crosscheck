/**
 * Solved-tree identification (VISION.md §1 collective memory), deterministic
 * and derived fresh per read — no LLM, no stored flag, nothing to go stale.
 *
 * A work context is SOLVED when it holds at least one likely_root_cause claim
 * that (a) still stands — not revised away by a supersedes edge, the same
 * probe the hints path applies (services/hints.ts notSuperseded) — and
 * (b) carries evidence that RESOLVES, the anchoring-asymmetry evidence rule: a
 * root cause without evidence is a theory, and a theory must never earn the
 * solved ranking floor or the solved label readers treat as settled. A ref
 * counts by the one rule the hint's evidenceBacked and the connector's
 * mirror apply too (`@crosscheck/schema` evidence-resolution.ts, hold-out
 * review H5 + M2): its revision head a standing, declared observation or
 * piece of evidence with content, in the same repo, and neither the claim
 * itself nor its own revision chain. A count of refs used to be the floor, and
 * a self-cite, a draft, a refuted observation or a decision citing it back
 * read SOLVED — and
 * (c) carries DECLARED provenance, the gate every sibling trust surface
 * applies (contradictions on both sides, similarity-gate, the hint
 * selector's isDeclared): a machine-derived row is nobody's vouched answer,
 * and SOLVED is a trust label — the wire admits derived + likely_root_cause
 * + evidence at the confidence cap, so without this clause a row no shipped
 * writer produces (but a modified connector could mint) would stamp the tree
 * settled — and (d) is not DEADLOCKED: while a contradicts edge joins it to
 * another qualifying likely_root_cause in the same tree, the tree holds two
 * standing answers that cannot both be right. That is the referee-mode
 * dispute (DESIGN.md §4), and a dispute must not read settled on any
 * surface. A rival whose evidence does not resolve, derived or superseded
 * does not count — a drive-by theory cannot unsolve a tree, and retracting
 * one side of a deadlock settles it again.
 *
 * SOLVED is a fact about the DIAGNOSIS (the tree says what the root cause
 * was); LANDED (work_contexts.landed_at, services/landed.ts) is a fact about
 * the CODE (git says the session's base commit reached the default branch).
 * They are independent and compose by not being conflated: a tree can be
 * solved with its fix still in review, or landed without any recorded root
 * cause. Ranking (the search decay floor) keys on SOLVED alone — the retained
 * knowledge is what the floor protects; presentation states each separately.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

import { agentSessions, claimEdges, claims } from "../db/schema.ts";
import { resolvedEvidenceCounts } from "./evidence-resolution.ts";
import { DECLARED_PROVENANCE } from "./similarity-gate.ts";
import type { Db } from "../db/client.ts";

/** The one claim status that can mark a tree solved. */
export const SOLVED_CLAIM_STATUS = "likely_root_cause";

/**
 * Evidence floor for the solving claim — mirrors the connector's
 * HINT_MIN_EVIDENCE_REFS (packages/connector-core/src/constants.ts) and the
 * wire rule in @crosscheck/schema (likely_root_cause requires ≥1 evidence
 * ref); enforced here too so a row that bypassed ingest cannot count, and
 * counted in RESOLVED refs, not stored ones.
 */
export const SOLVED_MIN_EVIDENCE_REFS = 1;

/**
 * Read bound on candidate rows PER CONTEXT (hold-out review round 3, M3). It
 * used to bound the whole lookup, newest first, BEFORE evidence resolved — so
 * 210 newer root causes citing themselves in one tree filled the window and
 * hid the next tree's backed cause, and its solved label with it. Per tree,
 * one tree's noise can only crowd itself; a tree holds a handful of standing
 * root causes, so this is the usual "bounded like every other query" floor.
 */
const SOLVED_CANDIDATE_MAX_ROWS_PER_CONTEXT = 50;

/** Same-author revision edge; its TARGET is the retracted claim. */
const SUPERSEDES_EDGE_KIND = "supersedes";

/** Disagreement edge; between two qualifying root causes it is a deadlock. */
const CONTRADICTS_EDGE_KIND = "contradicts";

/**
 * The claims that could solve a tree, before their evidence is resolved:
 * standing, declared root causes carrying at least one stored ref. The
 * stored count is a necessary bound for the query, never the rule.
 */
const candidateClaimCondition = (contextIds: readonly string[]): SQL =>
  and(
    inArray(claims.workContextId, [...contextIds]),
    eq(claims.status, SOLVED_CLAIM_STATUS),
    eq(claims.provenance, DECLARED_PROVENANCE),
    sql`jsonb_array_length(${claims.evidenceRefs}) >= ${SOLVED_MIN_EVIDENCE_REFS}`,
    sql`NOT EXISTS (SELECT 1 FROM ${claimEdges} WHERE ${claimEdges.toClaimId} = ${claims.id} AND ${claimEdges.kind} = ${SUPERSEDES_EDGE_KIND})`,
  ) as SQL;

interface SolvingClaim {
  readonly id: string;
  readonly workContextId: string;
  readonly createdAt: Date;
  readonly body: string;
  readonly confidence: number;
  readonly verificationRef: string | null;
  readonly commitBinding: string;
  readonly observedAtCommit: string | null;
  /** Who wrote it: its commit is that author's HEAD (SolvedRootCause.authorDeveloperId). */
  readonly authorDeveloperId: string;
}

/**
 * Qualifying claims a contradicts edge joins to another qualifying claim of
 * the same tree. The connector's mirror (mcp/render.ts solvedAtFromTree)
 * only sees one tree's claims, and the two rules answer identically.
 */
const listDeadlocked = async (db: Db, qualifying: readonly SolvingClaim[]): Promise<ReadonlySet<string>> => {
  if (qualifying.length < 2) {
    return new Set();
  }
  const ids = qualifying.map((claim) => claim.id);
  const treeOf = new Map(qualifying.map((claim) => [claim.id, claim.workContextId]));
  const edges = await db
    .select({ from: claimEdges.fromClaimId, to: claimEdges.toClaimId })
    .from(claimEdges)
    .where(and(eq(claimEdges.kind, CONTRADICTS_EDGE_KIND), inArray(claimEdges.fromClaimId, ids), inArray(claimEdges.toClaimId, ids)));
  return new Set(edges.filter((edge) => treeOf.get(edge.from) === treeOf.get(edge.to)).flatMap((edge) => [edge.from, edge.to]));
};

/**
 * THE solved predicate: every rule the header states, over a caller-bounded
 * id list, newest first. Two readers need it — "is this tree solved, and
 * when" and "what does it say the cause was" — and two spellings of a trust
 * rule are two rules. A body served under the solved label by a query that
 * had drifted from this one would be substance injected on a vouch nobody
 * made.
 */
/** The candidate claims of `contextIds`, newest first, within one bound (M3: one tree per call). */
const listCandidatesOf = (db: Db, contextIds: readonly string[]) =>
  db
    .select({
      id: claims.id,
      workContextId: claims.workContextId,
      createdAt: claims.createdAt,
      body: claims.body,
      confidence: claims.confidence,
      verificationRef: claims.verificationRef,
      commitBinding: claims.commitBinding,
      observedAtCommit: claims.observedAtCommit,
      authorDeveloperId: agentSessions.developerId,
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(candidateClaimCondition(contextIds))
    .orderBy(desc(claims.createdAt))
    .limit(SOLVED_CANDIDATE_MAX_ROWS_PER_CONTEXT);

const listSolvingClaims = async (db: Db, contextIds: readonly string[]): Promise<readonly SolvingClaim[]> => {
  if (contextIds.length === 0) {
    return [];
  }
  // PER TREE (round 3, M3): each bounded on its own, so no tree's flood can
  // push another tree's cause out of the window before evidence resolves.
  const candidates = (await Promise.all(contextIds.map((contextId) => listCandidatesOf(db, [contextId])))).flat();
  const resolved = await resolvedEvidenceCounts(db, candidates.map((claim) => claim.id));
  const qualifying = candidates.filter((claim) => (resolved.get(claim.id) ?? 0) >= SOLVED_MIN_EVIDENCE_REFS);
  const deadlocked = await listDeadlocked(db, qualifying);
  return qualifying.filter((claim) => !deadlocked.has(claim.id));
};

/**
 * A NECESSARY condition for solvedness, as a correlated EXISTS over whichever
 * work-context column a listing already has in hand — the cheap half of the
 * predicate above (status + provenance + a stored ref), WITHOUT the
 * supersedes probe, the evidence resolution and the deadlock probe.
 *
 * WHY A SECOND, WEAKER SPELLING EXISTS at all, when this file's whole point
 * is that the solved rule has one: because a listing that JOINS to find
 * candidates has to bound what it reads BEFORE it can ask a claims-side
 * question about each one, and "every context that ever shared this value"
 * is not a bounded set. The solved-match listing paid for that with a
 * measured 1.2 s and, worse, with the answer itself falling out of its own
 * LIMIT behind hundreds of unsolved contexts sharing one hot fingerprint
 * (test/solved-fanout.test.ts).
 *
 * THE DIRECTION IS THE CONTRACT: this may over-include, never under-include.
 * It admits a superseded, unbacked or deadlocked tree; `listSolvedInfo` —
 * still run by every caller afterwards, on the ids this narrowed down to —
 * then refuses it. So the trust rule keeps exactly one spelling; this is a
 * read bound wearing its shape, and a tree it wrongly admits costs a row,
 * never a claim.
 */
export const solvedCandidateCondition = (contextId: SQL | AnyColumn): SQL =>
  sql`EXISTS (
    SELECT 1 FROM claims sc
     WHERE sc.work_context_id = ${contextId}
       AND sc.status = ${SOLVED_CLAIM_STATUS}
       AND sc.provenance = ${DECLARED_PROVENANCE}
       AND jsonb_array_length(sc.evidence_refs) >= ${SOLVED_MIN_EVIDENCE_REFS}
  )`;

/**
 * Which of `contextIds` are solved, and when — `solvedAt` is the newest
 * qualifying claim's createdAt, the "diagnosed N days ago" every surface
 * states plainly (honest presentation). Bounded queries: the id list is
 * caller-bounded (search tier candidates, hint candidates), and the
 * supersedes probe rides the claim_edges_to_kind_idx index the hints path
 * already created.
 */
export const listSolvedInfo = async (
  db: Db,
  contextIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> => {
  const solving = await listSolvingClaims(db, contextIds);
  return solving.reduce<ReadonlyMap<string, Date>>((solvedAt, claim) => {
    const known = solvedAt.get(claim.workContextId);
    return known !== undefined && known.getTime() >= claim.createdAt.getTime()
      ? solvedAt
      : new Map([...solvedAt, [claim.workContextId, claim.createdAt]]);
  }, new Map());
};

/** A solved tree's recorded cause, with the label the reader weighs it by. */
export interface SolvedRootCause {
  readonly body: string;
  /**
   * THE CLAIM'S OWN CONFIDENCE, carried because this body is injected into a
   * reader's context unasked and every other injected claim prints its
   * labels (DESIGN.md §4). Nothing in the solved predicate is a floor on it:
   * `publish_claim` takes the number from the model, and a 0.05 hedge with
   * one evidence ref is a legal, honest `likely_root_cause`. So the number
   * travels and the renderer states it, rather than the surface quietly
   * presenting a guess as a settled answer.
   */
  readonly confidence: number;
  /**
   * WHICH claim this body is, so a reader can ask what it is still worth
   * about the code (1.0 spec 02 §5). The body is asserted unasked at
   * SessionStart; every other surface that asserts one gets the hub's
   * verdict beside it, and this one needs the id to derive it.
   */
  readonly claimId: string;
  /**
   * What the evidence ladder needs to answer "was anything RUN behind this"
   * (1.0 spec 08 §3.1), carried off the same row rather than re-queried.
   *
   * The briefing asserts this body UNASKED with a confidence beside it, which
   * is the shape 08 §3.6 calls the failure mode — so the labels have to travel
   * with it, and they cannot be derived without these three.
   */
  readonly verificationRef: string | null;
  readonly commitBinding: string;
  readonly observedAtCommit: string | null;
  /**
   * Who wrote the cause: its commit is that author's HEAD, which a viewer
   * their live location is hidden from does not get (services/live-location.ts).
   */
  readonly authorDeveloperId: string;
}

/**
 * What each solved tree of `contextIds` says the cause WAS — the newest
 * qualifying claim's body, which is by construction the same claim whose
 * createdAt `listSolvedInfo` reports as `solvedAt`: same predicate, same
 * ordering key, so the sentence a reader sees and the age printed beside it
 * always describe one claim. Its confidence rides along for the same reason:
 * one claim, one set of labels.
 *
 * ONE PER TREE, NEVER A CUT ACROSS TREES (round 3, M3): the answer holds at
 * most one cause per caller-bounded id, and a cut of the qualifying rows —
 * a cap of fifty, newest first — let a tree of sixty backed causes push the
 * next tree's out of it.
 */
export const listSolvedRootCauses = async (
  db: Db,
  contextIds: readonly string[],
): Promise<ReadonlyMap<string, SolvedRootCause>> => {
  const solving = await listSolvingClaims(db, contextIds);
  return solving.reduce<ReadonlyMap<string, SolvedRootCause>>(
    (newest, claim) =>
      newest.has(claim.workContextId)
        ? newest
        : new Map([
            ...newest,
            [
              claim.workContextId,
              {
                claimId: claim.id,
                body: claim.body,
                confidence: claim.confidence,
                verificationRef: claim.verificationRef,
                commitBinding: claim.commitBinding,
                observedAtCommit: claim.observedAtCommit,
                authorDeveloperId: claim.authorDeveloperId,
              },
            ],
          ]),
    new Map(),
  );
};
