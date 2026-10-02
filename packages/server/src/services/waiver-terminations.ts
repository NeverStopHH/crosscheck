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

import { and, eq, gt, inArray } from "drizzle-orm";
import { AUTHORIZING_CREDENTIAL_REVOKED, SYSTEM_WAIVER_AUTHORITY } from "@crosscheck/schema";

import { fenceWaivers } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";

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
