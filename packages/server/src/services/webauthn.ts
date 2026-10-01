/**
 * THE WEBAUTHN CORE (1.0 spec 04a §5): ceremonies, and the one property that
 * makes an approval mean something — a signature that verifies over EXACTLY
 * the terms the person was shown, once, for one purpose, by one developer.
 *
 * THE TERMS ARE INSIDE THE CHALLENGE. A challenge is `nonce ‖ SHA-256(purpose,
 * subject, terms)`; the nonce stays in hub memory, the terms come back with
 * the submission and the expected challenge is RECOMPUTED from them. So an
 * expiry or a reason changed between "show" and "sign" does not need a second
 * check that somebody could forget — the authenticator's signature itself no
 * longer verifies, and the library refuses it.
 *
 * SINGLE USE, EVEN ON FAILURE. A verify attempt removes the ceremony before
 * anything is checked: a ceremony that survived a failed attempt is a nonce an
 * attacker may retry against.
 *
 * NOTHING SECRET AT REST. Pending ceremonies live in this closure; a hub
 * restart drops them and the person presses the button again — the trade
 * ui/session.ts already makes for the cookie secret.
 *
 * The verification is `@simplewebauthn/server` (MIT): CBOR, COSE and
 * signature formats are a place to use a library many people have attacked,
 * never a place to hand-roll. This module decides WHAT is verified; the
 * library decides WHETHER the bytes say it.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

/** How long a person has between "show me" and "I signed" — 04a §5. */
export const CEREMONY_TTL_MS = 5 * 60_000;

/**
 * Bounds on what one hub holds in memory. A signed-in member can mint
 * ceremonies without finishing them; without a cap that is unbounded memory,
 * and without a per-developer cap one member's stuck tab locks out the rest.
 */
const MAX_PENDING_CEREMONIES = 1024;
const MAX_PENDING_PER_DEVELOPER = 8;
const NONCE_BYTES = 16;
const RP_NAME = "crosscheck";

export type CeremonyPurpose =
  | "enrol"
  | "authorise_enrolment"
  | "approve"
  | "amend"
  | "revoke_waiver"
  | "revoke_passkey";

/** What a ceremony signs. Flat, so canonicalisation is a key sort. */
export type CeremonyTerms = Readonly<Record<string, string | number>>;

/** A credential as the hub keeps it — everything verification needs. */
export interface StoredCredential {
  readonly id: string;
  /** `Uint8Array<ArrayBuffer>`, the library's own `Uint8Array_`: never a view on shared memory. */
  readonly publicKey: Uint8Array<ArrayBuffer>;
  readonly counter: number;
  readonly transports: readonly string[];
  readonly rpId: string;
  readonly aaguid: string;
  readonly backedUp: boolean;
}

export type WebAuthnRefusal =
  | "origin_not_configured"
  | "no_passkey_for_origin"
  | "too_many_ceremonies"
  | "unknown_ceremony"
  | "ceremony_expired"
  | "wrong_ceremony"
  | "response_rejected";

interface PendingCeremony {
  readonly developerId: string;
  readonly purpose: CeremonyPurpose;
  readonly subject: string;
  readonly nonce: Uint8Array;
  readonly origin: string;
  readonly rpId: string;
  readonly expiresAtMs: number;
}

export interface WebAuthnConfig {
  /** Accepted origins, e.g. `http://localhost:7100`; each one's hostname is its RP ID. */
  readonly origins: readonly string[];
  readonly nowMs: () => number;
}

