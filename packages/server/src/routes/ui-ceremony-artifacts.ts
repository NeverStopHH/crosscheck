/**
 * RELEASING AN ARTIFACT TAKES A PASSKEY (review M2). The two ceremony actions
 * behind /ui/approvals, called by routes/ui-ceremony.ts.
 *
 * A `needs_approval` artifact is "owner-only until released" (DESIGN.md
 * §2.1): releasing one is a person's disclosure decision. It used to be a
 * session form post, and any API key opens a session through /ui/login, so
 * an agent holding the key could release its person's artifact to the whole
 * team. Now approving is a ceremony like the fence's, with the same cool-off
 * (a passkey younger than a day signs nothing).
 *
 * WITHDRAWING IS NOT GATED (review of the hub hardening, M3): it makes content
 * more private, so the owner withdraws with a plain session form
 * (routes/ui-pages.tsx) and the operator with the admin token
 * (routes/artifacts.ts). The `revoke_artifact` ceremony stays, optional, for a
 * person who wants the withdrawal signed.
 *
 * WHAT IS SIGNED: the artifact id and a digest of its content as stored, so a
 * signature releases exactly the bytes the page showed. Ownership is checked
 * twice, by the read that builds the terms and inside the UPDATE itself
 * (services/artifacts.ts), and both answer "unknown" for a missing id and for
 * somebody else's alike.
 */
import { createHash } from "node:crypto";

import { readOwnedNeedsApproval, setArtifactApproval } from "../services/artifacts.ts";
import type { CeremonyPurpose, CeremonyTerms } from "../services/webauthn.ts";
import type { AppDeps } from "../types.ts";

export type ArtifactAction = "approve_artifact" | "revoke_artifact";

export interface ArtifactFields {
  readonly action: ArtifactAction;
  readonly subjectId: string;
}

interface SignedRelease {
  readonly purpose: CeremonyPurpose;
  readonly subject: string;
  readonly terms: CeremonyTerms;
}

export type ArtifactRefusal = "unknown_artifact";

export const ARTIFACT_SENTENCE: Readonly<Record<ArtifactRefusal, string>> = {
  unknown_artifact: "you have no artifact awaiting approval with that id — nothing was changed",
};

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The terms an artifact ceremony signs, built from the stored row the signer owns. */
export const artifactTermsOf = async (
  deps: AppDeps,
  developerId: string,
  fields: ArtifactFields,
): Promise<SignedRelease | { readonly ceremonyRefusal: ArtifactRefusal }> => {
  const owned = await readOwnedNeedsApproval(deps.db, developerId, fields.subjectId);
  if (owned === null) {
    return { ceremonyRefusal: "unknown_artifact" };
  }
  return {
    purpose: fields.action,
    subject: fields.subjectId,
    terms: { contentDigest: digestOf(owned.content) },
  };
};

/** What a verified artifact assertion does, and the sentence the page shows after it. */
export const performOnArtifact = async (
  deps: AppDeps,
  developerId: string,
  fields: ArtifactFields,
): Promise<{ readonly message: string } | { readonly ceremonyRefusal: ArtifactRefusal }> => {
  const isApproving = fields.action === "approve_artifact";
  const outcome = await setArtifactApproval(deps.db, developerId, fields.subjectId, isApproving);
  if (outcome === "not_found") {
    return { ceremonyRefusal: "unknown_artifact" };
  }
  return {
    message: isApproving
      ? "Released — every member of this hub can now see its content."
      : "Withdrawn — only you can see its content again.",
  };
};
