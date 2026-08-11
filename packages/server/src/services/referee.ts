/**
 * Referee mode (VISION.md §4): the structured case file over one contradiction
 * pair, for a human to act on in thirty seconds.
 *
 * THE HUB PICKS NO WINNER, STRUCTURALLY. Both positions are assembled by the
 * same function over the same queries with the same caps, so there is no code
 * path that could favour a side. Everything here is a deterministic read over
 * data the system already collects: the pair (contradictions.ts), each claim's
 * evidenceRefs jsonb and supports edges (DESIGN.md §5), rejected_approach
 * claims, work_context_targets, and supersedes edges.
 *
 * NO LLM ANYWHERE. VISION.md §4 also names "the one test that would separate
 * them" — that line requires a model and is deliberately OUT of this module's
 * scope; the brief carries the facts a human (or an LLM the reader chooses to
 * run) would need to write it.
 *
 * THE TIMELINE IS NOT A WIRE FIELD. Every claim in the brief carries its
 * author and createdAt, so "who asserted what when" is a deterministic merge
 * the renderer performs — a second copy of those facts on the wire would be a
 * second thing able to disagree with the first.
 *
 * EVERY READ IS BOUNDED: claim loads by inArray over capped id lists, list
 * queries carry LIMIT cap+1 so truncation is detected rather than silent, and
 * the evidence walk is depth-capped (REFEREE_EVIDENCE_WALK_DEPTH) and
 * count-capped (REFEREE_MAX_EVIDENCE_PER_SIDE) — at most two edge queries and
 * two claim loads per side, whatever the graph looks like, because the walk's
 * loop body awaits exactly two reads (one edge query, one claim load) and the
 * depth cap bounds its iterations at 2:
 *
 * VERIFY: bun -e 'const src=await Bun.file("packages/server/src/services/referee.ts").text();const body=src.split("const walk"+"Evidence")[1].split("\n};")[0];console.log((body.match(/await /g)??[]).length,(await import("./packages/server/src/services/referee.ts")).REFEREE_EVIDENCE_WALK_DEPTH)'
 * PRINTS: 2 2
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  agentSessions,
  claimEdges,
  claims,
  developers,
  workContextTargets,
  workContexts,
} from "../db/schema.ts";
import {
  SUPERSEDES_EDGE_KIND,
  findContradictionById,
} from "./contradictions.ts";
import type { CandidateSide, ContradictionView } from "./contradictions.ts";
import type { Db } from "../db/client.ts";

/** Evidence claims one position may cite in a brief; excess sets the flag. */
export const REFEREE_MAX_EVIDENCE_PER_SIDE = 10;

/** rejected_approach claims one position may list; excess sets the flag. */
export const REFEREE_MAX_RULED_OUT_PER_SIDE = 10;

/** Targets the shared-ground section may list; excess sets the flag. */
export const REFEREE_MAX_SHARED_TARGETS = 20;

/**
 * How many supports-hops from the position claim the evidence walk follows:
 * the cited evidence (1) and what supports that evidence (2). Deeper chains
 * are reachable through get_diagnosis; a brief is a summary, not the tree.
 */
export const REFEREE_EVIDENCE_WALK_DEPTH = 2;

const SUPPORTS_EDGE_KIND = "supports";
const REJECTED_APPROACH_KIND = "rejected_approach";

export interface RefereeClaimView {
  readonly id: string;
  readonly workContextId: string;
  readonly kind: string;
  readonly status: string;
  readonly confidence: number;
  readonly body: string;
  /** Trust label (DESIGN.md §4): a derived draft must not read as vouched. */
  readonly provenance: string;
  readonly authorDeveloperId: string;
  readonly authorDeveloperName: string;
  readonly createdAt: string;
}

export interface RefereePositionView {
  readonly claim: RefereeClaimView;
  readonly workContextTitle: string;
  readonly evidence: readonly RefereeClaimView[];
  readonly evidenceTruncated: boolean;
  readonly ruledOut: readonly RefereeClaimView[];
  readonly ruledOutTruncated: boolean;
  /** Retirement honesty: the revision that retracted this position, if any. */
  readonly supersededByClaimId: string | null;
}

export interface SharedTargetView {
  readonly kind: string;
  readonly value: string;
}

export interface RefereeBriefView {
  readonly id: string;
  readonly reason: "similarity" | "shared_target";
  readonly similarity: number | null;
  readonly positionA: RefereePositionView;
  readonly positionB: RefereePositionView;
  readonly sharedTargets: readonly SharedTargetView[];
  readonly sharedTargetsTruncated: boolean;
}

/** A claim row joined to the developer behind its author session. */
interface LoadedClaim {
  readonly view: RefereeClaimView;
  readonly evidenceRefs: readonly string[];
}

