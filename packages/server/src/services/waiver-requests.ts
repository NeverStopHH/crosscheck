/**
 * WHAT AN API KEY MAY STILL DO ABOUT A FENCE — ASK — and what a passkey
 * approval turns the asking into (1.0 spec 04a §6).
 *
 * A request opens nothing. It is checked against the same rules a grant
 * would meet (the pin, its repo, its CURRENT version, the expiry and its
 * ceiling) so a request that could never be approved fails while its asker
 * is still there to read why, and it is answered at most once: approved by a
 * passkey, withdrawn by its requester, or lapsed when the expiry it asked for
 * passes. Its status is DERIVED on every read, like a waiver's liveness, so
 * no sweep has to mark anything lapsed.
 *
 * THE CALLER HAS ALREADY VERIFIED THE ASSERTION. Every write below that opens
 * or closes a fence takes the credential id as its proof; the route minted
 * the ceremony over exactly the terms passed here (services/webauthn.ts), so
 * what is stored is what was signed.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, isNull } from "drizzle-orm";

import { MAX_WAIVER_DAYS } from "../constants.ts";
import { developers, fenceWaivers, pins, waiverRequests } from "../db/schema.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import { grantWaiver, readLiveWaiver, revokeWaiver } from "./waivers.ts";
import type { WaiverRefusal } from "./waivers.ts";

const MS_PER_DAY = 86_400_000;

/** Bounded like every listing: newest first, so the bound keeps what a reader came for. */
const MAX_REQUESTS_LISTED = 50;

export type WaiverRequestRefusal =
  | WaiverRefusal
  | "stale_version"
  | "already_requested"
  | "unknown_request"
  | "not_requester"
  | "not_pending"
  | "expiry_beyond_request"
  | "not_live";

export type WaiverRequestStatus = "pending" | "approved" | "withdrawn" | "lapsed";

type RequestRow = typeof waiverRequests.$inferSelect;

const statusOf = (row: RequestRow, now: Date): WaiverRequestStatus => {
  if (row.approvedWaiverId !== null) {
    return "approved";
  }
  if (row.withdrawnAt !== null) {
    return "withdrawn";
  }
  return row.expiresAt.getTime() <= now.getTime() ? "lapsed" : "pending";
};

/**
 * A refusal raised INSIDE a transaction, so everything the transaction wrote
 * is rolled back with it. Returning a refusal from the callback would commit
 * whatever ran before it — a revoke without the grant meant to replace it.
 */
class RefusedInTransaction extends Error {
  constructor(readonly refusal: WaiverRequestRefusal) {
    super(refusal);
  }
}

const inTransaction = async <T>(
  db: Db,
  work: (tx: DbExecutor) => Promise<T>,
): Promise<T | { refusal: WaiverRequestRefusal }> => {
  try {
    return await db.transaction(work);
  } catch (error) {
    if (error instanceof RefusedInTransaction) {
      return { refusal: error.refusal };
    }
    throw error;
  }
};

/** The pin rules a request and an approval share: exists, this repo, this version now. */
const pinRefusal = async (
  db: DbExecutor,
  input: { readonly repo: string; readonly pinId: string; readonly pinVersion: number },
): Promise<WaiverRequestRefusal | null> => {
  const rows = await db
    .select({ repo: pins.repo, version: pins.version })
    .from(pins)
    .where(eq(pins.id, input.pinId))
    .limit(1);
  const pin = rows[0];
  if (pin === undefined) {
    return "unknown_pin";
  }
  if (pin.repo !== input.repo) {
    return "wrong_repo";
  }
  // 04 §3.5: consent does not travel across a sweep. A request — or an
  // approval of one — against a version the pin has moved past would sign
  // off on paths nobody looked at.
  return pin.version === input.pinVersion ? null : "stale_version";
};

const expiryRefusal = (expiresAt: Date, now: Date): WaiverRequestRefusal | null => {
  if (expiresAt.getTime() <= now.getTime()) {
    return "expiry_in_the_past";
  }
  return expiresAt.getTime() > now.getTime() + MAX_WAIVER_DAYS * MS_PER_DAY
    ? "expiry_beyond_ceiling"
    : null;
};

