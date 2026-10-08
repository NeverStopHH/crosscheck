/**
 * Drives /ui/confirm the way the confirm page's script does (human provenance
 * §6): a signed-in session, the pending set's fingerprint, a frozen batch
 * formed at POST /ui/confirm/batch, then ONE `confirm_batch` assertion by a
 * software authenticator (fixtures/soft-authenticator.ts) over that batch.
 * Shared by the batch suite, the invariant walk and the end-to-end test.
 */
import { pendingFingerprint, readPendingDrafts } from "../../src/services/human-drafts.ts";
import type { DraftRow } from "../../src/services/human-drafts.ts";
import { TEST_WEBAUTHN_ORIGIN } from "../helpers.ts";
import type { TestDeveloper, TestHarness } from "../helpers.ts";
import { assertViaUi, dataOf, enrolViaUi, viewerOf } from "./ceremony-driver.ts";
import type { Viewer } from "./ceremony-driver.ts";
import { createSoftCredential } from "./soft-authenticator.ts";
import type { SoftCredential } from "./soft-authenticator.ts";

export interface Confirmer {
  readonly viewer: Viewer;
  readonly credential: SoftCredential;
  /** The authenticator's counter: every assertion counts higher. */
  readonly nextCount: () => number;
}

/** A person with a passkey enrolled just now — still cooling off, which a confirmation does not wait for (Q19). */
export const prepareConfirmer = async (harness: TestHarness, developer: TestDeveloper): Promise<Confirmer> => {
  const viewer = await viewerOf(harness, developer);
  const credential = createSoftCredential();
  const enrolled = await enrolViaUi(harness, viewer, credential);
  if (enrolled.status !== 200) {
    throw new Error(`enrolment failed with ${String(enrolled.status)}: ${await enrolled.text()}`);
  }
  let count = 0;
  return {
    viewer,
    credential,
    nextCount: () => {
      count += 1;
      return count;
    },
  };
};

export interface Pending {
  readonly fingerprint: string;
  readonly drafts: readonly DraftRow[];
}

/** What the page renders: the pending drafts and the fingerprint of exactly that set. */
export const pendingOf = async (harness: TestHarness, developer: TestDeveloper): Promise<Pending> => {
  const drafts = await readPendingDrafts(harness.db, developer.developerId);
  return { fingerprint: pendingFingerprint(drafts), drafts };
};

export interface DecisionInput {
  readonly draftId: string;
  readonly version: number;
  readonly decision: "confirm" | "discard" | "keep";
  readonly word?: string;
  readonly reason?: string | null;
}

/** POST /ui/confirm/batch, as the page's script sends it. */
export const formBatch = (
  harness: TestHarness,
  viewer: Viewer,
  body: { readonly fingerprint: string; readonly items: readonly DecisionInput[] },
): Promise<Response> =>
  harness.app.request("/ui/confirm/batch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: viewer.cookie,
      Origin: TEST_WEBAUTHN_ORIGIN,
      "x-crosscheck-csrf": viewer.csrf,
    },
    body: JSON.stringify(body),
  });

export interface FormedBatch {
  readonly batchId: string;
  readonly digest: string;
}

/** One `confirm_batch` assertion over `batchId`. */
export const signBatch = (
  harness: TestHarness,
  confirmer: Confirmer,
  batchId: string,
  between?: () => Promise<void>,
): Promise<Response> =>
  assertViaUi(
    harness,
    confirmer.viewer,
    confirmer.credential,
    { action: "confirm_batch", subjectId: batchId },
    { signCount: confirmer.nextCount(), ...(between === undefined ? {} : { between }) },
  );

/** Every pending draft confirmed as drafted — or decided by `decide` — in one batch and one assertion. */
export const confirmPending = async (
  harness: TestHarness,
  developer: TestDeveloper,
  confirmer: Confirmer,
  decide: (draft: DraftRow) => Omit<DecisionInput, "draftId" | "version"> = () => ({ decision: "confirm" }),
): Promise<Response> => {
  const pending = await pendingOf(harness, developer);
  const formed = await formBatch(harness, confirmer.viewer, {
    fingerprint: pending.fingerprint,
    items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, ...decide(draft) })),
  });
  if (formed.status !== 200) {
    throw new Error(`batch refused with ${String(formed.status)}: ${await formed.text()}`);
  }
  const batch = await dataOf<FormedBatch>(formed);
  return signBatch(harness, confirmer, batch.batchId);
};
