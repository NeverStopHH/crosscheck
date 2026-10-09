/**
 * WHAT A VOID CONFIRMATION DID IS UNDONE (human provenance, round-2 R2-M3,
 * the owner's decision).
 *
 * A confirmation is void when the passkey that signed it never stood (revoked
 * in its cool-off) or was declared compromised. Its words already count
 * nowhere (services/human-provenance.ts) and its drafts return to the
 * person's page (services/human-drafts.ts); what it CHANGED is rolled back
 * here, in the revocation's own transaction:
 *
 *   - a break it recorded is disarmed: the pin is unbroken again;
 *   - a mute it added is removed, and an unmute it made is undone — the mute
 *     comes back with the stamp of the confirmation that had made it;
 *   - a presence-on it confirmed is switched off again, unless the person
 *     changed presence since;
 *   - a pin it created protects nothing: the pin readers keep only pins whose
 *     confirmation is in effect (services/pins.ts), and confirming the draft
 *     again revives the row.
 *
 * Labels, outcomes and noise need nothing here: every figure and the write
 * path read only confirmations in effect. A `retired` revocation calls none of
 * this — the passkey stood when it confirmed.
 */
import { sql } from "drizzle-orm";
import type { ProvenanceClass } from "@crosscheck/schema";

import { applyPresenceOptOut, finishPresenceChange } from "./developer-settings.ts";
import { confirmationInEffect } from "./human-provenance.ts";
import type { DbExecutor } from "../db/client.ts";

export interface RollbackInput {
  readonly credentialId: string;
  readonly now: Date;
  /** The class of the hand that revoked: what the restored opt-out is recorded as. */
  readonly provenance: ProvenanceClass;
}

export interface RollbackResult {
  /** The developer whose presence was switched off again: their location index needs rebuilding. */
  readonly presenceRestoredFor: string | null;
}

type UnmuteRow = {
  readonly reader: string;
  readonly muted: string;
  readonly subject_key: string;
  readonly confirmed_at: string | Date;
};

type MuteStamp = { readonly confirmation_id: string; readonly position: number };

/** The confirmation item, in effect and older than `before`, that last muted `subjectKey` — or none (a 0.10 mute). */
const priorMuteStamp = async (tx: DbExecutor, reader: string, subjectKey: string, before: string | Date): Promise<MuteStamp | undefined> => {
  const rows = await tx.execute<MuteStamp>(sql`
    SELECT i.confirmation_id, i.position FROM human_confirmation_items i
    JOIN human_drafts d ON d.id = i.draft_id
    JOIN human_confirmations hc ON hc.id = i.confirmation_id
    WHERE d.developer_id = ${reader} AND d.kind = 'mute' AND d.subject_key = ${subjectKey} AND i.decision = 'confirm'
      AND hc.confirmed_at < ${new Date(before).toISOString()}::timestamptz AND ${confirmationInEffect("i.confirmation_id")}
    ORDER BY hc.confirmed_at DESC LIMIT 1`);
  return rows.rows[0];
};

/** An unmute this credential confirmed, undone: the mute it removed comes back, as it was signed. */
const restoreUnmutes = async (tx: DbExecutor, input: RollbackInput): Promise<void> => {
  const unmutes = await tx.execute<UnmuteRow>(sql`
    SELECT d.developer_id AS reader, i.content->>'developerId' AS muted, d.subject_key, hc.confirmed_at
    FROM human_confirmation_items i
    JOIN human_drafts d ON d.id = i.draft_id
    JOIN human_confirmations hc ON hc.id = i.confirmation_id
    WHERE hc.credential_id = ${input.credentialId} AND d.kind = 'unmute' AND i.decision = 'confirm'`);
  for (const unmute of unmutes.rows) {
    const stamp = await priorMuteStamp(tx, unmute.reader, unmute.subject_key, unmute.confirmed_at);
    await tx.execute(sql`
      INSERT INTO developer_mutes (reader_developer_id, muted_developer_id, created_at, provenance, confirmation_id, confirmation_position)
      VALUES (${unmute.reader}, ${unmute.muted}, ${input.now.toISOString()}::timestamptz,
        ${stamp === undefined ? "unknown_legacy" : "human_passkey_confirmed"},
        ${stamp?.confirmation_id ?? null}, ${stamp?.position ?? null})
      ON CONFLICT DO NOTHING`);
  }
};

/** A presence-on this credential confirmed, switched off again — unless presence changed since. */
const restoreOptOut = async (tx: DbExecutor, input: RollbackInput): Promise<string | null> => {
  const rows = await tx.execute<{ developer_id: string }>(sql`
    SELECT d.developer_id FROM human_confirmation_items i
    JOIN human_drafts d ON d.id = i.draft_id
    JOIN human_confirmations hc ON hc.id = i.confirmation_id
    JOIN developers dev ON dev.id = d.developer_id
    WHERE hc.credential_id = ${input.credentialId} AND d.kind = 'presence_on' AND i.decision = 'confirm'
      AND dev.presence_opt_out = false
      AND (SELECT pc.kind FROM privacy_changes pc WHERE pc.developer_id = d.developer_id
           ORDER BY pc.created_at DESC, pc.id DESC LIMIT 1) = 'presence_on'
      AND (SELECT max(pc.created_at) FROM privacy_changes pc WHERE pc.developer_id = d.developer_id) >= hc.confirmed_at
    LIMIT 1`);
  const developerId = rows.rows[0]?.developer_id;
  if (developerId === undefined) {
    return null;
  }
  await applyPresenceOptOut({ db: tx, now: () => input.now }, developerId, true, input.provenance);
  return developerId;
};

/**
 * What a revocation leaves to do once it committed: the location index of a
 * person whose presence the roll-back switched off again (as any opt-out's).
 */
export const finishRevocation = async (
  deps: Parameters<typeof finishPresenceChange>[0],
  revoked: { readonly presenceRestoredFor: string | null },
): Promise<void> => {
  if (revoked.presenceRestoredFor !== null) {
    await finishPresenceChange(deps, revoked.presenceRestoredFor, true);
  }
};

/** What the person reads after a revocation: what it kept, or what it undid. */
export const revocationSentence = (revoked: { readonly voided: boolean }, reason: "retired" | "compromised"): string => {
  if (!revoked.voided) {
    return "Passkey retired: what it confirmed while it stood keeps counting.";
  }
  return reason === "compromised"
    ? "Passkey revoked as compromised: what it confirmed is retracted and undone, and those drafts are back on your confirm page."
    : "Passkey revoked during its first day: it never counted, what it confirmed is undone, and those drafts are back on your confirm page.";
};

/** Every effect of every confirmation `credentialId` signed, rolled back (see the header). */
export const rollBackConfirmationsOf = async (tx: DbExecutor, input: RollbackInput): Promise<RollbackResult> => {
  const signed = sql`(SELECT hc.id FROM human_confirmations hc WHERE hc.credential_id = ${input.credentialId})`;
  await tx.execute(sql`
    UPDATE pins SET broke_at = NULL, broke_by = NULL, broke_at_commit = NULL, broke_provenance = NULL,
      broke_confirmation_id = NULL, broke_confirmation_position = NULL
    WHERE broke_confirmation_id IN ${signed}`);
  await tx.execute(sql`DELETE FROM developer_mutes WHERE confirmation_id IN ${signed}`);
  await restoreUnmutes(tx, input);
  return { presenceRestoredFor: await restoreOptOut(tx, input) };
};