const loadClaims = async (
  db: Db,
  ids: readonly string[],
): Promise<readonly LoadedClaim[]> => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      claim: claims,
      authorDeveloperId: agentSessions.developerId,
      authorDeveloperName: developers.name,
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(inArray(claims.id, [...ids]))
    .limit(ids.length);
  return rows.map((row) => ({
    view: {
      id: row.claim.id,
      workContextId: row.claim.workContextId,
      kind: row.claim.kind,
      status: row.claim.status,
      confidence: row.claim.confidence,
      body: row.claim.body,
      provenance: row.claim.provenance,
      authorDeveloperId: row.authorDeveloperId,
      authorDeveloperName: row.authorDeveloperName,
      createdAt: row.claim.createdAt.toISOString(),
    },
    evidenceRefs: row.claim.evidenceRefs,
  }));
};

/** Stable order for evidence within one depth: oldest first, then id. */
const byCreatedAtThenId = (left: LoadedClaim, right: LoadedClaim): number => {
  const byTime = left.view.createdAt.localeCompare(right.view.createdAt);
  return byTime !== 0 ? byTime : left.view.id.localeCompare(right.view.id);
};

interface EvidenceResult {
  readonly evidence: readonly RefereeClaimView[];
  readonly truncated: boolean;
}

/**
 * The evidence one position cites: claims named in its evidenceRefs UNION
 * claims with a supports edge into it, then one more hop of the same for what
 * was found — depth-capped, count-capped, cycle-safe (the seen set).
 */
const walkEvidence = async (
  db: Db,
  root: LoadedClaim,
  excludeIds: readonly string[],
): Promise<EvidenceResult> => {
  const seen = new Set<string>([root.view.id, ...excludeIds]);
  const collected: LoadedClaim[] = [];
  let truncated = false;
  let frontier: readonly LoadedClaim[] = [root];

  for (let depth = 0; depth < REFEREE_EVIDENCE_WALK_DEPTH; depth += 1) {
    const room = REFEREE_MAX_EVIDENCE_PER_SIDE - collected.length;
    if (frontier.length === 0 || room <= 0) {
      break;
    }
    const frontierIds = frontier.map((entry) => entry.view.id);
    const supporterRows = await db
      .select({ fromClaimId: claimEdges.fromClaimId })
      .from(claimEdges)
      .where(
        and(
          inArray(claimEdges.toClaimId, frontierIds),
          eq(claimEdges.kind, SUPPORTS_EDGE_KIND),
        ),
      )
      .limit(REFEREE_MAX_EVIDENCE_PER_SIDE + 1);
    const candidateIds = [
      ...new Set([
        ...frontier.flatMap((entry) => entry.evidenceRefs),
        ...supporterRows.map((row) => row.fromClaimId),
      ]),
    ].filter((id) => !seen.has(id));
    // Truncation is decided on the CANDIDATE count, never on what resolved:
    // refs may name claims that never arrived on this hub (DESIGN.md §5 —
    // they can land later in the same spool flush), and a dead ref inside the
    // bounded room+1 load window would otherwise spend the slot that proves
    // overflow — reporting the case file whole while a live cited claim past
    // the window was dropped. The load itself stays bounded at room+1 ids;
    // the flag says the list MAY be incomplete, which is exactly the truth.
    if (candidateIds.length > room) {
      truncated = true;
    }
    const loaded = [
      ...(await loadClaims(db, candidateIds.slice(0, room + 1))),
    ].sort(byCreatedAtThenId);
    const kept = loaded.slice(0, room);
    for (const entry of kept) {
      seen.add(entry.view.id);
      collected.push(entry);
    }
    frontier = kept;
  }
  return { evidence: collected.map((entry) => entry.view), truncated };
};

interface RuledOutResult {
  readonly ruledOut: readonly RefereeClaimView[];
  readonly truncated: boolean;
}

/**
 * What this position's AUTHOR ruled out in this position's work context.
 * Scoped to the author's developer, not just the context: anybody may add
 * claims to a teammate's context (extend_diagnosis), and a brief that billed
 * Robin's rejections to Nick would misattribute — the one failure a case file
 * about a disagreement cannot afford.
 */
