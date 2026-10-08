/**
 * CONFIRMING A FROZEN BATCH TAKES A PASSKEY (human provenance §6). The
 * `confirm_batch` ceremony behind /ui/confirm, called by routes/ui-ceremony.ts
 * — the artifact precedent (routes/ui-ceremony-artifacts.ts).
 *
 * WHAT IS SIGNED: the batch id as the subject and the batch digest as the
 * terms, so the challenge (`nonce ‖ SHA-256(purpose, subject, terms)`) is
 * bound to exactly the decisions and contents the person froze. The batch is
 * read for the CALLER'S SESSION only: a batch another session formed — an
 * agent's, say — reads as no batch at all.
 *
 * NO COOL-OFF (Q19): confirming one's own drafts is not a privileged action,
 * so every enrolled, unrevoked passkey of the person may sign it.
 */
import { BATCH_SENTENCE } from "../services/confirmation-batch.ts";
import type { BatchRefusal, BatchStore } from "../services/confirmation-batch.ts";
import { finishPresenceChange } from "../services/developer-settings.ts";
import type { CeremonyOwner, CeremonyPurpose, CeremonyTerms, StoredCredential } from "../services/webauthn.ts";
import type { AppDeps } from "../types.ts";

export { BATCH_SENTENCE };

export interface ConfirmFields {
  readonly action: "confirm_batch";
  readonly subjectId: string;
}

interface SignedBatch {
  readonly purpose: CeremonyPurpose;
  readonly subject: string;
  readonly terms: CeremonyTerms;
}

/** The terms a confirmation signs: the batch the caller's own session formed, and its digest. */
export const confirmTermsOf = (
  batches: BatchStore,
  owner: CeremonyOwner,
  fields: ConfirmFields,
): SignedBatch | { readonly ceremonyRefusal: BatchRefusal } => {
  const batch = batches.read(owner, fields.subjectId);
  if (batch === null) {
    return { ceremonyRefusal: "unknown_batch" };
  }
  return { purpose: fields.action, subject: batch.id, terms: { batchDigest: batch.digest } };
};

/** What a verified confirmation does, and the sentence the page shows after it. */
export const performConfirm = async (
  deps: AppDeps,
  batches: BatchStore,
  owner: CeremonyOwner,
  fields: ConfirmFields,
  credential: StoredCredential,
  signedTerms: CeremonyTerms,
): Promise<{ readonly message: string; readonly confirmed: number } | { readonly ceremonyRefusal: BatchRefusal }> => {
  const batch = batches.read(owner, fields.subjectId);
  // The signature covered this digest; a batch that is gone or differs confirms nothing.
  if (batch === null || batch.digest !== signedTerms["batchDigest"]) {
    return { ceremonyRefusal: "unknown_batch" };
  }
  const outcome = await batches.confirm(deps, batch, { id: credential.id, rpId: credential.rpId });
  if ("refusal" in outcome) {
    return { ceremonyRefusal: outcome.refusal };
  }
  if (outcome.presenceOn) {
    await finishPresenceChange(deps, owner.developerId, false);
  }
  return {
    confirmed: outcome.confirmed,
    message:
      `Confirmed ${String(outcome.confirmed)} as yours, discarded ${String(outcome.discarded)}` +
      (outcome.kept === 0 ? "." : `, left ${String(outcome.kept)} for later.`),
  };
};
