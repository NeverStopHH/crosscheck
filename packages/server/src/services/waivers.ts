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
import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import { MAX_WAIVER_DAYS } from "../constants.ts";

import { fenceWaivers, pins } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";

const MS_PER_DAY = 86_400_000;

/**
 * What the hub stamps on a waiver, always. Never taken from a body: here that
 * assertion would be the permission itself.
 */
const HUMAN_CAPTURE_MODE = "human" as const;

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

/** Why a write was refused — an enum, so a route never invents prose. */
export type WaiverRefusal =
  | "unknown_pin"
  | "wrong_repo"
  | "expiry_in_the_past"
  | "expiry_beyond_ceiling"
  | "unknown_waiver"
  | "not_a_grant"
  | "already_revoked";

export interface GrantInput {
  readonly db: DbExecutor;
  readonly repo: string;
  readonly pinId: string;
  readonly pinVersion: number;
  readonly grantedBy: string;
  readonly reason: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

/**
 * OPEN A FENCE, for a bounded time, with a reason on the record.
 *
 * THE EXPIRY IS SENDER-SUPPLIED AND THEREFORE CLAMPED. Every sender-controlled
 * timestamp in this product is a ratchet waiting to happen — `commit-evidence`
 * learned it the hard way — and here the ratchet is the worst kind: a date far
 * enough in the future is a PERMANENT permission wearing an expiry, and nothing
 * would ever look at it again.
 *
 * Two refusals rather than a silent clamp, because the two mean different
 * things to the person typing: a date in the past is a mistake (they meant to
 * open it, and it would be closed on arrival), and a date beyond the ceiling is
 * a request the product will not grant. Silently shortening the second would
 * tell somebody they had fourteen days when they asked for ninety, and they
 * would find out when the fence closed.
 *
 * NOTHING HERE UPDATES. A grant is a row; changing one's mind is a revoke plus
 * a new grant, and both leave a record.
 */
export const grantWaiver = async (
  input: GrantInput,
): Promise<{ id: string } | { refusal: WaiverRefusal }> => {
  const pin = await input.db
    .select({ repo: pins.repo })
    .from(pins)
    .where(eq(pins.id, input.pinId))
    .limit(1);
  if (pin[0] === undefined) {
    return { refusal: "unknown_pin" };
  }
  if (pin[0].repo !== input.repo) {
    // A waiver names ONE behaviour in ONE repo. Granting across that boundary
    // would let a key with access to one repo open a fence in another.
    return { refusal: "wrong_repo" };
  }
  if (input.expiresAt.getTime() <= input.now.getTime()) {
    return { refusal: "expiry_in_the_past" };
  }
  const ceiling = input.now.getTime() + MAX_WAIVER_DAYS * MS_PER_DAY;
  if (input.expiresAt.getTime() > ceiling) {
    return { refusal: "expiry_beyond_ceiling" };
  }
  const id = `fw_${randomUUID()}`;
  await input.db.insert(fenceWaivers).values({
    id,
    repo: input.repo,
    pinId: input.pinId,
    pinVersion: input.pinVersion,
    kind: "grant",
    grantedBy: input.grantedBy,
    // HUB-STAMPED. The body said what it OBSERVED; only the hub says what that
    // observation is worth.
    captureMode: HUMAN_CAPTURE_MODE,
    reason: input.reason,
    expiresAt: input.expiresAt,
    supersedes: null,
    createdAt: input.now,
  });
  return { id };
};

export interface RevokeInput {
  readonly db: DbExecutor;
  readonly repo: string;
  readonly waiverId: string;
  readonly grantedBy: string;
  readonly reason: string;
  readonly now: Date;
}

/**
 * CLOSE A FENCE AGAIN — as a new row naming the grant it supersedes.
 *
 * `already_revoked` is refused rather than accepted as a no-op: two revocations
 * of one grant would leave a team unable to tell which closure was the real
 * one, and a second row with a second reason reads as a second decision about
 * something that was already decided.
 */
export const revokeWaiver = async (
  input: RevokeInput,
): Promise<{ id: string } | { refusal: WaiverRefusal }> => {
  const rows = await input.db
    .select({
      id: fenceWaivers.id,
      repo: fenceWaivers.repo,
      pinId: fenceWaivers.pinId,
      pinVersion: fenceWaivers.pinVersion,
      kind: fenceWaivers.kind,
    })
    .from(fenceWaivers)
    .where(eq(fenceWaivers.id, input.waiverId))
    .limit(1);
  const target = rows[0];
  if (target === undefined || target.repo !== input.repo) {
    // One refusal for both, deliberately: telling a caller that a waiver
    // exists in a repo they cannot see is itself a disclosure.
    return { refusal: "unknown_waiver" };
  }
  if (target.kind !== "grant") {
    return { refusal: "not_a_grant" };
  }
  const existing = await input.db
    .select({ id: fenceWaivers.id })
    .from(fenceWaivers)
    .where(
      and(
        eq(fenceWaivers.repo, input.repo),
        eq(fenceWaivers.supersedes, target.id),
      ),
    )
    .limit(1);
  if (existing[0] !== undefined) {
    return { refusal: "already_revoked" };
  }
  const id = `fw_${randomUUID()}`;
  await input.db.insert(fenceWaivers).values({
    id,
    repo: input.repo,
    pinId: target.pinId,
    pinVersion: target.pinVersion,
    kind: "revoke",
    grantedBy: input.grantedBy,
    captureMode: HUMAN_CAPTURE_MODE,
    reason: input.reason,
    expiresAt: null,
    supersedes: target.id,
    createdAt: input.now,
  });
  return { id };
};
