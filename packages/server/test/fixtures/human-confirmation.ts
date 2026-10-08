/**
 * A CONFIRMATION ROW, seeded straight into the table — for tests of what reads
 * or references human-confirmed records, where the batch ceremony is not what
 * is under test (it has its own suite, driven through the software
 * authenticator: confirm-batch.test.ts). The `seedPasskey` precedent.
 */
import { randomUUID } from "node:crypto";

import { humanConfirmations } from "../../src/db/schema.ts";
import { humanStamp } from "../../src/services/human-provenance.ts";
import type { HumanStamp } from "../../src/services/human-provenance.ts";
import type { DbExecutor } from "../../src/db/client.ts";
import { seedPasskey } from "./passkeys.ts";

const AT = new Date("2026-07-24T09:00:00.000Z");

/** A confirmation by `developerId`'s own (seeded) passkey, and the stamp a writer takes from it. */
export const seedHumanStamp = async (db: DbExecutor, developerId: string): Promise<HumanStamp> => {
  const { credentialId } = await seedPasskey(db, developerId);
  const id = `hc_seed_${randomUUID()}`;
  await db.insert(humanConfirmations).values({
    id,
    developerId,
    credentialId,
    rpId: "localhost",
    digest: "seeded",
    pendingFingerprint: "seeded",
    itemCount: 0,
    formedAt: AT,
    confirmedAt: AT,
    // No real assertion: this row stands in for one where the ceremony is not under test.
    authenticatorData: "seeded",
    clientDataJson: "seeded",
    signature: "seeded",
    userHandle: null,
  });
  return humanStamp(id);
};
