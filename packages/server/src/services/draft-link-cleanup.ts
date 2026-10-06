/**
 * THE LINKS AN OLDER GATE MADE INTO TEAMMATES' TREES ON A DRAFT'S STRENGTH
 * (review round 3, MEDIUM-4).
 *
 * The similarity gate no longer links a derived claim (an unreviewed draft,
 * or the rejected copy a discard appends) to another developer's claim, nor
 * a declared claim to a teammate's derived one (similarity-gate.ts
 * reachableNeighbour). A hub that ran the older gate kept every such edge,
 * so a teammate's get_diagnosis still lists a machine guess as related —
 * the push the draft promise forbids.
 *
 * This deletes EXACTLY those edges: relates_to, noted AUTO_SIMILARITY_NOTE
 * (the gate wrote them; a person's own relates_to edge is theirs and stays),
 * between claims of two different developers, with a non-declared end. A
 * link between one developer's own claims stays, as the gate still makes it.
 * Idempotent — a second run finds nothing — and run in the background after
 * the hub is serving (index.ts), beside the doc upgrade.
 */
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../db/client.ts";
import { agentSessions, claimEdges, claims } from "../db/schema.ts";
import { AUTO_SIMILARITY_NOTE, DECLARED_PROVENANCE } from "./similarity-gate.ts";

const RELATES_TO = "relates_to";

/** Deletes the cross-developer auto links with a derived end; returns how many. */
export const removeCrossDeveloperDraftLinks = async (db: Db): Promise<number> => {
  const fromClaim = alias(claims, "link_from_claim");
  const toClaim = alias(claims, "link_to_claim");
  const fromSession = alias(agentSessions, "link_from_session");
  const toSession = alias(agentSessions, "link_to_session");
  const offending = db
    .select({ id: claimEdges.id })
    .from(claimEdges)
    .innerJoin(fromClaim, eq(fromClaim.id, claimEdges.fromClaimId))
    .innerJoin(toClaim, eq(toClaim.id, claimEdges.toClaimId))
    .innerJoin(fromSession, eq(fromSession.id, fromClaim.authorSessionId))
    .innerJoin(toSession, eq(toSession.id, toClaim.authorSessionId))
    .where(
      and(
        eq(claimEdges.kind, RELATES_TO),
        eq(claimEdges.note, AUTO_SIMILARITY_NOTE),
        ne(fromSession.developerId, toSession.developerId),
        or(ne(fromClaim.provenance, DECLARED_PROVENANCE), ne(toClaim.provenance, DECLARED_PROVENANCE)),
      ),
    );
  const removed = await db.delete(claimEdges).where(inArray(claimEdges.id, offending)).returning({ id: claimEdges.id });
  return removed.length;
};
