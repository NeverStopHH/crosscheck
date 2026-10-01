/**
 * The WebAuthn core (04a §5): one ceremony, one developer, one purpose, one
 * set of terms, once, for five minutes — and a signature that only verifies
 * over exactly those terms.
 *
 * Driven with the software authenticator in fixtures/, which produces
 * well-formed responses on purpose: every refusal below is the VERIFIER's,
 * not a malformed byte the parser happened to choke on.
 */
import { describe, expect, test } from "bun:test";

import { CEREMONY_TTL_MS, createWebAuthn } from "../src/services/webauthn.ts";
import type { CeremonyTerms, StoredCredential } from "../src/services/webauthn.ts";
import {
  createSoftCredential,
  softAuthenticationResponse,
  softRegistrationResponse,
} from "./fixtures/soft-authenticator.ts";
import type { SoftCredential } from "./fixtures/soft-authenticator.ts";

const ORIGIN = "http://localhost:7100";
const RP_ID = "localhost";
const NICK = "dev_nick";
const KEN = "dev_ken";
const START_MS = Date.parse("2026-09-30T12:00:00.000Z");
const TERMS: CeremonyTerms = {
  pinId: "pin_fence",
  pinVersion: 1,
  expiresAt: "2026-10-02T12:00:00.000Z",
  reasonDigest: "3f2a",
};

