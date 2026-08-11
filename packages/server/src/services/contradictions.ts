/**
 * Diagnostic conflicts for briefings (DESIGN.md §1 point 4, §3 ingest gate).
 *
 * TWO SOURCES, ONE ANSWER — and the storage split is deliberate:
 *
 *   DERIVED (deterministic, keyless): claims of theory kinds by two DIFFERENT
 *   developers whose work contexts share a target and whose statuses sit on
 *   opposite sides of open-vs-rejected (one developer's own opposite-status
 *   theories are self-revision, not a deadlock — the where clause says why).
 *   Recomputed fresh per read rather than stored, because
 *   the signal has no ingest-order: the target that completes the overlap may
 *   arrive long after both claims, and a stored row written at claim-ingest
 *   time would simply never exist. The (kind, value) self-join is served by
 *   work_context_targets_kind_value_idx (bootstrap.sql; the targets PK leads
 *   with work_context_id and cannot serve it), and nothing can go stale.
 *
 *   STORED (similarity-detected): rows the ingest gate wrote while an
 *   embedder was configured (similarity-gate.ts). Stored because recomputing
 *   pairwise cosine at read time would be O(n²) over the claim store; the
 *   gate meets each new claim once, at ingest, where the probe is a single
 *   nearest-neighbor lookup backed by claims_embedding_hnsw_idx.
 *
 * A pair found by both sources is reported once, as "similarity" — the
 * stronger signal, since it carries a measured score.
 *
 * BOTH SOURCES REQUIRE DECLARED PROVENANCE ON BOTH SIDES. A derived claim is
 * a Tier-1 summarizer draft nobody vouched for (DESIGN.md §3: drafts are
 * "never proactively injected"), and these pairs feed the briefing's
 * contradiction pointers — lines that name their authors as HOLDING the
 * positions. The ingest gate stopped writing derived candidate rows for the
 * same reason (similarity-gate.ts applyCrossSimilarity); the filter here also
 * covers rows that predate that rule.
 *
 * BOTH SIDES SHIP RAW CLAIM BODIES, hub-convention (the hub returns raw, the
 * connector frames). The SessionStart briefing consumes this endpoint now,
 * and deliberately renders NO bodies — its pointer lines carry authors,
 * kinds, statuses and the pair id only (briefing/render.ts
 * formatContradictionLine), because two author-written bodies side by side
 * would anchor the reader on whichever paraphrase reads better. Any consumer
 * that DOES render these bodies must route them through the renderer's PROSE
 * class (« » framing, sanitized) like every other teammate text — the referee
 * brief renderer (connector mcp/render-referee.ts) is the worked example. Do
 * not interpolate these fields into agent-visible text directly.
 */
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { ClaimKind } from "@crosscheck/schema";

import {
  agentSessions,
  claimEdges,
  claims,
  contradictionCandidates,
  developers,
  workContextTargets,
} from "../db/schema.ts";
import {
  DECLARED_PROVENANCE,
  OPEN_THEORY_STATUSES,
} from "./similarity-gate.ts";
import { notMutedCondition } from "./visibility.ts";
import type { Db } from "../db/client.ts";

export const CONTRADICTIONS_DEFAULT_LIMIT = 50;
export const CONTRADICTIONS_MAX_LIMIT = 200;

/** Same-author revision edge (DESIGN.md §5); its TARGET is the retracted claim. */
export const SUPERSEDES_EDGE_KIND = "supersedes";

const CONTRADICTION_ID_PREFIX = "cx_";
/** 128 bits of SHA-256 — the truncation the connector's fingerprints use too. */
const CONTRADICTION_ID_HASH_CHARS = 32;

/**
 * INJECTIVE canonical form of an unordered claim-id pair — the one string
 * both the pair id and the listing's dedup key derive from. Claim ids carry
 * no charset restriction (schema `nonEmptyId`), so a bare-delimiter join is
 * ambiguous: ("x","y:z") and ("x:y","z") would collapse, colliding two real
 * pairs into one id and letting the dedup drop a real deadlock. JSON string
 * escaping makes the boundary unambiguous for every possible id byte.
 */