export const requestWaiver = async (input: {
  readonly db: DbExecutor;
  readonly repo: string;
  readonly pinId: string;
  readonly pinVersion: number;
  readonly requestedBy: string;
  readonly reason: string;
  readonly expiresAt: Date;
  readonly now: Date;
}): Promise<{ id: string } | { refusal: WaiverRequestRefusal }> => {
  const refusal =
    (await pinRefusal(input.db, input)) ?? expiryRefusal(input.expiresAt, input.now);
  if (refusal !== null) {
    return { refusal };
  }
  // ONE OPEN QUESTION PER FENCE. Two pending requests would be two prompts
  // for one decision, and the second approval would silently supersede the
  // first person's choice of expiry.
  const pending = await input.db
    .select({ id: waiverRequests.id })
    .from(waiverRequests)
    .where(
      and(
        eq(waiverRequests.repo, input.repo),
        eq(waiverRequests.pinId, input.pinId),
        eq(waiverRequests.pinVersion, input.pinVersion),
        isNull(waiverRequests.withdrawnAt),
        isNull(waiverRequests.approvedWaiverId),
        gt(waiverRequests.expiresAt, input.now),
      ),
    )
    .limit(1);
  if (pending[0] !== undefined) {
    return { refusal: "already_requested" };
  }
  const id = `wr_${randomUUID()}`;
  await input.db.insert(waiverRequests).values({
    id,
    repo: input.repo,
    pinId: input.pinId,
    pinVersion: input.pinVersion,
    requestedBy: input.requestedBy,
    reason: input.reason,
    expiresAt: input.expiresAt,
    createdAt: input.now,
    withdrawnAt: null,
    approvedWaiverId: null,
  });
  return { id };
};

const readRequest = async (db: DbExecutor, requestId: string): Promise<RequestRow | undefined> =>
  (await db.select().from(waiverRequests).where(eq(waiverRequests.id, requestId)).limit(1))[0];

/** Only its requester takes a request back, and only while it is pending. */
export const withdrawRequest = async (input: {
  readonly db: DbExecutor;
  readonly requestId: string;
  readonly developerId: string;
  readonly now: Date;
}): Promise<{ withdrawn: true } | { refusal: WaiverRequestRefusal }> => {
  const row = await readRequest(input.db, input.requestId);
  if (row === undefined) {
    return { refusal: "unknown_request" };
  }
  if (row.requestedBy !== input.developerId) {
    return { refusal: "not_requester" };
  }
  if (statusOf(row, input.now) !== "pending") {
    return { refusal: "not_pending" };
  }
  await input.db
    .update(waiverRequests)
    .set({ withdrawnAt: input.now })
    .where(
      and(
        eq(waiverRequests.id, input.requestId),
        isNull(waiverRequests.withdrawnAt),
        isNull(waiverRequests.approvedWaiverId),
      ),
    );
  return { withdrawn: true };
};

/** The pending request a ceremony will sign over, or why there is none. */
export const readPendingRequest = async (input: {
  readonly db: DbExecutor;
  readonly requestId: string;
  readonly now: Date;
}): Promise<RequestRow | { refusal: WaiverRequestRefusal }> => {
  const row = await readRequest(input.db, input.requestId);
  if (row === undefined) {
    return { refusal: "unknown_request" };
  }
  return statusOf(row, input.now) === "pending" ? row : { refusal: "not_pending" };
};

/**
 * TURN A REQUEST INTO A GRANT, with the terms the approver signed.
 *
 * The approver may SHORTEN the expiry and edit the reason; lengthening the
 * expiry is refused, because the requester asked for that much and no more,
 * and an approval that granted more than was asked would be a second request
 * nobody made. Request and grant are written together or not at all.
 */
export const approveRequest = async (input: {
  readonly db: Db;
  readonly requestId: string;
  readonly approverId: string;
  readonly credentialId: string;
  readonly expiresAt: Date;
  readonly reason: string;
  readonly now: Date;
}): Promise<{ waiverId: string } | { refusal: WaiverRequestRefusal }> =>
  inTransaction(input.db, async (tx) => {
    const request = await readPendingRequest({ db: tx, requestId: input.requestId, now: input.now });
    if ("refusal" in request) {
      throw new RefusedInTransaction(request.refusal);
    }
    const refusal = await pinRefusal(tx, request);
    if (refusal !== null) {
      throw new RefusedInTransaction(refusal);
    }
    if (input.expiresAt.getTime() > request.expiresAt.getTime()) {
      throw new RefusedInTransaction("expiry_beyond_request");
    }
    const granted = await grantWaiver({
      db: tx,
      repo: request.repo,
      pinId: request.pinId,
      pinVersion: request.pinVersion,
      grantedBy: input.approverId,
      reason: input.reason,
      expiresAt: input.expiresAt,
      now: input.now,
      credentialId: input.credentialId,
      requestId: request.id,
    });
    if ("refusal" in granted) {
      throw new RefusedInTransaction(granted.refusal);
    }
    await tx
      .update(waiverRequests)
      .set({ approvedWaiverId: granted.id })
      .where(eq(waiverRequests.id, request.id));
    return { waiverId: granted.id };
  });

