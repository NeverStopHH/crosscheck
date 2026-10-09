/**
 * A CONFIRMATION ROW, seeded straight into the table — for tests of what reads
 * or references human-confirmed records, where the batch ceremony is not what
 * is under test (it has its own suite, driven through the software
 * authenticator: confirm-batch.test.ts). The `seedPasskey` precedent.
 */
import { randomUUID } from "node:crypto";
import type { DraftDecision, DraftKind } from "@crosscheck/schema";

import { humanConfirmationItems, humanConfirmations, humanDrafts } from "../../src/db/schema.ts";
import { humanStamp } from "../../src/services/human-provenance.ts";
import type { HumanStamp } from "../../src/services/human-provenance.ts";
import type { DbExecutor } from "../../src/db/client.ts";
import { seedPasskey } from "./passkeys.ts";

const AT = new Date("2026-07-24T09:00:00.000Z");

/**
 * A confirmation by `developerId`'s own (seeded) passkey, past its cool-off,
 * with the one item it signed (a row names its item: review M5/P9), and the
 * stamp a writer takes from it. Several rows may share one stamp. The item
 * is a draft of `kind`, decided `decision`: the database admits a row only
 * under a CONFIRMED item of its own kind (round-2 M5).
 */
export const seedHumanStamp = async (
  db: DbExecutor,
  developerId: string,
  kind: DraftKind,
  decision: DraftDecision = "confirm",
): Promise<HumanStamp> => {
  const { credentialId } = await seedPasskey(db, developerId);
  const id = `hc_seed_${randomUUID()}`;
  const draftId = `dr_seed_${randomUUID()}`;
  await db.insert(humanDrafts).values({
    id: draftId,
    developerId,
    repo: null,
    kind,
    subjectKey: `seeded:${draftId}`,
    version: 1,
    payload: {},
    provenance: "agent_asserted",
    createdAt: AT,
  });
  await db.insert(humanConfirmations).values({
    id,
    developerId,
    credentialId,
    rpId: "localhost",
    digest: "seeded",
    pendingFingerprint: "seeded",
    itemCount: 1,
    formedAt: AT,
    confirmedAt: AT,
    // No real assertion: this row stands in for one where the ceremony is not under test.
    authenticatorData: "seeded",
    clientDataJson: "seeded",
    signature: "seeded",
    userHandle: null,
  });
  await db.insert(humanConfirmationItems).values({
    confirmationId: id,
    position: 0,
    draftId,
    draftVersion: 1,
    draftDigest: "seeded",
    decision,
    content: {},
  });
  return humanStamp(id, 0);
};