const canonicalPairKey = (claimAId: string, claimBId: string): string =>
  JSON.stringify([claimAId, claimBId].sort());

/**
 * The pair's id: deterministic, order-independent, and STATELESS — derived
 * pairs have no stored row a foreign key could point at (see the header), so
 * the id has to be recomputable from the pair alone. Resolution reverses it by
 * re-listing candidates and matching (findContradictionById below), which is
 * bounded by the same CONTRADICTIONS_MAX_LIMIT the listing itself obeys.
 *
 * Prefix + 32 hex chars = 35, inside the connector's MAX_ID_CHARS (64) and its
 * id alphabet, so a briefing can print it bare and a tool can accept it back —
 * and ids of colon-carrying claim pairs stay distinct:
 *
 * VERIFY: bun -e 'const m=await import("./packages/server/src/services/contradictions.ts");const a=m.contradictionIdFor("clm_a","clm_b");console.log(a.length, a === m.contradictionIdFor("clm_b","clm_a"), /^cx_[0-9a-f]{32}$/.test(a), m.contradictionIdFor("x","y:z") !== m.contradictionIdFor("x:y","z"))'
 * PRINTS: 35 true true true
 */
export const contradictionIdFor = (
  claimAId: string,
  claimBId: string,
): string => {
  const digest = createHash("sha256")
    .update(canonicalPairKey(claimAId, claimBId))
    .digest("hex");
  return `${CONTRADICTION_ID_PREFIX}${digest.slice(0, CONTRADICTION_ID_HASH_CHARS)}`;
};

/** Kinds that carry a theory; observations and evidence cannot contradict. */
const THEORY_KINDS = [
  "hypothesis",
  "root_cause",
] as const satisfies readonly ClaimKind[];

export interface CandidateSide {
  readonly id: string;
  readonly workContextId: string;
  readonly kind: string;
  readonly status: string;
  readonly body: string;
  /** Trust label (DESIGN.md §4) — the briefing pointer says WHO disagrees. */
  readonly authorDeveloperName: string;
}

export interface ContradictionView {
  /** Deterministic pair id (contradictionIdFor) — the brief's handle. */
  readonly id: string;
  readonly claimA: CandidateSide;
  readonly claimB: CandidateSide;
  readonly reason: "similarity" | "shared_target";
  readonly similarity: number | null;
}

/**
 * A side whose claim was revised away by its own author no longer holds a
 * position: same signal the hints path filters on (hints.ts `notSuperseded`) —
 * a supersedes edge POINTING AT the claim, plus the `superseded` status as
 * defense in depth against a hub that forged the status without the edge.
 * Retired pairs leave the LISTING only; findContradictionById keeps resolving
 * them so a brief can say the deadlock is over instead of vanishing.
 */
const sideIsLive = (
  db: Db,
  side: { readonly id: PgColumn; readonly status: PgColumn },
) =>
  and(
    ne(side.status, "superseded"),
    notExists(
      db
        .select({ one: sql`1` })
        .from(claimEdges)
        .where(
          and(
            eq(claimEdges.toClaimId, side.id),
            eq(claimEdges.kind, SUPERSEDES_EDGE_KIND),
          ),
        ),
    ),
  );

/** "Touches the repo": either side's work context reports from it. */
const repoTouchCondition = (
  repo: string | undefined,
  sideA: { readonly workContextId: unknown },
  sideB: { readonly workContextId: unknown },
) =>
  repo === undefined
    ? undefined
    : sql`(
        EXISTS (SELECT 1 FROM work_contexts wc JOIN agent_sessions s ON s.id = wc.session_id
                WHERE wc.id = ${sideA.workContextId} AND s.repo = ${repo})
        OR EXISTS (SELECT 1 FROM work_contexts wc JOIN agent_sessions s ON s.id = wc.session_id
                WHERE wc.id = ${sideB.workContextId} AND s.repo = ${repo})
      )`;