/**
 * CHANGE A LIVE WAIVER'S TERMS: a revoke of the old grant and a new grant,
 * from one ceremony, in one transaction — so the fence is never closed by an
 * amendment whose new terms were refused.
 */
export const amendWaiver = async (input: {
  readonly db: Db;
  readonly repo: string;
  readonly waiverId: string;
  readonly approverId: string;
  readonly credentialId: string;
  readonly expiresAt: Date;
  readonly reason: string;
  readonly now: Date;
}): Promise<{ waiverId: string } | { refusal: WaiverRequestRefusal }> =>
  inTransaction(input.db, async (tx) => {
    const rows = await tx
      .select({ pinId: fenceWaivers.pinId, pinVersion: fenceWaivers.pinVersion })
      .from(fenceWaivers)
      .where(and(eq(fenceWaivers.id, input.waiverId), eq(fenceWaivers.repo, input.repo)))
      .limit(1);
    const target = rows[0];
    if (target === undefined) {
      throw new RefusedInTransaction("unknown_waiver");
    }
    const live = await readLiveWaiver({ db: tx, repo: input.repo, ...target, now: input.now });
    if (live?.id !== input.waiverId) {
      throw new RefusedInTransaction("not_live");
    }
    const refusal = await pinRefusal(tx, { repo: input.repo, ...target });
    if (refusal !== null) {
      throw new RefusedInTransaction(refusal);
    }
    const revoked = await revokeWaiver({
      db: tx,
      repo: input.repo,
      waiverId: input.waiverId,
      grantedBy: input.approverId,
      reason: input.reason,
      now: input.now,
      credentialId: input.credentialId,
    });
    if ("refusal" in revoked) {
      throw new RefusedInTransaction(revoked.refusal);
    }
    const granted = await grantWaiver({
      db: tx,
      repo: input.repo,
      ...target,
      grantedBy: input.approverId,
      reason: input.reason,
      expiresAt: input.expiresAt,
      now: input.now,
      credentialId: input.credentialId,
      requestId: null,
    });
    if ("refusal" in granted) {
      throw new RefusedInTransaction(granted.refusal);
    }
    return { waiverId: granted.id };
  });

/** One request as a reader sees it — /ui/waivers and `crosscheck pin list`. */
export interface WaiverRequestView {
  readonly id: string;
  readonly repo: string;
  readonly pinId: string;
  readonly pinVersion: number;
  readonly surface: string;
  readonly requestedByName: string;
  readonly reason: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly status: WaiverRequestStatus;
}

/** Newest first; `repo: null` lists the whole hub, which is what the approval page shows. */
export const listRequests = async (input: {
  readonly db: DbExecutor;
  readonly repo: string | null;
  readonly now: Date;
}): Promise<readonly WaiverRequestView[]> => {
  const rows = await input.db
    .select({ request: waiverRequests, surface: pins.surface, requestedByName: developers.name })
    .from(waiverRequests)
    .innerJoin(pins, eq(waiverRequests.pinId, pins.id))
    .innerJoin(developers, eq(waiverRequests.requestedBy, developers.id))
    .where(input.repo === null ? undefined : eq(waiverRequests.repo, input.repo))
    .orderBy(desc(waiverRequests.createdAt))
    .limit(MAX_REQUESTS_LISTED);
  return rows.map(({ request, surface, requestedByName }) => ({
    id: request.id,
    repo: request.repo,
    pinId: request.pinId,
    pinVersion: request.pinVersion,
    surface,
    requestedByName,
    reason: request.reason,
    expiresAt: request.expiresAt.toISOString(),
    createdAt: request.createdAt.toISOString(),
    status: statusOf(request, input.now),
  }));
};
