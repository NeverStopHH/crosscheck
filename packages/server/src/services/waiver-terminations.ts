/**
 * REVOKING A PASSKEY CLOSES THE FENCES IT OPENED (1.0 spec 04a D-PK-1,
 * decided by Nick 2026-10-02).
 *
 * A grant names the credential whose assertion authorised it. Once that
 * credential is revoked, "a person approved this with that device" is a
 * statement about a device nobody vouches for any more, so every grant it
 * signed that still holds a fence open stops holding it — on every revocation
 * path (the owner in the cool-off, another passkey's ceremony, the admin),
 * because `revokePasskey` is the one writer of a revocation and calls this
 * inside its own transaction.
 *
 * APPEND-ONLY, like every waiver row: the grant is never deleted or edited.
 * Each closure is a NEW `revoke` row superseding it, written by the hub
 * itself — authority `system`, reason `authorizing_credential_revoked`, the
 * revoked credential named, no person (`granted_by` null). The authority
 * CHECK makes that shape the only one a `system` row may have.
 *
 * LIVE means what `pickLiveWaiver` means: a grant nobody has superseded whose
 * expiry is still ahead. An expired grant holds nothing open and gets no row;
 * a grant a person already closed keeps that one closure. Every version is
 * covered, not only a pin's current one: a grant on an old version opens
 * nothing today, and closing it too leaves no grant of a revoked credential
 * standing anywhere.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { AUTHORIZING_CREDENTIAL_REVOKED, SYSTEM_WAIVER_AUTHORITY } from "@crosscheck/schema";

import { fenceWaivers, pins } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";
import { readLiveWaiver } from "./waivers.ts";
import type { LiveWaiver, LiveWaiverInput, LiveWaiversInput } from "./waivers.ts";

/**
 * What a closure's `capture_mode` records: the hub wrote it on its own, from
 * a revocation, and no person or agent typed it.
 */
const HUB_CAPTURE_MODE = "auto" as const;

interface OpenGrant {
  readonly id: string;
  readonly repo: string;
  readonly pinId: string;
  readonly pinVersion: number;
}

/** Every unexpired grant `credentialId` signed that no revoke row supersedes. */
const openGrantsSignedBy = async (
  db: DbExecutor,
  credentialId: string,
  now: Date,
): Promise<readonly OpenGrant[]> => {
  const signed = await db
    .select({
      id: fenceWaivers.id,
      repo: fenceWaivers.repo,
      pinId: fenceWaivers.pinId,
      pinVersion: fenceWaivers.pinVersion,
    })
    .from(fenceWaivers)
    .where(
      and(
        eq(fenceWaivers.kind, "grant"),
        eq(fenceWaivers.credentialId, credentialId),
        gt(fenceWaivers.expiresAt, now),
      ),
    );
  if (signed.length === 0) {
    return [];
  }
  const closed = await db
    .select({ supersedes: fenceWaivers.supersedes })
    .from(fenceWaivers)
    .where(
      and(
        eq(fenceWaivers.kind, "revoke"),
        inArray(
          fenceWaivers.supersedes,
          signed.map((grant) => grant.id),
        ),
      ),
    );
  const closedIds = new Set(closed.map((row) => row.supersedes));
  return signed.filter((grant) => !closedIds.has(grant.id));
};

/**
 * Close every live grant the revoked `credentialId` signed; returns how many.
 * `db` MUST be the revocation's transaction: a passkey revoked without its
 * closures would leave fences open on a device nobody trusts, and closures
 * without the revocation would close fences a working passkey opened.
 */
export const terminateWaiversSignedBy = async (input: {
  readonly db: DbExecutor;
  readonly credentialId: string;
  readonly now: Date;
}): Promise<number> => {
  const open = await openGrantsSignedBy(input.db, input.credentialId, input.now);
  if (open.length === 0) {
    return 0;
  }
  await input.db.insert(fenceWaivers).values(
    open.map((grant) => ({
      id: `fw_${randomUUID()}`,
      repo: grant.repo,
      pinId: grant.pinId,
      pinVersion: grant.pinVersion,
      kind: "revoke" as const,
      grantedBy: null,
      captureMode: HUB_CAPTURE_MODE,
      reason: AUTHORIZING_CREDENTIAL_REVOKED,
      expiresAt: null,
      supersedes: grant.id,
      createdAt: input.now,
      authority: SYSTEM_WAIVER_AUTHORITY,
      credentialId: input.credentialId,
      requestId: null,
    })),
  );
  return open.length;
};

/**
 * A FENCE THE HUB CLOSED because the passkey that approved it was revoked, as
 * every waiver surface shows it (D-PK-1): `pin list`, the verdict, `status`
 * and /ui/waivers say the fence closed and why, rather than letting a fence
 * that was open simply read as one nobody opened.
 *
 * SHOWN UNTIL THE GRANT WOULD HAVE RUN OUT (`heldUntil`): up to then the
 * closure is why the fence reads closed; after it the grant would be closed
 * anyway, and the closure stays in the record (GET /api/fence-waivers) only.
 */
