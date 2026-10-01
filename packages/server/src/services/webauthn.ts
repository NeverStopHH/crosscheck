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
 * attacker may retry against. A route that refuses BEFORE it reaches verify
 * calls `discard`, so the rule holds there too.
 *
 * BOUND TO ONE BROWSER SESSION. An agent holding the api key can log in as the
 * same developer, so "same developer" cannot tell the person's prompt from the
 * agent's. Each ceremony belongs to the session that minted it; slots are
 * counted per session and, at the developer's cap, taken from whichever OTHER
 * session holds the most — so a person who opens the page always gets a
 * prompt, however many an agent keeps open.
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
 * Neither of the two lower caps ever REFUSES: reaching one evicts an older
 * prompt (see `mint`), because a refusal there is a lockout an agent can hold.
 */
const MAX_PENDING_CEREMONIES = 1024;
const MAX_PENDING_PER_DEVELOPER = 16;
const MAX_PENDING_PER_SESSION = 4;
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

/** Who may finish a ceremony: the developer AND the browser session that asked for it. */
export interface CeremonyOwner {
  readonly developerId: string;
  /** Opaque per UI session (the route hashes the session token); never a secret itself. */
  readonly sessionKey: string;
}

interface PendingCeremony extends CeremonyOwner {
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

/**
 * `localhost` and `*.localhost`: the hostnames a browser treats as a secure
 * context over plain http AND accepts as an RP ID. Anything else needs https,
 * or the browser refuses the ceremony before the hub ever sees it (04a §7).
 */
export const isLocalhostName = (hostname: string): boolean =>
  hostname === "localhost" || hostname.endsWith(".localhost");

/** `127.0.0.1`, `[::1]`, `100.64.0.7` — `URL` has already normalised the spelling. */
const isIpLiteral = (hostname: string): boolean =>
  hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);

const isSecureContextOrigin = (url: URL): boolean =>
  url.protocol === "https:" || (url.protocol === "http:" && isLocalhostName(url.hostname));

/**
 * A browser's `clientDataJSON` says whether the ceremony ran inside a frame
 * from another origin. The library accepts `crossOrigin: true` without a
 * `topOrigin`; a crosscheck ceremony only ever runs on the hub's own page, so
 * any other answer — or one that does not parse — is refused.
 */
const isCrossOrigin = (clientDataJSON: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(isoBase64URL.toBuffer(clientDataJSON)),
    );
    if (typeof parsed !== "object" || parsed === null) {
      return true;
    }
    // Absent is what browsers from before the field send: same-origin.
    return "crossOrigin" in parsed && parsed.crossOrigin !== false;
  } catch {
    return true;
  }
};

/**
 * `CROSSCHECK_WEBAUTHN_ORIGINS`, read once at startup (04a §7).
 *
 * Unset means the hub's own `http://localhost:<port>`, which a browser on the
 * hub's machine treats as secure. Every entry is checked HERE, because the
 * failure it prevents happens later and in front of a person: a tailnet
 * `http://100.x…` origin is not a secure context, and the browser would
 * refuse every ceremony there with no reason the hub could print.
 */
