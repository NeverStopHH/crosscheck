/**
 * Who may hold a passkey, and when it may act (1.0 spec 04a §4).
 *
 * The ceremony itself is `webauthn.test.ts`'s; here the credential arrives
 * already verified and the questions are the hub's own: was there a valid,
 * unused code for THIS developer, does the new passkey wait out its cool-off,
 * who may revoke it and when, and does the announcement name what enrolled.
 */
import { describe, expect, test } from "bun:test";

import { PASSKEY_COOLOFF_HOURS, ENROLMENT_CODE_TTL_HOURS } from "../src/constants.ts";
import { passkeys } from "../src/db/schema.ts";
import {
  authenticatorName,
  enrolPasskey,
  isEnrolmentCodeValid,
  listRecentEnrolments,
  mintEnrolmentCode,
  revokePasskey,
  usableCredentials,
} from "../src/services/passkeys.ts";
import type { StoredCredential } from "../src/services/webauthn.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const HOUR = 3_600_000;
const NOW = new Date("2026-09-30T12:00:00.000Z");
const ZERO_AAGUID = "00000000-0000-0000-0000-000000000000";
const ICLOUD_KEYCHAIN_AAGUID = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd";

const credential = (id: string, aaguid: string = ZERO_AAGUID): StoredCredential => ({
  id,
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 0,
  transports: ["internal"],
  rpId: "localhost",
  aaguid,
  backedUp: true,
});

const setup = async (): Promise<{
  harness: TestHarness;
  nick: string;
  ken: string;
}> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
  return { harness, nick: nick.developerId, ken: ken.developerId };
};

/** Mint an admin code for `developerId` and enrol one passkey with it at `at`. */
const enrolled = async (
  harness: TestHarness,
  developerId: string,
  credentialId: string,
  at: Date = NOW,
): Promise<string> => {
  const { code } = await mintEnrolmentCode({
    db: harness.db,
    developerId,
    source: "admin",
    now: at,
  });
  const outcome = await enrolPasskey({
    db: harness.db,
    developerId,
    code,
    credential: credential(credentialId),
    label: "MacBook",
    now: at,
  });
  if (!("passkeyId" in outcome)) {
    throw new Error(outcome.refusal);
  }
  return outcome.passkeyId;
};

describe("PK-8: enrolment needs a valid, unused code for the same developer", () => {
  test("a fresh admin code enrols a passkey that waits out the cool-off", async () => {
    // Arrange
    const { harness, nick } = await setup();

    // Act
    const passkeyId = await enrolled(harness, nick, "cred_a");

    // Assert
    const rows = await harness.db.select().from(passkeys);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(passkeyId);
    expect(rows[0]?.enrolledVia).toBe("admin");
    expect(rows[0]?.usableFrom.getTime()).toBe(
      NOW.getTime() + PASSKEY_COOLOFF_HOURS * HOUR,
    );
  });

  test("a code that was already used enrols nothing the second time", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const { code } = await mintEnrolmentCode({
      db: harness.db,
      developerId: nick,
      source: "admin",
      now: NOW,
    });
    await enrolPasskey({
      db: harness.db,
      developerId: nick,
      code,
      credential: credential("cred_a"),
      label: "MacBook",
      now: NOW,
    });

    // Act
    const second = await enrolPasskey({
      db: harness.db,
      developerId: nick,
      code,
      credential: credential("cred_b"),
      label: "Phone",
      now: NOW,
    });

    // Assert
    expect(second).toEqual({ refusal: "code_invalid" });
    expect(await harness.db.select().from(passkeys)).toHaveLength(1);
  });

  test("a code past its lifetime is invalid", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const { code } = await mintEnrolmentCode({
      db: harness.db,
      developerId: nick,
      source: "admin",
      now: NOW,
    });
    const later = new Date(NOW.getTime() + ENROLMENT_CODE_TTL_HOURS * HOUR + 1);

    // Act
    const valid = await isEnrolmentCodeValid({ db: harness.db, developerId: nick, code, now: later });
    const outcome = await enrolPasskey({
      db: harness.db,
      developerId: nick,
      code,
      credential: credential("cred_a"),
      label: "MacBook",
      now: later,
    });

    // Assert
    expect(valid).toBe(false);
    expect(outcome).toEqual({ refusal: "code_invalid" });
  });

  test("a code minted for Ken does not enrol a passkey for Nick", async () => {
    // Arrange — same answer as an unknown code: whether a code exists for
    // somebody else is not this caller's to learn.
    const { harness, nick, ken } = await setup();
    const { code } = await mintEnrolmentCode({
      db: harness.db,
      developerId: ken,
      source: "admin",
      now: NOW,
    });

    // Act
    const outcome = await enrolPasskey({
      db: harness.db,
      developerId: nick,
      code,
      credential: credential("cred_a"),
      label: "MacBook",
      now: NOW,
    });

    // Assert
    expect(outcome).toEqual({ refusal: "code_invalid" });
  });

  test("a code is accepted with or without its dashes and in any case", async () => {
    // Arrange — a person reads it out of a chat message and types it.
    const { harness, nick } = await setup();
    const { code } = await mintEnrolmentCode({
      db: harness.db,
      developerId: nick,
      source: "admin",
      now: NOW,
    });

    // Act
    const valid = await isEnrolmentCodeValid({
      db: harness.db,
      developerId: nick,
      code: code.replaceAll("-", "").toLowerCase(),
      now: NOW,
    });

    // Assert
    expect(valid).toBe(true);
  });
});

