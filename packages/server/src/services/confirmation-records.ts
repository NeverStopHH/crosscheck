/**
 * A PERSON'S OWN CONFIRMATIONS, CHECKABLE WITHOUT THE HUB (human provenance
 * §6). Each confirmation is served with the assertion that confirmed it and
 * everything needed to re-derive what that assertion signed:
 *
 *   1. each item's `draftDigest` = SHA-256 of the canonical JSON of
 *      `[draft.id, draft.kind, draft.subjectKey, draft.version,
 *      draft.provenance, draft.payload]` — canonical: object keys sorted,
 *      no whitespace (services/human-drafts.ts `canonicalJson`);
 *   2. the batch `digest` = SHA-256 of the canonical JSON of
 *      `[pendingFingerprint, items.map(i => [i.draft.id, i.draft.version,
 *      i.draftDigest, i.decision, i.content])]`, in position order;
 *   3. the challenge in `clientDataJSON` is 16 nonce bytes followed by
 *      SHA-256 of `JSON.stringify([purpose, subject, JSON.stringify(terms as
 *      [key, value] pairs sorted by key)])`, with purpose `confirm_batch`,
 *      subject the confirmation id and terms `{ batchDigest: digest }`
 *      (services/webauthn.ts `challengeOf`);
 *   4. the signature verifies over `authenticatorData ‖ SHA-256(clientDataJSON)`
 *      under the credential's COSE public key, with the UV flag set, at the RP
 *      ID given.
 *
 * The caller's own only: keyed by the authenticated developer, never by a
 * parameter, so nobody else's confirmations can be asked for.
 */
import { desc, eq, inArray } from "drizzle-orm";

import { humanConfirmationItems, humanConfirmations, humanDrafts, passkeys } from "../db/schema.ts";
import type { Db } from "../db/client.ts";

/** How many confirmations one read lists, newest first. */
export const MAX_CONFIRMATIONS_LISTED = 50;

export interface ConfirmationRecord {
  readonly id: string;
  readonly digest: string;
  readonly pendingFingerprint: string;
  readonly formedAt: string;
  readonly confirmedAt: string;
  readonly rpId: string;
  readonly credential: { readonly id: string; readonly publicKey: string };
  readonly assertion: {
    readonly authenticatorData: string;
    readonly clientDataJSON: string;
    readonly signature: string;
    readonly userHandle: string | null;
  };
  readonly challenge: {
    readonly purpose: "confirm_batch";
    readonly subject: string;
    readonly terms: { readonly batchDigest: string };
  };
  readonly items: readonly {
    readonly position: number;
    readonly decision: string;
    readonly content: Readonly<Record<string, unknown>>;
    readonly draftDigest: string;
    readonly draft: {
      readonly id: string;
      readonly kind: string;
      readonly subjectKey: string;
      readonly version: number;
      readonly provenance: string;
      readonly payload: Readonly<Record<string, unknown>>;
    };
  }[];
}

export const readOwnConfirmations = async (
  db: Db,
  developerId: string,
  limit: number,
): Promise<readonly ConfirmationRecord[]> => {
  const confirmations = await db
    .select({ row: humanConfirmations, publicKey: passkeys.publicKey })
    .from(humanConfirmations)
    .innerJoin(passkeys, eq(passkeys.credentialId, humanConfirmations.credentialId))
    .where(eq(humanConfirmations.developerId, developerId))
    .orderBy(desc(humanConfirmations.confirmedAt), desc(humanConfirmations.id))
    .limit(Math.min(limit, MAX_CONFIRMATIONS_LISTED));
  const ids = confirmations.map((entry) => entry.row.id);
  const items =
    ids.length === 0
      ? []
      : await db
          .select({ item: humanConfirmationItems, draft: humanDrafts })
          .from(humanConfirmationItems)
          .innerJoin(humanDrafts, eq(humanDrafts.id, humanConfirmationItems.draftId))
          .where(inArray(humanConfirmationItems.confirmationId, ids))
          .orderBy(humanConfirmationItems.confirmationId, humanConfirmationItems.position);
  return confirmations.map(({ row, publicKey }) => ({
    id: row.id,
    digest: row.digest,
    pendingFingerprint: row.pendingFingerprint,
    formedAt: row.formedAt.toISOString(),
    confirmedAt: row.confirmedAt.toISOString(),
    rpId: row.rpId,
    credential: { id: row.credentialId, publicKey },
    assertion: {
      authenticatorData: row.authenticatorData,
      clientDataJSON: row.clientDataJson,
      signature: row.signature,
      userHandle: row.userHandle,
    },
    challenge: { purpose: "confirm_batch", subject: row.id, terms: { batchDigest: row.digest } },
    items: items
      .filter((entry) => entry.item.confirmationId === row.id)
      .map(({ item, draft }) => ({
        position: item.position,
        decision: item.decision,
        content: item.content,
        draftDigest: item.draftDigest,
        draft: {
          id: draft.id,
          kind: draft.kind,
          subjectKey: draft.subjectKey,
          version: draft.version,
          provenance: draft.provenance,
          payload: draft.payload,
        },
      })),
  }));
};
