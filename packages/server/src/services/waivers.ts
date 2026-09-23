/**
 * IS THIS FENCE OPEN RIGHT NOW (1.0 spec 04 §3.6).
 *
 * The only thing that turns a `PROTECTED_CONFLICT` into `protected_ok`. A
 * protected conflict says a human-verified invariant is broken; a live waiver
 * says a human decided that is acceptable for now, for a bounded time, with a
 * reason on the record.
 *
 * THREE WAYS TO NOT BE LIVE, and they are different sentences rather than one
 * falsy check:
 *
 *   no grant at all   — nobody ever opened this fence at this version;
 *   expired           — somebody opened it and the time they chose has passed;
 *   revoked           — somebody closed it again, in a row that names the grant
 *                       it supersedes and carries its own reason.
 *
 * All three answer `null` here, because the VERDICT only needs to know whether
 * the fence is open. Which of the three it was belongs on the surfaces that
 * list waivers, where a person can act on the difference.
 *
 * PER VERSION, NOT PER PIN. A waiver granted against version 3 says nothing
 * about version 4: a sweep that moved the watched paths produced a different
 * invariant, and consent does not travel across that boundary. That is the
 * whole reason `pins.version` exists.
 *
 * NOTHING HERE WRITES. Append-only means a revoke is a new row, and expiry is a
 * comparison rather than a state somebody has to sweep — a cron marking waivers
 * dead would be a second authority over one fact, and a hub that missed a run
 * would leave fences open.
 */
import { and, desc, eq } from "drizzle-orm";

import { fenceWaivers } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";

/** What the verdict needs to know about an open fence. */
export interface LiveWaiver {
  readonly id: string;
  readonly pinVersion: number;
  readonly expiresAt: string;
}

export interface LiveWaiverInput {
  readonly db: DbExecutor;
  readonly repo: string;
  readonly pinId: string;
  readonly pinVersion: number;
  readonly now: Date;
}

/**
 * The live waiver for one pin at one version, or null.
 *
 * ONE QUERY, NEWEST FIRST, over the index this table was given
 * (`repo, pin_id, pin_version, created_at DESC`). The rows are read in order
 * and the FIRST decision wins: a revoke newer than a grant closes the fence, a
 * grant newer than a revoke opens it again. Reading them any other way — say,
 * finding a grant and then asking whether it was ever revoked — gets the
 * re-grant case wrong, and the re-grant is the case a team actually hits.
 */
export const readLiveWaiver = async (
  input: LiveWaiverInput,
): Promise<LiveWaiver | null> => {
  const rows = await input.db
    .select({
      id: fenceWaivers.id,
      kind: fenceWaivers.kind,
      pinVersion: fenceWaivers.pinVersion,
      expiresAt: fenceWaivers.expiresAt,
      supersedes: fenceWaivers.supersedes,
    })
    .from(fenceWaivers)
    .where(
      and(
        eq(fenceWaivers.repo, input.repo),
        eq(fenceWaivers.pinId, input.pinId),
        eq(fenceWaivers.pinVersion, input.pinVersion),
      ),
    )
    .orderBy(desc(fenceWaivers.createdAt));

  for (const row of rows) {
    if (row.kind === "revoke") {
      // THE NEWEST DECISION WINS. A revoke closes the fence and the search
      // stops: an older grant underneath it was already taken back.
      return null;
    }
    if (row.expiresAt === null) {
      // Unreachable — the shape CHECK makes a grant without an expiry a
      // database impossibility (AT-6). Handled rather than asserted, because
      // the alternative is treating an impossible row as an OPEN fence.
      continue;
    }
    if (row.expiresAt.getTime() <= input.now.getTime()) {
      // EXPIRED. The loop keeps going rather than returning, so that an older
      // grant is still examined — the shape that matters is a team who granted,
      // let it lapse, and granted again.
      continue;
    }
    return {
      id: row.id,
      pinVersion: row.pinVersion,
      expiresAt: row.expiresAt.toISOString(),
    };
  }
  return null;
};
