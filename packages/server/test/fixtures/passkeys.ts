/**
 * A passkey ROW, seeded straight into the table — for tests of what reads or
 * references passkeys, where the enrolment ceremony is not what is under test
 * (that one has its own tests, driven through the software authenticator).
 */
import { randomUUID } from "node:crypto";

import { passkeys } from "../../src/db/schema.ts";
import type { DbExecutor } from "../../src/db/client.ts";

const DAY_MS = 86_400_000;

export interface SeededPasskey {
  readonly id: string;
  readonly credentialId: string;
}

export const seedPasskey = async (
  db: DbExecutor,
  developerId: string,
  overrides: { readonly createdAt?: Date; readonly usableFrom?: Date } = {},
): Promise<SeededPasskey> => {
  const id = `pk_${randomUUID()}`;
  const credentialId = `cred_${randomUUID()}`;
  const createdAt = overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z");
  await db.insert(passkeys).values({
    id,
    developerId,
    credentialId,
    publicKey: "seeded-not-a-real-key",
    signCount: 0,
    transports: ["internal"],
    rpId: "localhost",
    aaguid: "00000000-0000-0000-0000-000000000000",
    backedUp: false,
    label: "seeded passkey",
    enrolledVia: "admin",
    createdAt,
    usableFrom: overrides.usableFrom ?? new Date(createdAt.getTime() + DAY_MS),
  });
  return { id, credentialId };
};
