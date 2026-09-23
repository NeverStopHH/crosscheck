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

import { developers, fenceWaivers, pins } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";

const MS_PER_DAY = 86_400_000;

/**
 * How many waiver rows one listing returns.
 *
 * Bounded like every other listing in this product: the history is
 * append-only, so a repo that waives often grows this table for ever, and an
 * unbounded read would hand a terminal a year of decisions. Newest first, so
 * the bound keeps the rows a reader came for.
 */
const MAX_WAIVERS_LISTED = 50;

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
 * A REVOKE NAMES ITS GRANT, and that relationship — not the clock — is what
 * decides. An earlier version of this read rows newest-first and let the first
 * decision win, which is correct only while `created_at` orders them: a grant
 * and its revocation written in the SAME millisecond sort arbitrarily, and the
 * fence then reads open or closed depending on which row the planner returned
 * first. That is not hypothetical — a test hit it immediately on a fixed
 * clock, and a fast grant-then-revoke would hit it in production.
 *
 * So the superseded ids are collected first and the newest UNSUPERSEDED,
 * unexpired grant wins. Order still decides between two live grants, where any
 * answer is correct because both are open; it no longer decides whether a
 * revocation took effect, where only one answer is.
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

  // Every grant somebody has closed, by id. Read from the rows already in
  // hand rather than a second query.
  const revoked = new Set(
    rows
      .filter((row) => row.kind === "revoke")
      .map((row) => row.supersedes)
      .filter((id): id is string => id !== null),
  );

  for (const row of rows) {
    if (row.kind !== "grant" || revoked.has(row.id)) {
      continue;
    }
    if (row.expiresAt === null) {
      // Unreachable — the shape CHECK makes a grant without an expiry a
      // database impossibility (AT-6). Handled rather than asserted, because
      // the alternative is treating an impossible row as an OPEN fence.
      continue;
    }
    if (row.expiresAt.getTime() <= input.now.getTime()) {
      // EXPIRED. The loop keeps going, so a team who granted, let it lapse and
      // granted again still reads as open.
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

/** One waiver as a reader sees it. */
export interface WaiverView {
  readonly id: string;
  readonly pinId: string;
  readonly pinVersion: number;
  readonly kind: string;
  readonly grantedByName: string;
  readonly reason: string;
  readonly expiresAt: string | null;
  readonly supersedes: string | null;
  readonly createdAt: string;
  /** Derived, never stored: is THIS row the one holding a fence open now. */
  readonly live: boolean;
}

export interface ListWaiversInput {
  readonly db: DbExecutor;
  readonly repo: string;
  readonly pinId: string | null;
  readonly now: Date;
}

/**
 * THE RECORD, newest first — grants, revocations and expired rows alike.
 *
 * NOTHING IS FILTERED OUT. A list that showed only live waivers would answer
 * "is this fence open" and silently drop the question a team actually asks
 * later: who opened it, when, why, and who closed it again. That history is
 * the whole reason the table is append-only, and hiding the dead rows would
 * make the append-only-ness pointless.
 *
 * `live` IS DERIVED PER READ rather than stored, like every other judgement in
 * this product: expiry is a comparison against now, so a stored flag would be
 * wrong the moment it aged.
 *
 * THE GRANTER'S NAME, NOT THEIR ID. Author is a normative trust label, and a
 * reader holding an opaque `dev_<uuid>` has no second endpoint that turns it
 * into a person — the rule the work-context listing already follows.
 */
export const listWaivers = async (
  input: ListWaiversInput,
): Promise<readonly WaiverView[]> => {
  const rows = await input.db
    .select({
      id: fenceWaivers.id,
      pinId: fenceWaivers.pinId,
      pinVersion: fenceWaivers.pinVersion,
      kind: fenceWaivers.kind,
      grantedByName: developers.name,
      reason: fenceWaivers.reason,
      expiresAt: fenceWaivers.expiresAt,
      supersedes: fenceWaivers.supersedes,
      createdAt: fenceWaivers.createdAt,
    })
    .from(fenceWaivers)
    .innerJoin(developers, eq(fenceWaivers.grantedBy, developers.id))
    .where(
      input.pinId === null
        ? eq(fenceWaivers.repo, input.repo)
        : and(
            eq(fenceWaivers.repo, input.repo),
            eq(fenceWaivers.pinId, input.pinId),
          ),
    )
    .orderBy(desc(fenceWaivers.createdAt))
    .limit(MAX_WAIVERS_LISTED);

  // The live row per (pin, version) is the one `readLiveWaiver` would return,
  // asked once per distinct pair rather than once per row.
  const livePairs = new Map<string, string | null>();
  for (const row of rows) {
    const key = `${row.pinId}@${String(row.pinVersion)}`;
    if (!livePairs.has(key)) {
      const current = await readLiveWaiver({
        db: input.db,
        repo: input.repo,
        pinId: row.pinId,
        pinVersion: row.pinVersion,
        now: input.now,
      });
      livePairs.set(key, current?.id ?? null);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    pinId: row.pinId,
    pinVersion: row.pinVersion,
    kind: row.kind,
    grantedByName: row.grantedByName,
    reason: row.reason,
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    supersedes: row.supersedes,
    createdAt: row.createdAt.toISOString(),
    live: livePairs.get(`${row.pinId}@${String(row.pinVersion)}`) === row.id,
  }));
};