/**
 * The viewer's mute filter for one pair: a pointer names BOTH authors, so a
 * pair leaves the listing when either side's developer is muted. Undefined
 * (the brief resolver's path) filters nothing — mute is not a boundary.
 */
const bothSidesUnmuted = (
  excludeMutedForDeveloperId: string | undefined,
  sideADeveloperId: PgColumn,
  sideBDeveloperId: PgColumn,
) =>
  excludeMutedForDeveloperId === undefined
    ? undefined
    : and(
        notMutedCondition(excludeMutedForDeveloperId, sideADeveloperId),
        notMutedCondition(excludeMutedForDeveloperId, sideBDeveloperId),
      );

const listStoredCandidates = async (
  db: Db,
  repo: string | undefined,
  limit: number,
  includeRetired: boolean,
  excludeMutedForDeveloperId: string | undefined,
): Promise<readonly ContradictionView[]> => {
  const claimsA = alias(claims, "stored_a");
  const claimsB = alias(claims, "stored_b");
  const sessionsA = alias(agentSessions, "stored_a_ses");
  const sessionsB = alias(agentSessions, "stored_b_ses");
  const developersA = alias(developers, "stored_a_dev");
  const developersB = alias(developers, "stored_b_dev");
  const rows = await db
    .select({
      similarity: contradictionCandidates.similarity,
      aId: claimsA.id,
      aWorkContextId: claimsA.workContextId,
      aKind: claimsA.kind,
      aStatus: claimsA.status,
      aBody: claimsA.body,
      aAuthorName: developersA.name,
      bId: claimsB.id,
      bWorkContextId: claimsB.workContextId,
      bKind: claimsB.kind,
      bStatus: claimsB.status,
      bBody: claimsB.body,
      bAuthorName: developersB.name,
    })
    .from(contradictionCandidates)
    .innerJoin(claimsA, eq(contradictionCandidates.claimAId, claimsA.id))
    .innerJoin(claimsB, eq(contradictionCandidates.claimBId, claimsB.id))
    .innerJoin(sessionsA, eq(claimsA.authorSessionId, sessionsA.id))
    .innerJoin(sessionsB, eq(claimsB.authorSessionId, sessionsB.id))
    .innerJoin(developersA, eq(sessionsA.developerId, developersA.id))
    .innerJoin(developersB, eq(sessionsB.developerId, developersB.id))
    .where(
      and(
        // Derived exclusion, defense in depth: the gate no longer WRITES
        // candidate rows for derived claims (similarity-gate.ts), but rows
        // from before that rule — or from an older hub — are already on
        // disk, and a machine draft must not surface as a held position.
        eq(claimsA.provenance, DECLARED_PROVENANCE),
        eq(claimsB.provenance, DECLARED_PROVENANCE),
        repoTouchCondition(repo, claimsA, claimsB),
        bothSidesUnmuted(
          excludeMutedForDeveloperId,
          sessionsA.developerId,
          sessionsB.developerId,
        ),
        ...(includeRetired
          ? []
          : [sideIsLive(db, claimsA), sideIsLive(db, claimsB)]),
      ),
    )
    .orderBy(sql`${contradictionCandidates.createdAt} DESC`)
    .limit(limit);
  return rows.map((row) => ({
    id: contradictionIdFor(row.aId, row.bId),
    claimA: {
      id: row.aId,
      workContextId: row.aWorkContextId,
      kind: row.aKind,
      status: row.aStatus,
      body: row.aBody,
      authorDeveloperName: row.aAuthorName,
    },
    claimB: {
      id: row.bId,
      workContextId: row.bWorkContextId,
      kind: row.bKind,
      status: row.bStatus,
      body: row.bBody,
      authorDeveloperName: row.bAuthorName,
    },
    reason: "similarity" as const,
    similarity: row.similarity,
  }));
};

