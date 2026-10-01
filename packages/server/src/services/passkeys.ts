/**
 * WHO MAY HOLD A PASSKEY, AND WHEN IT MAY ACT (1.0 spec 04a §4).
 *
 * The hub cannot tell a passkey on Touch ID from one a program emulates (04a
 * §3), so the strength of the human gate sits HERE, in which credentials get
 * enrolled and when they may start to act:
 *
 *   - an enrolment spends a CODE — minted by the admin and handed over out of
 *     band, or minted internally after an assertion by an existing passkey of
 *     the same developer. The api key alone is neither;
 *   - a new passkey COOLS OFF for `PASSKEY_COOLOFF_HOURS` and is announced on
 *     `status` and `doctor` meanwhile, so an enrolment nobody expected is seen
 *     before it can act;
 *   - during the cool-off its owner may revoke it with the api key (making a
 *     credential LESS capable needs no stronger authority); after it, only a
 *     passkey of the same developer or the admin may.
 *
 * Codes are kept as hashes and shown once. Passkeys are never deleted: every
 * passkey grant names its credential, and "which device said yes" must stay
 * answerable after the device is revoked.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, desc, eq, gt, gte, isNull, lte, sql } from "drizzle-orm";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { EnrolmentSource, PasskeyRevoker } from "@crosscheck/schema";

import { ENROLMENT_CODE_TTL_HOURS, PASSKEY_COOLOFF_HOURS } from "../constants.ts";
import { developers, passkeyEnrollments, passkeys } from "../db/schema.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import type { StoredCredential } from "./webauthn.ts";

const HOUR_MS = 3_600_000;

/** 80 bits: far beyond guessing within a day's lifetime, and 16 characters a person can type. */
const CODE_BYTES = 10;
const CODE_GROUP_CHARS = 4;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_BITS = 5;
const BYTE_BITS = 8;

/** How many enrolments one announcement lists; newest first, the rest counted elsewhere. */
const MAX_RECENT_ENROLMENTS = 20;

/** What an authenticator with no identity sends — an emulator, usually (04a §4.3). */
const ZERO_AAGUID = "00000000-0000-0000-0000-000000000000";

/**
 * AAGUID → the name a person recognises, DISPLAY ONLY (04a §4.3).
 *
 * From the community list github.com/passkeydeveloper/passkey-authenticator-aaguids.
 * A wrong or missing entry changes a word in an announcement and nothing
 * else: no decision anywhere reads this map.
 *
 * SHOWN AS A CLAIM. With attestation "none" the AAGUID is whatever the
 * authenticator says, and a software key can say iCloud Keychain's — so an
 * announcement that read "(iCloud Keychain)" would vouch for the one thing
 * the hub cannot check.
 */
const AUTHENTICATOR_NAMES: ReadonlyMap<string, string> = new Map([
  ["fbfc3007-154e-4ecc-8c0b-6e020557d7bd", "iCloud Keychain"],
  ["ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4", "Google Password Manager"],
  ["adce0002-35bc-c60a-648b-0b25f1f05503", "Chrome on Mac"],
  ["08987058-cadc-4b81-b6e1-30de50dcbe96", "Windows Hello"],
  ["9ddd1817-af5a-4672-a2b9-3e3dd95000a9", "Windows Hello"],
  ["6028b017-b1d4-4c02-b4b3-afcdafc96bb2", "Windows Hello"],
  ["bada5566-a7aa-401f-bd96-45619a55120d", "1Password"],
  ["d548826e-79b4-db40-a3d8-11116f7e8349", "Bitwarden"],
]);

export const authenticatorName = (aaguid: string): string => {
  if (aaguid === ZERO_AAGUID) {
    return "unknown authenticator";
  }
  const name = AUTHENTICATOR_NAMES.get(aaguid);
  return name === undefined ? `unrecognised authenticator ${aaguid}` : `says it is ${name}, unverified`;
};

const toBase32 = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << BYTE_BITS) | byte;
    bits += BYTE_BITS;
    while (bits >= BASE32_BITS) {
      out += BASE32_ALPHABET[(value >>> (bits - BASE32_BITS)) & 31];
      bits -= BASE32_BITS;
    }
  }
  return bits > 0 ? out + BASE32_ALPHABET[(value << (BASE32_BITS - bits)) & 31] : out;
};