const setup = (origins: readonly string[] = [ORIGIN]) => {
  let nowMs = START_MS;
  const webauthn = createWebAuthn({ origins, nowMs: () => nowMs });
  return {
    webauthn,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
};

/** Enrol `credential` for `developerId` and hand back what the hub stored. */
const enrol = async (
  webauthn: ReturnType<typeof createWebAuthn>,
  credential: SoftCredential,
  developerId: string = NICK,
): Promise<StoredCredential> => {
  const options = await webauthn.registrationOptions({
    developerId,
    userName: developerId,
    origin: ORIGIN,
    existing: [],
  });
  if ("refusal" in options) {
    throw new Error(options.refusal);
  }
  const outcome = await webauthn.verifyRegistration({
    ceremonyId: options.ceremonyId,
    developerId,
    response: softRegistrationResponse({
      credential,
      challenge: options.options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    }),
  });
  if ("refusal" in outcome) {
    throw new Error(outcome.refusal);
  }
  return outcome.credential;
};

const approveOptions = async (
  webauthn: ReturnType<typeof createWebAuthn>,
  stored: StoredCredential,
  terms: CeremonyTerms = TERMS,
  developerId: string = NICK,
) => {
  const options = await webauthn.authenticationOptions({
    developerId,
    purpose: "approve",
    subject: "wr_1",
    terms,
    origin: ORIGIN,
    credentials: [stored],
  });
  if ("refusal" in options) {
    throw new Error(options.refusal);
  }
  return options;
};

describe("enrolment", () => {
  test("a well-formed registration yields the credential the hub stores", async () => {
    // Arrange
    const { webauthn } = setup();

    // Act
    const stored = await enrol(webauthn, createSoftCredential());

    // Assert
    expect(stored.rpId).toBe(RP_ID);
    expect(stored.counter).toBe(0);
    expect(stored.publicKey.length).toBeGreaterThan(0);
    // An emulator sends the all-zero AAGUID; 04a §4.3 shows it, never gates on it.
    expect(stored.aaguid).toBe("00000000-0000-0000-0000-000000000000");
  });

  test("an origin the hub was not configured for is refused before any ceremony", async () => {
    // Arrange
    const { webauthn } = setup();

    // Act
    const options = await webauthn.registrationOptions({
      developerId: NICK,
      userName: NICK,
      origin: "http://100.64.0.7:7100",
      existing: [],
    });

    // Assert
    expect(options).toEqual({ refusal: "origin_not_configured" });
  });

  test("a registration without user verification is refused", async () => {
    // Arrange
    const { webauthn } = setup();
    const credential = createSoftCredential();
    const options = await webauthn.registrationOptions({
      developerId: NICK,
      userName: NICK,
      origin: ORIGIN,
      existing: [],
    });
    if ("refusal" in options) throw new Error(options.refusal);

    // Act
    const outcome = await webauthn.verifyRegistration({
      ceremonyId: options.ceremonyId,
      developerId: NICK,
      response: softRegistrationResponse({
        credential,
        challenge: options.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
        options: { userVerified: false },
      }),
    });

    // Assert
    expect(outcome).toEqual({ refusal: "response_rejected" });
  });
});

describe("an assertion signs exactly one set of terms, once", () => {
  test("PK-3: the terms the options were minted for verify", async () => {
    // Arrange
    const { webauthn } = setup();
    const credential = createSoftCredential();
    const stored = await enrol(webauthn, credential);
    const options = await approveOptions(webauthn, stored);

    // Act
    const outcome = await webauthn.verifyAssertion({
      ceremonyId: options.ceremonyId,
      developerId: NICK,
      purpose: "approve",
      subject: "wr_1",
      terms: TERMS,
      credential: stored,
      response: softAuthenticationResponse({
        credential,
        challenge: options.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
        signCount: 1,
      }),
    });

    // Assert
    expect(outcome).toEqual({ newCounter: 1 });
  });

  test("PK-4: an expiry changed after the options were issued is refused", async () => {
    // Arrange — the person was shown one expiry and signed; the body asks for another.
    const { webauthn } = setup();
    const credential = createSoftCredential();
    const stored = await enrol(webauthn, credential);
    const options = await approveOptions(webauthn, stored);

    // Act
    const outcome = await webauthn.verifyAssertion({
      ceremonyId: options.ceremonyId,
      developerId: NICK,
      purpose: "approve",
      subject: "wr_1",
      terms: { ...TERMS, expiresAt: "2026-10-14T12:00:00.000Z" },
      credential: stored,
      response: softAuthenticationResponse({
        credential,
        challenge: options.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
      }),
    });

    // Assert
    expect(outcome).toEqual({ refusal: "response_rejected" });
  });

  test("PK-5: the same assertion a second time is refused", async () => {
    // Arrange
    const { webauthn } = setup();
    const credential = createSoftCredential();
    const stored = await enrol(webauthn, credential);
    const options = await approveOptions(webauthn, stored);
    const response = softAuthenticationResponse({
      credential,
      challenge: options.options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
      signCount: 1,
    });
    const verify = () =>
      webauthn.verifyAssertion({
        ceremonyId: options.ceremonyId,
        developerId: NICK,
        purpose: "approve",
        subject: "wr_1",
        terms: TERMS,
        credential: stored,
        response,
      });

    // Act
    const first = await verify();
    const replay = await verify();

    // Assert
    expect(first).toEqual({ newCounter: 1 });
    expect(replay).toEqual({ refusal: "unknown_ceremony" });
  });

  test("PK-6: an assertion without user verification is refused", async () => {
    // Arrange
    const { webauthn } = setup();
    const credential = createSoftCredential();
    const stored = await enrol(webauthn, credential);
    const options = await approveOptions(webauthn, stored);

    // Act
    const outcome = await webauthn.verifyAssertion({
      ceremonyId: options.ceremonyId,
      developerId: NICK,
      purpose: "approve",
      subject: "wr_1",
      terms: TERMS,
      credential: stored,
      response: softAuthenticationResponse({
        credential,
        challenge: options.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
        options: { userVerified: false },
      }),
    });

    // Assert
    expect(outcome).toEqual({ refusal: "response_rejected" });
  });

  test("a ceremony older than its lifetime is refused", async () => {
    // Arrange
    const { webauthn, advance } = setup();
    const credential = createSoftCredential();
    const stored = await enrol(webauthn, credential);
    const options = await approveOptions(webauthn, stored);
    advance(CEREMONY_TTL_MS + 1);

    // Act
    const outcome = await webauthn.verifyAssertion({
      ceremonyId: options.ceremonyId,
      developerId: NICK,
      purpose: "approve",
      subject: "wr_1",
      terms: TERMS,
      credential: stored,
      response: softAuthenticationResponse({
        credential,
        challenge: options.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
      }),
    });

    // Assert
    expect(outcome).toEqual({ refusal: "ceremony_expired" });
  });

  test("a ceremony minted for one developer cannot be finished by another", async () => {
    // Arrange
    const { webauthn } = setup();
    const credential = createSoftCredential();
    const stored = await enrol(webauthn, credential);
    const options = await approveOptions(webauthn, stored);

    // Act
    const outcome = await webauthn.verifyAssertion({
      ceremonyId: options.ceremonyId,
      developerId: KEN,
      purpose: "approve",
      subject: "wr_1",
      terms: TERMS,
      credential: stored,
      response: softAuthenticationResponse({
        credential,
        challenge: options.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
      }),
    });

    // Assert
    expect(outcome).toEqual({ refusal: "wrong_ceremony" });
  });

  test("a ceremony minted to approve cannot be spent on a revocation", async () => {
    // Arrange
    const { webauthn } = setup();
    const credential = createSoftCredential();
    const stored = await enrol(webauthn, credential);
    const options = await approveOptions(webauthn, stored);

    // Act
    const outcome = await webauthn.verifyAssertion({
      ceremonyId: options.ceremonyId,
      developerId: NICK,
      purpose: "revoke_waiver",
      subject: "wr_1",
      terms: TERMS,
      credential: stored,
      response: softAuthenticationResponse({
        credential,
        challenge: options.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
      }),
    });

    // Assert
    expect(outcome).toEqual({ refusal: "wrong_ceremony" });
  });

  test("an assertion made at another origin is refused", async () => {
    // Arrange — both origins configured; the ceremony was minted for one.
    const { webauthn } = setup([ORIGIN, "https://hub.tailnet.ts.net"]);
    const credential = createSoftCredential();
    const stored = await enrol(webauthn, credential);
    const options = await approveOptions(webauthn, stored);

    // Act
    const outcome = await webauthn.verifyAssertion({
      ceremonyId: options.ceremonyId,
      developerId: NICK,
      purpose: "approve",
      subject: "wr_1",
      terms: TERMS,
      credential: stored,
      response: softAuthenticationResponse({
        credential,
        challenge: options.options.challenge,
        origin: "https://hub.tailnet.ts.net",
        rpId: RP_ID,
      }),
    });

    // Assert
    expect(outcome).toEqual({ refusal: "response_rejected" });
  });

  test("a signature counter that went backwards is refused as a cloned key", async () => {
    // Arrange
    const { webauthn } = setup();
    const credential = createSoftCredential();
    const stored = { ...(await enrol(webauthn, credential)), counter: 7 };
    const options = await approveOptions(webauthn, stored);

    // Act
    const outcome = await webauthn.verifyAssertion({
      ceremonyId: options.ceremonyId,
      developerId: NICK,
      purpose: "approve",
      subject: "wr_1",
      terms: TERMS,
      credential: stored,
      response: softAuthenticationResponse({
        credential,
        challenge: options.options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
        signCount: 3,
      }),
    });

    // Assert
    expect(outcome).toEqual({ refusal: "response_rejected" });
  });

  test("a credential enrolled under another RP ID is not offered for this origin", async () => {
    // Arrange — 04a §7: a passkey is bound to the RP ID it was enrolled under.
    const { webauthn } = setup([ORIGIN, "https://hub.tailnet.ts.net"]);
    const stored = await enrol(webauthn, createSoftCredential());

    // Act
    const options = await webauthn.authenticationOptions({
      developerId: NICK,
      purpose: "approve",
      subject: "wr_1",
      terms: TERMS,
      origin: "https://hub.tailnet.ts.net",
      credentials: [stored],
    });

    // Assert
    expect(options).toEqual({ refusal: "no_passkey_for_origin" });
  });
});