const listDerivedCandidates = async (
  db: Db,
  repo: string | undefined,
  limit: number,
  includeRetired: boolean,
  excludeMutedForDeveloperId: string | undefined,
): Promise<readonly ContradictionView[]> => {
  const openSide = alias(claims, "open_side");
  const rejectedSide = alias(claims, "rejected_side");
  const targetsOpen = alias(workContextTargets, "targets_open");
  const targetsRejected = alias(workContextTargets, "targets_rejected");
  const sessionsOpen = alias(agentSessions, "open_ses");
  const sessionsRejected = alias(agentSessions, "rejected_ses");
  const developersOpen = alias(developers, "open_dev");
  const developersRejected = alias(developers, "rejected_dev");

  const rows = await db
    .selectDistinct({
      aId: openSide.id,
      aWorkContextId: openSide.workContextId,
      aKind: openSide.kind,
      aStatus: openSide.status,
      aBody: openSide.body,
      aAuthorName: developersOpen.name,
      // In the select list because SELECT DISTINCT may only ORDER BY selected
      // expressions; functionally dependent on aId, so distinctness is
      // unchanged.
      aCreatedAt: openSide.createdAt,
      bId: rejectedSide.id,
      bWorkContextId: rejectedSide.workContextId,
      bKind: rejectedSide.kind,
      bStatus: rejectedSide.status,
      bBody: rejectedSide.body,
      bAuthorName: developersRejected.name,
    })
    .from(openSide)
    .innerJoin(
      targetsOpen,
      eq(targetsOpen.workContextId, openSide.workContextId),
    )
    .innerJoin(
      targetsRejected,
      and(
        eq(targetsRejected.kind, targetsOpen.kind),
        eq(targetsRejected.value, targetsOpen.value),
        ne(targetsRejected.workContextId, targetsOpen.workContextId),
      ),
    )
    .innerJoin(
      rejectedSide,
      eq(rejectedSide.workContextId, targetsRejected.workContextId),
    )
    .innerJoin(sessionsOpen, eq(openSide.authorSessionId, sessionsOpen.id))
    .innerJoin(
      sessionsRejected,
      eq(rejectedSide.authorSessionId, sessionsRejected.id),
    )
    .innerJoin(
      developersOpen,
      eq(sessionsOpen.developerId, developersOpen.id),
    )
    .innerJoin(
      developersRejected,
      eq(sessionsRejected.developerId, developersRejected.id),
    )
    .where(
      and(
        inArray(openSide.kind, [...THEORY_KINDS]),
        inArray(rejectedSide.kind, [...THEORY_KINDS]),
        inArray(openSide.status, [...OPEN_THEORY_STATUSES]),
        eq(rejectedSide.status, "rejected"),
        // BOTH sides must be vouched for. A derived draft (Tier-1 summarizer,
        // DESIGN.md §3: "never proactively injected") holds no position — an
        // open draft would tell a teammate its author asserts a theory the
        // author never saw, and a derived discard revision was rejected by
        // nobody. Same fail-closed positive equality as the hint path's
        // isDeclared (connector-claude hints/select.ts, === "declared").
        eq(openSide.provenance, DECLARED_PROVENANCE),
        eq(rejectedSide.provenance, DECLARED_PROVENANCE),
        // A deadlock needs two people: one developer's own opposite-status
        // theories are self-revision (the formal channel is a supersedes
        // edge), not a conflict a referee could brief. Stored similarity
        // pairs deliberately keep same-developer hits — similarity-gate.ts
        // flags a developer against their own history — so this condition
        // belongs to the derived join only.
        ne(sessionsOpen.developerId, sessionsRejected.developerId),
        repoTouchCondition(repo, openSide, rejectedSide),
        bothSidesUnmuted(
          excludeMutedForDeveloperId,
          sessionsOpen.developerId,
          sessionsRejected.developerId,
        ),
        ...(includeRetired
          ? []
          : [sideIsLive(db, openSide), sideIsLive(db, rejectedSide)]),
      ),
    )
    // Deterministic under LIMIT, matching the stored source's newest-first:
    // without an ORDER BY, which pairs fit the cap — and therefore which cx_
    // ids stay resolvable, and which pointers a briefing shows — would be
    // query-plan luck that varies per call.
    .orderBy(desc(openSide.createdAt), asc(openSide.id), asc(rejectedSide.id))
    .limit(limit);
  return rows.map((row) => ({
    id: contradictionIdFor(row.aId, row.bId),
    claimA: {
      id: row.aId,
      workContextId: row.aWorkContextId,
      kind: row.aKind,
      status: row.aStatus,
      body: row.aBody,
      authorDeveloperName: row.aAuthorName,
    },
    claimB: {
      id: row.bId,
      workContextId: row.bWorkContextId,
      kind: row.bKind,
      status: row.bStatus,
      body: row.bBody,
      authorDeveloperName: row.bAuthorName,
    },
    reason: "shared_target" as const,
    similarity: null,
  }));
};