const sha256 = (input: Uint8Array | string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(createHash("sha256").update(input).digest());

const canonicalTerms = (terms: CeremonyTerms): string =>
  JSON.stringify(Object.keys(terms).sort().map((key) => [key, terms[key]]));

/** `nonce ‖ SHA-256(purpose, subject, terms)` as the base64url a browser echoes back. */
const challengeOf = (
  nonce: Uint8Array,
  purpose: CeremonyPurpose,
  subject: string,
  terms: CeremonyTerms,
): string => {
  const digest = sha256(JSON.stringify([purpose, subject, canonicalTerms(terms)]));
  const bytes = new Uint8Array(nonce.length + digest.length);
  bytes.set(nonce, 0);
  bytes.set(digest, nonce.length);
  return isoBase64URL.fromBuffer(bytes);
};

/** Origins normalised once; a malformed entry is a startup error, never a silent skip. */
const normaliseOrigins = (origins: readonly string[]): ReadonlyMap<string, string> =>
  new Map(
    origins.map((raw) => {
      const url = new URL(raw);
      return [url.origin, url.hostname] as const;
    }),
  );

const NO_TERMS: CeremonyTerms = {};

export const createWebAuthn = (config: WebAuthnConfig) => {
  const rpIdByOrigin = normaliseOrigins(config.origins);
  const pending = new Map<string, PendingCeremony>();

  const purgeExpired = (nowMs: number): void => {
    for (const [id, ceremony] of pending) {
      if (ceremony.expiresAtMs <= nowMs) {
        pending.delete(id);
      }
    }
  };

  const mint = (
    ceremony: Omit<PendingCeremony, "nonce" | "expiresAtMs">,
  ): { id: string; nonce: Uint8Array } | { refusal: WebAuthnRefusal } => {
    const nowMs = config.nowMs();
    purgeExpired(nowMs);
    const mine = [...pending.values()].filter(
      (entry) => entry.developerId === ceremony.developerId,
    ).length;
    if (pending.size >= MAX_PENDING_CEREMONIES || mine >= MAX_PENDING_PER_DEVELOPER) {
      return { refusal: "too_many_ceremonies" };
    }
    const id = randomUUID();
    const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
    pending.set(id, { ...ceremony, nonce, expiresAtMs: nowMs + CEREMONY_TTL_MS });
    return { id, nonce };
  };

  /** Removes the ceremony FIRST, then judges it: single use even on failure. */
  const take = (
    id: string,
    expected: Pick<PendingCeremony, "developerId" | "purpose" | "subject">,
  ): PendingCeremony | { refusal: WebAuthnRefusal } => {
    const ceremony = pending.get(id);
    pending.delete(id);
    if (ceremony === undefined) {
      return { refusal: "unknown_ceremony" };
    }
    if (ceremony.expiresAtMs <= config.nowMs()) {
      return { refusal: "ceremony_expired" };
    }
    if (
      ceremony.developerId !== expected.developerId ||
      ceremony.purpose !== expected.purpose ||
      ceremony.subject !== expected.subject
    ) {
      return { refusal: "wrong_ceremony" };
    }
    return ceremony;
  };

  const registrationOptions = async (input: {
    readonly developerId: string;
    readonly userName: string;
    readonly origin: string;
    readonly existing: readonly StoredCredential[];
  }): Promise<
    | { ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }
    | { refusal: WebAuthnRefusal }
  > => {
    const rpId = rpIdByOrigin.get(input.origin);
    if (rpId === undefined) {
      return { refusal: "origin_not_configured" };
    }
    const minted = mint({
      developerId: input.developerId,
      purpose: "enrol",
      subject: input.developerId,
      origin: input.origin,
      rpId,
    });
    if ("refusal" in minted) {
      return minted;
    }
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId,
      userName: input.userName,
      // Opaque and stable: the authenticator stores it, so it must not be
      // anything a person would mind a device remembering.
      userID: sha256(input.developerId),
      challenge: isoBase64URL.toBuffer(
        challengeOf(minted.nonce, "enrol", input.developerId, NO_TERMS),
      ),
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      excludeCredentials: input.existing
        .filter((credential) => credential.rpId === rpId)
        .map((credential) => ({ id: credential.id, transports: [...credential.transports] })),
    });
    return { ceremonyId: minted.id, options };
  };

  const verifyRegistration = async (input: {
    readonly ceremonyId: string;
    readonly developerId: string;
    readonly response: RegistrationResponseJSON;
  }): Promise<{ credential: StoredCredential } | { refusal: WebAuthnRefusal }> => {
    const ceremony = take(input.ceremonyId, {
      developerId: input.developerId,
      purpose: "enrol",
      subject: input.developerId,
    });
    if ("refusal" in ceremony) {
      return ceremony;
    }
    try {
      const verified = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: challengeOf(ceremony.nonce, "enrol", input.developerId, NO_TERMS),
        expectedOrigin: ceremony.origin,
        expectedRPID: ceremony.rpId,
        requireUserVerification: true,
      });
      if (!verified.verified) {
        return { refusal: "response_rejected" };
      }
      const info = verified.registrationInfo;
      return {
        credential: {
          id: info.credential.id,
          publicKey: info.credential.publicKey,
          counter: info.credential.counter,
          transports: info.credential.transports ?? [],
          rpId: ceremony.rpId,
          aaguid: info.aaguid,
          backedUp: info.credentialBackedUp,
        },
      };
    } catch {
      // The library throws a sentence per failed check. It is not echoed:
      // a refusal names THAT the response did not verify, and the hub does
      // not teach a forger which check to fix next.
      return { refusal: "response_rejected" };
    }
  };

  const authenticationOptions = async (input: {
    readonly developerId: string;
    readonly purpose: CeremonyPurpose;
    readonly subject: string;
    readonly terms: CeremonyTerms;
    readonly origin: string;
    readonly credentials: readonly StoredCredential[];
  }): Promise<
    | { ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }
    | { refusal: WebAuthnRefusal }
  > => {
    const rpId = rpIdByOrigin.get(input.origin);
    if (rpId === undefined) {
      return { refusal: "origin_not_configured" };
    }
    const usable = input.credentials.filter((credential) => credential.rpId === rpId);
    if (usable.length === 0) {
      return { refusal: "no_passkey_for_origin" };
    }
    const minted = mint({
      developerId: input.developerId,
      purpose: input.purpose,
      subject: input.subject,
      origin: input.origin,
      rpId,
    });
    if ("refusal" in minted) {
      return minted;
    }
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      challenge: isoBase64URL.toBuffer(
        challengeOf(minted.nonce, input.purpose, input.subject, input.terms),
      ),
      userVerification: "required",
      allowCredentials: usable.map((credential) => ({
        id: credential.id,
        transports: [...credential.transports],
      })),
    });
    return { ceremonyId: minted.id, options };
  };

  const verifyAssertion = async (input: {
    readonly ceremonyId: string;
    readonly developerId: string;
    readonly purpose: CeremonyPurpose;
    readonly subject: string;
    readonly terms: CeremonyTerms;
    readonly credential: StoredCredential;
    readonly response: AuthenticationResponseJSON;
  }): Promise<{ newCounter: number } | { refusal: WebAuthnRefusal }> => {
    const ceremony = take(input.ceremonyId, input);
    if ("refusal" in ceremony) {
      return ceremony;
    }
    if (input.response.id !== input.credential.id || input.credential.rpId !== ceremony.rpId) {
      return { refusal: "wrong_ceremony" };
    }
    try {
      const verified = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: challengeOf(ceremony.nonce, input.purpose, input.subject, input.terms),
        expectedOrigin: ceremony.origin,
        expectedRPID: ceremony.rpId,
        credential: {
          id: input.credential.id,
          publicKey: input.credential.publicKey,
          counter: input.credential.counter,
          transports: [...input.credential.transports],
        },
        requireUserVerification: true,
      });
      return verified.verified
        ? { newCounter: verified.authenticationInfo.newCounter }
        : { refusal: "response_rejected" };
    } catch {
      return { refusal: "response_rejected" };
    }
  };

  return {
    registrationOptions,
    verifyRegistration,
    authenticationOptions,
    verifyAssertion,
    isConfiguredOrigin: (origin: string): boolean => rpIdByOrigin.has(origin),
  };
};

export type WebAuthn = ReturnType<typeof createWebAuthn>;