describe("PK-7: a passkey in its cool-off cannot act", () => {
  test("it is not usable until usable_from, and is from then on", async () => {
    // Arrange
    const { harness, nick } = await setup();
    await enrolled(harness, nick, "cred_a");

    // Act
    const during = await usableCredentials({ db: harness.db, developerId: nick, now: NOW });
    const after = await usableCredentials({
      db: harness.db,
      developerId: nick,
      now: new Date(NOW.getTime() + PASSKEY_COOLOFF_HOURS * HOUR),
    });

    // Assert
    expect(during).toHaveLength(0);
    expect(after.map((entry) => entry.credential.id)).toEqual(["cred_a"]);
  });

  test("a revoked passkey is never usable again", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const passkeyId = await enrolled(harness, nick, "cred_a");
    await revokePasskey({ db: harness.db, passkeyId, by: { kind: "admin" }, now: NOW });

    // Act
    const usable = await usableCredentials({
      db: harness.db,
      developerId: nick,
      now: new Date(NOW.getTime() + 2 * PASSKEY_COOLOFF_HOURS * HOUR),
    });

    // Assert
    expect(usable).toHaveLength(0);
  });
});

describe("who may revoke a passkey, and when (04a §4.4)", () => {
  test("its owner may revoke it with the api key while it is still cooling off", async () => {
    // Arrange — making a credential LESS capable needs no stronger authority.
    const { harness, nick } = await setup();
    const passkeyId = await enrolled(harness, nick, "cred_a");

    // Act
    const outcome = await revokePasskey({
      db: harness.db,
      passkeyId,
      by: { kind: "owner", developerId: nick },
      now: NOW,
    });

    // Assert
    expect(outcome).toEqual({ revoked: true });
  });

  test("after the cool-off the api key alone may no longer revoke it", async () => {
    // Arrange — otherwise an agent with the key could lock its human out of
    // the one authority it cannot use itself.
    const { harness, nick } = await setup();
    const passkeyId = await enrolled(harness, nick, "cred_a");

    // Act
    const outcome = await revokePasskey({
      db: harness.db,
      passkeyId,
      by: { kind: "owner", developerId: nick },
      now: new Date(NOW.getTime() + PASSKEY_COOLOFF_HOURS * HOUR),
    });

    // Assert
    expect(outcome).toEqual({ refusal: "passkey_required" });
  });

  test("another developer's key cannot revoke it, and hears 'unknown'", async () => {
    // Arrange
    const { harness, nick, ken } = await setup();
    const passkeyId = await enrolled(harness, nick, "cred_a");

    // Act
    const outcome = await revokePasskey({
      db: harness.db,
      passkeyId,
      by: { kind: "owner", developerId: ken },
      now: NOW,
    });

    // Assert
    expect(outcome).toEqual({ refusal: "unknown_passkey" });
  });

  test("the admin may revoke at any time, and a second revocation is refused", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const passkeyId = await enrolled(harness, nick, "cred_a");
    const later = new Date(NOW.getTime() + 3 * PASSKEY_COOLOFF_HOURS * HOUR);

    // Act
    const first = await revokePasskey({ db: harness.db, passkeyId, by: { kind: "admin" }, now: later });
    const second = await revokePasskey({ db: harness.db, passkeyId, by: { kind: "admin" }, now: later });

    // Assert
    expect(first).toEqual({ revoked: true });
    expect(second).toEqual({ refusal: "already_revoked" });
  });
});

describe("PK-10: every enrolment is announced, cool-off included", () => {
  test("the announcement names the developer, the label, the authenticator and when it can act", async () => {
    // Arrange
    const { harness, nick } = await setup();
    await enrolled(harness, nick, "cred_a");

    // Act
    const announced = await listRecentEnrolments({
      db: harness.db,
      since: new Date(NOW.getTime() - HOUR),
      now: NOW,
    });

    // Assert
    expect(announced).toHaveLength(1);
    expect(announced[0]?.developerName).toBe("Nick");
    expect(announced[0]?.label).toBe("MacBook");
    expect(announced[0]?.authenticator).toBe("unknown authenticator");
    expect(announced[0]?.coolingOff).toBe(true);
    expect(announced[0]?.usableFrom).toBe(
      new Date(NOW.getTime() + PASSKEY_COOLOFF_HOURS * HOUR).toISOString(),
    );
  });

  test("a known AAGUID is named, an unknown one says so", () => {
    expect(authenticatorName(ICLOUD_KEYCHAIN_AAGUID)).toBe("iCloud Keychain");
    expect(authenticatorName(ZERO_AAGUID)).toBe("unknown authenticator");
    expect(authenticatorName("12345678-1234-1234-1234-123456789abc")).toBe(
      "unrecognised authenticator 12345678-1234-1234-1234-123456789abc",
    );
  });
});