/** A code read out of a chat and typed back: dashes, spaces and case do not matter. */
const hashCode = (code: string): string =>
  createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");

export const mintEnrolmentCode = async (input: {
  readonly db: DbExecutor;
  readonly developerId: string;
  readonly source: EnrolmentSource;
  readonly now: Date;
}): Promise<{ code: string; expiresAt: Date }> => {
  const raw = toBase32(new Uint8Array(randomBytes(CODE_BYTES)));
  const code = (raw.match(new RegExp(`.{1,${String(CODE_GROUP_CHARS)}}`, "g")) ?? [raw]).join("-");
  const expiresAt = new Date(input.now.getTime() + ENROLMENT_CODE_TTL_HOURS * HOUR_MS);
  await input.db.insert(passkeyEnrollments).values({
    id: `pe_${randomUUID()}`,
    developerId: input.developerId,
    codeHash: hashCode(code),
    source: input.source,
    createdAt: input.now,
    expiresAt,
    usedAt: null,
  });
  return { code, expiresAt };
};

/** One predicate for "this code may enrol a passkey for this developer, now". */
const spendableCode = (developerId: string, code: string, now: Date) =>
  and(
    eq(passkeyEnrollments.codeHash, hashCode(code)),
    eq(passkeyEnrollments.developerId, developerId),
    isNull(passkeyEnrollments.usedAt),
    gt(passkeyEnrollments.expiresAt, now),
  );

/**
 * Checked BEFORE a registration ceremony is offered, so a mistyped code fails
 * before the person touches their device. Not the gate: `enrolPasskey`
 * re-checks and spends the code in the same transaction that writes the row.
 */
export const isEnrolmentCodeValid = async (input: {
  readonly db: DbExecutor;
  readonly developerId: string;
  readonly code: string;
  readonly now: Date;
}): Promise<boolean> => {
  const rows = await input.db
    .select({ id: passkeyEnrollments.id })
    .from(passkeyEnrollments)
    .where(spendableCode(input.developerId, input.code, input.now))
    .limit(1);
  return rows[0] !== undefined;
};

export type EnrolRefusal = "code_invalid" | "credential_already_enrolled";

/**
 * SPEND THE CODE AND WRITE THE PASSKEY, in one transaction — or neither.
 *
 * One refusal for an unknown, used, expired or other developer's code:
 * whether a code exists for somebody else is not this caller's to learn.
 * The credential arrives VERIFIED (services/webauthn.ts); this decides only
 * whether this developer may hold it.
 */
export const enrolPasskey = async (input: {
  readonly db: Db;
  readonly developerId: string;
  readonly code: string;
  readonly credential: StoredCredential;
  readonly label: string;
  readonly now: Date;
}): Promise<{ passkeyId: string; usableFrom: Date } | { refusal: EnrolRefusal }> =>
  input.db.transaction(async (tx) => {
    const known = await tx
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.credentialId, input.credential.id))
      .limit(1);
    if (known[0] !== undefined) {
      return { refusal: "credential_already_enrolled" as const };
    }
    const spent = await tx
      .update(passkeyEnrollments)
      .set({ usedAt: input.now })
      .where(spendableCode(input.developerId, input.code, input.now))
      .returning({ source: passkeyEnrollments.source });
    const source = spent[0]?.source;
    if (source === undefined) {
      return { refusal: "code_invalid" as const };
    }
    const passkeyId = `pk_${randomUUID()}`;
    const usableFrom = new Date(input.now.getTime() + PASSKEY_COOLOFF_HOURS * HOUR_MS);
    await tx.insert(passkeys).values({
      id: passkeyId,
      developerId: input.developerId,
      credentialId: input.credential.id,
      publicKey: isoBase64URL.fromBuffer(input.credential.publicKey),
      signCount: input.credential.counter,
      transports: input.credential.transports,
      rpId: input.credential.rpId,
      aaguid: input.credential.aaguid,
      backedUp: input.credential.backedUp,
      label: input.label,
      enrolledVia: source,
      createdAt: input.now,
      usableFrom,
    });
    return { passkeyId, usableFrom };
  });