const listRuledOut = async (
  db: Db,
  workContextId: string,
  authorDeveloperId: string,
): Promise<RuledOutResult> => {
  const rows = await db
    .select({
      claim: claims,
      authorDeveloperId: agentSessions.developerId,
      authorDeveloperName: developers.name,
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(
      and(
        eq(claims.workContextId, workContextId),
        eq(claims.kind, REJECTED_APPROACH_KIND),
        eq(agentSessions.developerId, authorDeveloperId),
      ),
    )
    .orderBy(desc(claims.createdAt))
    .limit(REFEREE_MAX_RULED_OUT_PER_SIDE + 1);
  const truncated = rows.length > REFEREE_MAX_RULED_OUT_PER_SIDE;
  return {
    ruledOut: rows.slice(0, REFEREE_MAX_RULED_OUT_PER_SIDE).map((row) => ({
      id: row.claim.id,
      workContextId: row.claim.workContextId,
      kind: row.claim.kind,
      status: row.claim.status,
      confidence: row.claim.confidence,
      body: row.claim.body,
      provenance: row.claim.provenance,
      authorDeveloperId: row.authorDeveloperId,
      authorDeveloperName: row.authorDeveloperName,
      createdAt: row.claim.createdAt.toISOString(),
    })),
    truncated,
  };
};

interface SharedTargetsResult {
  readonly sharedTargets: readonly SharedTargetView[];
  readonly truncated: boolean;
}

/**
 * Targets BOTH work contexts declare — the ground the two sides share.
 * A similarity-detected pair can hold both sides in ONE context (the gate
 * flags a developer against their own history); the self-join would then
 * present every target of that context as jointly-held "shared ground",
 * so a same-context pair reports none — there is no second context to
 * share anything with.
 */
const listSharedTargets = async (
  db: Db,
  workContextIdA: string,
  workContextIdB: string,
): Promise<SharedTargetsResult> => {
  if (workContextIdA === workContextIdB) {
    return { sharedTargets: [], truncated: false };
  }
  const targetsA = alias(workContextTargets, "referee_targets_a");
  const targetsB = alias(workContextTargets, "referee_targets_b");
  const rows = await db
    .selectDistinct({ kind: targetsA.kind, value: targetsA.value })
    .from(targetsA)
    .innerJoin(
      targetsB,
      and(eq(targetsB.kind, targetsA.kind), eq(targetsB.value, targetsA.value)),
    )
    .where(
      and(
        eq(targetsA.workContextId, workContextIdA),
        eq(targetsB.workContextId, workContextIdB),
      ),
    )
    .orderBy(targetsA.kind, targetsA.value)
    .limit(REFEREE_MAX_SHARED_TARGETS + 1);
  return {
    sharedTargets: rows.slice(0, REFEREE_MAX_SHARED_TARGETS),
    truncated: rows.length > REFEREE_MAX_SHARED_TARGETS,
  };
};

/** The revision edge pointing at this claim, newest first, or null. */
const findSupersededBy = async (
  db: Db,
  claimId: string,
): Promise<string | null> => {
  const rows = await db
    .select({ fromClaimId: claimEdges.fromClaimId })
    .from(claimEdges)
    .where(
      and(
        eq(claimEdges.toClaimId, claimId),
        eq(claimEdges.kind, SUPERSEDES_EDGE_KIND),
      ),
    )
    .orderBy(desc(claimEdges.createdAt))
    .limit(1);
  return rows[0]?.fromClaimId ?? null;
};

/**
 * ONE function builds BOTH positions — the symmetry is structural, not a
 * convention: same queries, same caps, same field set, whichever side it is
 * handed. The claim row is reloaded rather than trusting the listing's echo,
 * because the position needs the author id and timestamp the listing does
 * not ship.
 */
const buildPosition = async (
  db: Db,
  side: CandidateSide,
  otherClaimId: string,
  workContextTitles: ReadonlyMap<string, string>,
): Promise<RefereePositionView | undefined> => {
  const [loaded] = await loadClaims(db, [side.id]);
  if (loaded === undefined) {
    return undefined;
  }
  const [evidence, ruledOut, supersededByClaimId] = await Promise.all([
    walkEvidence(db, loaded, [otherClaimId]),
    listRuledOut(db, loaded.view.workContextId, loaded.view.authorDeveloperId),
    findSupersededBy(db, side.id),
  ]);
  return {
    claim: loaded.view,
    workContextTitle: workContextTitles.get(loaded.view.workContextId) ?? "",
    evidence: evidence.evidence,
    evidenceTruncated: evidence.truncated,
    ruledOut: ruledOut.ruledOut,
    ruledOutTruncated: ruledOut.truncated,
    supersededByClaimId,
  };
};

const loadWorkContextTitles = async (
  db: Db,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const unique = [...new Set(ids)];
  const rows = await db
    .select({ id: workContexts.id, title: workContexts.title })
    .from(workContexts)
    .where(inArray(workContexts.id, unique))
    .limit(unique.length);
  return new Map(rows.map((row) => [row.id, row.title]));
};

/**
 * The case file for one contradiction id, or undefined when the id resolves
 * to nothing this hub can see (findContradictionById states the bound).
 */
export const getRefereeBrief = async (
  db: Db,
  contradictionId: string,
): Promise<RefereeBriefView | undefined> => {
  const pair: ContradictionView | undefined = await findContradictionById(
    db,
    contradictionId,
  );
  if (pair === undefined) {
    return undefined;
  }
  const titles = await loadWorkContextTitles(db, [
    pair.claimA.workContextId,
    pair.claimB.workContextId,
  ]);
  const [positionA, positionB, shared] = await Promise.all([
    buildPosition(db, pair.claimA, pair.claimB.id, titles),
    buildPosition(db, pair.claimB, pair.claimA.id, titles),
    listSharedTargets(db, pair.claimA.workContextId, pair.claimB.workContextId),
  ]);
  if (positionA === undefined || positionB === undefined) {
    return undefined;
  }
  return {
    id: pair.id,
    reason: pair.reason,
    similarity: pair.similarity,
    positionA,
    positionB,
    sharedTargets: shared.sharedTargets,
    sharedTargetsTruncated: shared.truncated,
  };
};