export interface ClosedWaiver {
  /** The GRANT's id — the waiver a reader knew as open. */
  readonly id: string;
  readonly closedAt: string;
  readonly heldUntil: string;
  readonly reason: typeof AUTHORIZING_CREDENTIAL_REVOKED;
}

/** A pin's fence in both directions: what holds it open, and what the hub closed. */
export interface PinFence {
  readonly liveWaiver: LiveWaiver | null;
  readonly closedWaiver: ClosedWaiver | null;
}

/** How many hub-closed fences /ui/waivers lists; bounded like the open ones. */
const MAX_CLOSED_FENCES_LISTED = 100;

/** The superseded grant, joined to the closure that names it. */
const closedGrants = alias(fenceWaivers, "closed_grants");

/** Hub closures whose grant would still hold now, newest first, narrowed by `scope`. */
const closureRows = (db: DbExecutor, now: Date, scope: SQL | undefined) =>
  db
    .select({
      repo: fenceWaivers.repo,
      pinId: fenceWaivers.pinId,
      pinVersion: fenceWaivers.pinVersion,
      closedAt: fenceWaivers.createdAt,
      grantId: closedGrants.id,
      heldUntil: closedGrants.expiresAt,
    })
    .from(fenceWaivers)
    .innerJoin(closedGrants, eq(closedGrants.id, fenceWaivers.supersedes))
    .where(and(eq(fenceWaivers.authority, SYSTEM_WAIVER_AUTHORITY), gt(closedGrants.expiresAt, now), scope))
    .orderBy(desc(fenceWaivers.createdAt));

const closedWaiverOf = (row: {
  readonly closedAt: Date;
  readonly grantId: string;
  readonly heldUntil: Date | null;
}): ClosedWaiver => ({
  id: row.grantId,
  closedAt: row.closedAt.toISOString(),
  // Never null: the join keeps only grants whose expiry is ahead of now.
  heldUntil: (row.heldUntil ?? row.closedAt).toISOString(),
  reason: AUTHORIZING_CREDENTIAL_REVOKED,
});

/**
 * The newest hub closure for MANY pins, each at the version it is at now —
 * `pin list`'s reader, one query, scoped the way `readLiveWaivers` is.
 */
export const readClosedWaivers = async (
  input: LiveWaiversInput,
): Promise<ReadonlyMap<string, ClosedWaiver>> => {
  if (input.pins.length === 0) {
    return new Map();
  }
  const versions = new Map(input.pins.map((pin) => [pin.id, pin.version]));
  const rows = await closureRows(
    input.db,
    input.now,
    and(eq(fenceWaivers.repo, input.repo), inArray(fenceWaivers.pinId, [...versions.keys()])),
  );
  const closed = new Map<string, ClosedWaiver>();
  for (const row of rows) {
    if (!closed.has(row.pinId) && versions.get(row.pinId) === row.pinVersion) {
      closed.set(row.pinId, closedWaiverOf(row));
    }
  }
  return closed;
};

/** One pin's fence, both halves — the verdict's and `readPin`'s reader. */
export const readPinFence = async (input: LiveWaiverInput): Promise<PinFence> => {
  const closed = await readClosedWaivers({
    db: input.db,
    repo: input.repo,
    pins: [{ id: input.pinId, version: input.pinVersion }],
    now: input.now,
  });
  return { liveWaiver: await readLiveWaiver(input), closedWaiver: closed.get(input.pinId) ?? null };
};

/** One hub-closed fence as /ui/waivers lists it. */
export interface ClosedFence extends ClosedWaiver {
  readonly repo: string;
  readonly pinId: string;
  readonly surface: string;
}

/** Every fence the hub closed whose grant would still hold, across the hub, at each pin's current version. */
export const listClosedFences = async (input: {
  readonly db: DbExecutor;
  readonly now: Date;
}): Promise<readonly ClosedFence[]> => {
  const rows = await closureRows(input.db, input.now, undefined);
  if (rows.length === 0) {
    return [];
  }
  const current = await input.db
    .select({ id: pins.id, version: pins.version, surface: pins.surface })
    .from(pins)
    .where(inArray(pins.id, [...new Set(rows.map((row) => row.pinId))]));
  const byId = new Map(current.map((pin) => [pin.id, pin]));
  const seen = new Set<string>();
  const fences: ClosedFence[] = [];
  for (const row of rows) {
    const pin = byId.get(row.pinId);
    if (pin === undefined || pin.version !== row.pinVersion || seen.has(row.pinId)) {
      continue;
    }
    seen.add(row.pinId);
    fences.push({ ...closedWaiverOf(row), repo: row.repo, pinId: row.pinId, surface: pin.surface });
  }
  return fences.slice(0, MAX_CLOSED_FENCES_LISTED);
};