type PasskeyRow = typeof passkeys.$inferSelect;

const storedOf = (row: PasskeyRow): StoredCredential => ({
  id: row.credentialId,
  publicKey: isoBase64URL.toBuffer(row.publicKey),
  counter: row.signCount,
  transports: row.transports,
  rpId: row.rpId,
  aaguid: row.aaguid,
  backedUp: row.backedUp,
});

export interface UsableCredential {
  readonly passkeyId: string;
  readonly credential: StoredCredential;
}

/** The credentials that may sign NOW: not revoked, past their cool-off (PK-7). */
export const usableCredentials = async (input: {
  readonly db: DbExecutor;
  readonly developerId: string;
  readonly now: Date;
}): Promise<readonly UsableCredential[]> => {
  const rows = await input.db
    .select()
    .from(passkeys)
    .where(
      and(
        eq(passkeys.developerId, input.developerId),
        isNull(passkeys.revokedAt),
        lte(passkeys.usableFrom, input.now),
      ),
    );
  return rows.map((row) => ({ passkeyId: row.id, credential: storedOf(row) }));
};

/** Every unrevoked credential, cooling off or not — what a new registration must not duplicate. */
export const enrolledCredentials = async (input: {
  readonly db: DbExecutor;
  readonly developerId: string;
}): Promise<readonly StoredCredential[]> => {
  const rows = await input.db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.developerId, input.developerId), isNull(passkeys.revokedAt)));
  return rows.map(storedOf);
};

/**
 * The counter a verified assertion reported, so a later lower one reads as a
 * clone. Only ever RAISED: two verifies that finish out of order must not
 * store the smaller count, which would let a cloned key's next one pass.
 */
export const recordSignCount = async (input: {
  readonly db: DbExecutor;
  readonly credentialId: string;
  readonly counter: number;
}): Promise<void> => {
  await input.db
    .update(passkeys)
    .set({ signCount: sql`GREATEST(${passkeys.signCount}, ${input.counter})` })
    .where(eq(passkeys.credentialId, input.credentialId));
};

export type PasskeyRevocation =
  | { readonly kind: "owner"; readonly developerId: string }
  | { readonly kind: "passkey"; readonly developerId: string }
  | { readonly kind: "admin" };

export type RevokePasskeyRefusal = "unknown_passkey" | "already_revoked" | "passkey_required";

/**
 * CLOSE A PASSKEY (04a §4.4). The rules, in the order they are checked:
 * another developer's passkey is `unknown` (existence is not disclosed);
 * a revoked one stays revoked; the api key alone may revoke only during the
 * cool-off — after it, an agent with the key could otherwise lock its human
 * out of the one authority the agent cannot use itself.
 */
export const revokePasskey = async (input: {
  readonly db: DbExecutor;
  readonly passkeyId: string;
  readonly by: PasskeyRevocation;
  readonly now: Date;
}): Promise<{ revoked: true } | { refusal: RevokePasskeyRefusal }> => {
  const rows = await input.db
    .select({
      developerId: passkeys.developerId,
      revokedAt: passkeys.revokedAt,
      usableFrom: passkeys.usableFrom,
    })
    .from(passkeys)
    .where(eq(passkeys.id, input.passkeyId))
    .limit(1);
  const row = rows[0];
  const by = input.by;
  if (row === undefined || (by.kind !== "admin" && row.developerId !== by.developerId)) {
    return { refusal: "unknown_passkey" };
  }
  if (row.revokedAt !== null) {
    return { refusal: "already_revoked" };
  }
  if (by.kind === "owner" && row.usableFrom.getTime() <= input.now.getTime()) {
    return { refusal: "passkey_required" };
  }
  const revokedByKind: PasskeyRevoker = by.kind;
  await input.db
    .update(passkeys)
    .set({
      revokedAt: input.now,
      revokedByKind,
      revokedBy: by.kind === "admin" ? null : by.developerId,
    })
    .where(and(eq(passkeys.id, input.passkeyId), isNull(passkeys.revokedAt)));
  return { revoked: true };
};