export const parseWebAuthnOrigins = (raw: string | undefined, port: number): readonly string[] => {
  if (raw === undefined || raw.trim() === "") {
    return [`http://localhost:${String(port)}`];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw new Error(
          `CROSSCHECK_WEBAUTHN_ORIGINS: "${entry}" is not a URL — list origins like https://hub.tailnet.ts.net`,
        );
      }
      if (isIpLiteral(url.hostname)) {
        throw new Error(
          `CROSSCHECK_WEBAUTHN_ORIGINS: browsers refuse passkeys at an IP address (${url.origin}) — ` +
            "use http://localhost on the hub's machine, or an https hostname such as `tailscale serve` gives",
        );
      }
      if (!isSecureContextOrigin(url)) {
        throw new Error(
          `CROSSCHECK_WEBAUTHN_ORIGINS: browsers refuse passkeys at ${url.origin} (plain http off localhost) — ` +
            "put the hub behind https, for example with `tailscale serve`, and list that https origin",
        );
      }
      return url.origin;
    });
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

  /** The oldest pending ceremony among `ids` — Map order is insertion order. */
  const oldestOf = (ids: readonly string[]): string | undefined => ids[0];

  /**
   * Make room for one more of `owner`'s ceremonies by evicting, never by
   * refusing: first the session's own oldest at its cap, then — at the
   * developer's cap — the oldest of the OTHER session holding the most.
   */
  const makeRoom = (owner: CeremonyOwner): void => {
    const byDeveloper = [...pending.entries()].filter(
      ([, entry]) => entry.developerId === owner.developerId,
    );
    const ownSession = byDeveloper
      .filter(([, entry]) => entry.sessionKey === owner.sessionKey)
      .map(([id]) => id);
    if (ownSession.length >= MAX_PENDING_PER_SESSION) {
      const evicted = oldestOf(ownSession);
      if (evicted !== undefined) {
        pending.delete(evicted);
      }
      return;
    }
    if (byDeveloper.length < MAX_PENDING_PER_DEVELOPER) {
      return;
    }
    const others = new Map<string, string[]>();
    for (const [id, entry] of byDeveloper) {
      if (entry.sessionKey !== owner.sessionKey) {
        others.set(entry.sessionKey, [...(others.get(entry.sessionKey) ?? []), id]);
      }
    }
    const fullest = [...others.values()].reduce<string[]>(
      (most, ids) => (ids.length > most.length ? ids : most),
      [],
    );
    const evicted = oldestOf(fullest);
    if (evicted !== undefined) {
      pending.delete(evicted);
    }
  };

  const mint = (
    ceremony: Omit<PendingCeremony, "nonce" | "expiresAtMs">,
  ): { id: string; nonce: Uint8Array } | { refusal: WebAuthnRefusal } => {
    const nowMs = config.nowMs();
    purgeExpired(nowMs);
    makeRoom(ceremony);
    if (pending.size >= MAX_PENDING_CEREMONIES) {
      return { refusal: "too_many_ceremonies" };
    }
    const id = randomUUID();
    const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
    pending.set(id, { ...ceremony, nonce, expiresAtMs: nowMs + CEREMONY_TTL_MS });
    return { id, nonce };
  };

  const isOwnedBy = (ceremony: PendingCeremony, owner: CeremonyOwner): boolean =>
    ceremony.developerId === owner.developerId && ceremony.sessionKey === owner.sessionKey;

  /**
   * Removes the ceremony FIRST, then judges it: single use even on failure.
   * Except for a caller who does not own it — another session spending the
   * person's prompt by guessing at it would be a lockout of its own.
   */
  const take = (
    id: string,
    expected: CeremonyOwner & Pick<PendingCeremony, "purpose" | "subject">,
  ): PendingCeremony | { refusal: WebAuthnRefusal } => {
    const ceremony = pending.get(id);
    if (ceremony === undefined) {
      return { refusal: "unknown_ceremony" };
    }
    if (!isOwnedBy(ceremony, expected)) {
      return { refusal: "wrong_ceremony" };
    }
    pending.delete(id);
    if (ceremony.expiresAtMs <= config.nowMs()) {
      return { refusal: "ceremony_expired" };
    }
    if (ceremony.purpose !== expected.purpose || ceremony.subject !== expected.subject) {
      return { refusal: "wrong_ceremony" };
    }
    return ceremony;
  };

  /** Spend a ceremony the route refused before verifying it — its owner's only. */
  const discard = (input: CeremonyOwner & { readonly ceremonyId: string }): void => {
    const ceremony = pending.get(input.ceremonyId);
    if (ceremony !== undefined && isOwnedBy(ceremony, input)) {
      pending.delete(input.ceremonyId);
    }
  };

  const registrationOptions = async (
    input: CeremonyOwner & {
      readonly userName: string;
      readonly origin: string;
      readonly existing: readonly StoredCredential[];
    },
  ): Promise<
    | { ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }
    | { refusal: WebAuthnRefusal }
  > => {
    const rpId = rpIdByOrigin.get(input.origin);
    if (rpId === undefined) {
      return { refusal: "origin_not_configured" };
    }
    const minted = mint({
      developerId: input.developerId,
      sessionKey: input.sessionKey,
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

  const verifyRegistration = async (
    input: CeremonyOwner & {
      readonly ceremonyId: string;
      readonly response: RegistrationResponseJSON;
    },
  ): Promise<{ credential: StoredCredential } | { refusal: WebAuthnRefusal }> => {
    const ceremony = take(input.ceremonyId, {
      developerId: input.developerId,
      sessionKey: input.sessionKey,
      purpose: "enrol",
      subject: input.developerId,
    });
    if ("refusal" in ceremony) {
      return ceremony;
    }
    if (isCrossOrigin(input.response.response.clientDataJSON)) {
      return { refusal: "response_rejected" };
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

  const authenticationOptions = async (
    input: CeremonyOwner & {
      readonly purpose: CeremonyPurpose;
      readonly subject: string;
      readonly terms: CeremonyTerms;
      readonly origin: string;
      readonly credentials: readonly StoredCredential[];
    },
  ): Promise<
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
      sessionKey: input.sessionKey,
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

  const verifyAssertion = async (
    input: CeremonyOwner & {
      readonly ceremonyId: string;
      readonly purpose: CeremonyPurpose;
      readonly subject: string;
      readonly terms: CeremonyTerms;
      readonly credential: StoredCredential;
      readonly response: AuthenticationResponseJSON;
    },
  ): Promise<{ newCounter: number } | { refusal: WebAuthnRefusal }> => {
    const ceremony = take(input.ceremonyId, input);
    if ("refusal" in ceremony) {
      return ceremony;
    }
    if (input.response.id !== input.credential.id || input.credential.rpId !== ceremony.rpId) {
      return { refusal: "wrong_ceremony" };
    }
    if (isCrossOrigin(input.response.response.clientDataJSON)) {
      return { refusal: "response_rejected" };
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
    discard,
    isConfiguredOrigin: (origin: string): boolean => rpIdByOrigin.has(origin),
  };
};

export type WebAuthn = ReturnType<typeof createWebAuthn>;