const pairKey = (view: ContradictionView): string =>
  canonicalPairKey(view.claimA.id, view.claimB.id);

export interface ListContradictionsInput {
  readonly repo?: string | undefined;
  readonly limit: number;
  /**
   * Keep pairs a supersedes edge (or status) has retired. The LISTING never
   * wants them — a settled deadlock is not an open conflict — but the brief
   * resolver must still find them to say the deadlock is over (referee.ts).
   */
  readonly includeRetired?: boolean;
  /**
   * Drop pairs naming a developer THIS reader muted (visibility.ts). The
   * listing route passes the caller — its rows are briefing pointers, an
   * unasked surface. findContradictionById never passes it: the brief is a
   * deliberate pull by id, and mute is not a boundary.
   */
  readonly excludeMutedForDeveloperId?: string | undefined;
}

export const listContradictions = async (
  db: Db,
  input: ListContradictionsInput,
): Promise<readonly ContradictionView[]> => {
  const limit = Math.min(Math.max(1, input.limit), CONTRADICTIONS_MAX_LIMIT);
  const includeRetired = input.includeRetired === true;
  const [stored, derived] = await Promise.all([
    listStoredCandidates(
      db,
      input.repo,
      limit,
      includeRetired,
      input.excludeMutedForDeveloperId,
    ),
    listDerivedCandidates(
      db,
      input.repo,
      limit,
      includeRetired,
      input.excludeMutedForDeveloperId,
    ),
  ]);
  const seen = new Set<string>();
  const merged: ContradictionView[] = [];
  // Stored first: a pair found both ways reports as "similarity", which
  // carries a measured score.
  for (const candidate of [...stored, ...derived]) {
    const key = pairKey(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(candidate);
    }
  }
  return merged.slice(0, limit);
};

/**
 * Resolves a cx_ id back to its pair by recomputing ids over the candidate
 * pool — the hash is not invertible and derived pairs have no row to look up,
 * so re-listing IS the index. Hub-wide (no repo filter) because the id scopes
 * the call, exactly like get_diagnosis.
 *
 * TWO POOLS, LIVE FIRST. The live pool is the universe every listing draws
 * from, so a pair a listing currently shows always resolves — one shared cap
 * over live AND retired pairs would let retired rows evict a live pair from
 * resolution while the listing still offers its id. The retired-inclusive
 * pool is only consulted after a live miss, so a retired pair's brief can
 * report the retirement instead of 404ing (retirement honesty).
 *
 * Accepted bound: a pair pushed past CONTRADICTIONS_MAX_LIMIT of its own
 * pool by newer candidates becomes unresolvable. The listing that minted the
 * id is bounded the same way, so an id an agent holds came from a pool that
 * contained it.
 */
export const findContradictionById = async (
  db: Db,
  contradictionId: string,
): Promise<ContradictionView | undefined> => {
  const matches = (candidate: ContradictionView): boolean =>
    candidate.id === contradictionId;
  const live = await listContradictions(db, {
    limit: CONTRADICTIONS_MAX_LIMIT,
  });
  const liveMatch = live.find(matches);
  if (liveMatch !== undefined) {
    return liveMatch;
  }
  const withRetired = await listContradictions(db, {
    limit: CONTRADICTIONS_MAX_LIMIT,
    includeRetired: true,
  });
  return withRetired.find(matches);
};