/** One passkey as its owner sees it on /ui/passkeys. */
export interface PasskeyView {
  readonly id: string;
  readonly label: string;
  readonly authenticator: string;
  readonly rpId: string;
  readonly createdAt: string;
  readonly usableFrom: string;
  readonly coolingOff: boolean;
  readonly revokedAt: string | null;
}

export const listPasskeys = async (input: {
  readonly db: DbExecutor;
  readonly developerId: string;
  readonly now: Date;
}): Promise<readonly PasskeyView[]> => {
  const rows = await input.db
    .select()
    .from(passkeys)
    .where(eq(passkeys.developerId, input.developerId))
    .orderBy(desc(passkeys.createdAt));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    authenticator: authenticatorName(row.aaguid),
    rpId: row.rpId,
    createdAt: row.createdAt.toISOString(),
    usableFrom: row.usableFrom.toISOString(),
    coolingOff: row.usableFrom.getTime() > input.now.getTime(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
  }));
};

/** One enrolment as the announcement on `status`, `doctor` and the UI reads it (PK-10). */
export interface EnrolmentAnnouncement {
  readonly passkeyId: string;
  readonly developerName: string;
  readonly label: string;
  readonly authenticator: string;
  readonly createdAt: string;
  readonly usableFrom: string;
  readonly coolingOff: boolean;
  readonly revoked: boolean;
}

/**
 * EVERY ENROLMENT SINCE `since`, cool-off included — the cooling-off ones are
 * the point (04a §4.3): they are the ones a person can still revoke before
 * they act. Revoked ones stay listed and say so, so a person who revoked a
 * surprise passkey sees that it took.
 */
export const listRecentEnrolments = async (input: {
  readonly db: DbExecutor;
  readonly since: Date;
  readonly now: Date;
}): Promise<readonly EnrolmentAnnouncement[]> => {
  const rows = await input.db
    .select({
      passkeyId: passkeys.id,
      developerName: developers.name,
      label: passkeys.label,
      aaguid: passkeys.aaguid,
      createdAt: passkeys.createdAt,
      usableFrom: passkeys.usableFrom,
      revokedAt: passkeys.revokedAt,
    })
    .from(passkeys)
    .innerJoin(developers, eq(passkeys.developerId, developers.id))
    .where(gte(passkeys.createdAt, input.since))
    .orderBy(desc(passkeys.createdAt))
    .limit(MAX_RECENT_ENROLMENTS);
  return rows.map((row) => ({
    passkeyId: row.passkeyId,
    developerName: row.developerName,
    label: row.label,
    authenticator: authenticatorName(row.aaguid),
    createdAt: row.createdAt.toISOString(),
    usableFrom: row.usableFrom.toISOString(),
    coolingOff: row.usableFrom.getTime() > input.now.getTime(),
    revoked: row.revokedAt !== null,
  }));
};

/**
 * THE WHOLE WINDOW, COUNTED — what the bounded listing above cannot say. A
 * reader that counted the listed page would miss the 21st enrolment, and a
 * planted passkey only has to arrive in a busy week to be that one.
 */
export const countRecentEnrolments = async (input: {
  readonly db: DbExecutor;
  readonly since: Date;
  readonly now: Date;
}): Promise<{ total: number; coolingOff: number }> => {
  const rows = await input.db
    .select({ usableFrom: passkeys.usableFrom, revokedAt: passkeys.revokedAt })
    .from(passkeys)
    .where(gte(passkeys.createdAt, input.since));
  return {
    total: rows.length,
    coolingOff: rows.filter(
      (row) => row.revokedAt === null && row.usableFrom.getTime() > input.now.getTime(),
    ).length,
  };
};

/** How many passkeys on this hub may sign now — zero means nobody can approve a waiver. */
export const countUsablePasskeys = async (input: {
  readonly db: DbExecutor;
  readonly now: Date;
}): Promise<number> => {
  const rows = await input.db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(and(isNull(passkeys.revokedAt), lte(passkeys.usableFrom, input.now)));
  return rows.length;
};
