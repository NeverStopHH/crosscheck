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
 *      ID given;
 *   5. each item lists the ROWS it became (`table`, `id`) — every human row
 *      names the item that signed it by a composite foreign key (review
 *      M5/P9) — so a client checks each row of its own against the content
 *      signed for it, and a row listed under an item of another kind, or
 *      under none, was not what the person signed.
 *
 * The public key is served from the same database as everything else, so a
 * writer of that database could swap it: the check proves authenticity only
 * against a key the client pinned on first sight (trust on first use, as the
 * connector pins in work depth), never against this answer's own key.
 *
 * The caller's own only: keyed by the authenticated developer, never by a
 * parameter, so nobody else's confirmations can be asked for.
 */
import { desc, eq, inArray, sql } from "drizzle-orm";

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
    /** The rows of the person's records this item became; none for a discard or a setting. */
    readonly rows: readonly SignedRow[];
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

/** One row of a record that counts, as an item names it. A pin's break is `pins_break`. */
export interface SignedRow {
  readonly table: string;
  readonly id: string;
}

type RowOfItem = {
  readonly table: string;
  readonly id: string;
  readonly confirmation_id: string;
  readonly position: number;
};

/** Every row the listed confirmations' items became, by the item each names. */
const readSignedRows = async (db: Db, ids: readonly string[]): Promise<readonly RowOfItem[]> => {
  if (ids.length === 0) {
    return [];
  }
  const within = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute<RowOfItem>(sql`
    SELECT 'pilot_marks' AS table, id, confirmation_id, confirmation_position AS position FROM pilot_marks WHERE confirmation_id IN (${within})
    UNION ALL SELECT 'noise_reassertions', id, confirmation_id, confirmation_position FROM noise_reassertions WHERE confirmation_id IN (${within})
    UNION ALL SELECT 'hint_outcomes', id, confirmation_id, confirmation_position FROM hint_outcomes WHERE confirmation_id IN (${within})
    UNION ALL SELECT 'pins', id, confirmation_id, confirmation_position FROM pins WHERE confirmation_id IN (${within})
    UNION ALL SELECT 'pins_break', id, broke_confirmation_id, broke_confirmation_position FROM pins WHERE broke_confirmation_id IN (${within})
    UNION ALL SELECT 'developer_mutes', muted_developer_id, confirmation_id, confirmation_position FROM developer_mutes
      WHERE confirmation_id IN (${within})
    ORDER BY 1, 2`);
  return rows.rows.map((row) => ({ ...row, position: Number(row.position) }));
};

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
  const signed = await readSignedRows(db, ids);
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
        rows: signed
          .filter((each) => each.confirmation_id === row.id && each.position === item.position)
          .map((each) => ({ table: each.table, id: each.id })),
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
