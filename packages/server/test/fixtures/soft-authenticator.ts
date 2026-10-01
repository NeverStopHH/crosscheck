/**
 * A SOFTWARE WEBAUTHN AUTHENTICATOR, for tests only (04a §9).
 *
 * This is exactly the capability 04a §8.1 names as the residue: a program can
 * produce valid registration and assertion responses, UV flag included, and
 * the hub cannot tell it from Touch ID. Here it is used the other way round —
 * to prove that the hub's VERIFICATION holds: a wrong challenge, a missing UV
 * flag, a replay, another origin and another developer's credential are each
 * refused even though every byte below is well-formed.
 *
 * What it builds, per the WebAuthn Level 3 wire format:
 *
 *   clientDataJSON    {type, challenge, origin, crossOrigin:false}
 *   authenticatorData rpIdHash(32) · flags(1) · signCount(4 BE)
 *                     [· aaguid(16) · credIdLen(2 BE) · credId · COSE key]
 *   attestationObject CBOR {fmt:"none", attStmt:{}, authData}
 *   signature         ES256 over authenticatorData ‖ SHA-256(clientDataJSON),
 *                     DER-encoded (node:crypto's default for EC keys)
 *
 * ES256 only: it is the algorithm every platform authenticator offers, and
 * one is enough to exercise the verifier.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL = 0x40;
const COSE_KTY_EC2 = 2;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;
const CREDENTIAL_ID_BYTES = 16;
const AAGUID_BYTES = 16;

export interface SoftCredential {
  readonly id: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: { readonly x: string; readonly y: string };
}

export interface SoftAuthenticatorOptions {
  /** Default true. False builds the response a non-verifying key would send. */
  readonly userVerified?: boolean;
  /** The 16-byte AAGUID; default all zero, which is what an emulator sends. */
  readonly aaguid?: Uint8Array;
}

/** `Uint8Array<ArrayBuffer>` throughout: the library's `Uint8Array_`, never a shared-memory view. */
type Bytes = Uint8Array<ArrayBuffer>;

const sha256 = (bytes: Uint8Array | string): Bytes =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

const concat = (...parts: readonly Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const uint32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};

const uint16 = (value: number): Uint8Array => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
};

const flagsOf = (options: SoftAuthenticatorOptions, attested: boolean): number =>
  FLAG_USER_PRESENT |
  (options.userVerified === false ? 0 : FLAG_USER_VERIFIED) |
  (attested ? FLAG_ATTESTED_CREDENTIAL : 0);

const clientData = (type: string, challenge: string, origin: string): Bytes =>
  new Uint8Array(
    new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })),
  );

const coseKey = (credential: SoftCredential): Bytes =>
  isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, COSE_KTY_EC2],
      [3, COSE_ALG_ES256],
      [-1, COSE_CRV_P256],
      [-2, isoBase64URL.toBuffer(credential.publicJwk.x)],
      [-3, isoBase64URL.toBuffer(credential.publicJwk.y)],
    ]),
  );

/** A fresh P-256 credential with a random 16-byte id. */
export const createSoftCredential = (): SoftCredential => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("P-256 public key exported without x/y");
  }
  return {
    id: isoBase64URL.fromBuffer(new Uint8Array(randomBytes(CREDENTIAL_ID_BYTES))),
    privateKey,
    publicJwk: { x: jwk.x, y: jwk.y },
  };
};

/** The registration response a browser would post for `navigator.credentials.create`. */
export const softRegistrationResponse = (input: {
  readonly credential: SoftCredential;
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
  readonly options?: SoftAuthenticatorOptions;
}) => {
  const options = input.options ?? {};
  const credentialId = isoBase64URL.toBuffer(input.credential.id);
  const authData = concat(
    sha256(input.rpId),
    new Uint8Array([flagsOf(options, true)]),
    uint32(0),
    options.aaguid ?? new Uint8Array(AAGUID_BYTES),
    uint16(credentialId.length),
    credentialId,
    coseKey(input.credential),
  );
  const attestationObject = isoCBOR.encode(
    new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]) as never,
  );
  return {
    id: input.credential.id,
    rawId: input.credential.id,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(
        clientData("webauthn.create", input.challenge, input.origin),
      ),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ["internal" as const],
    },
  };
};

/** The assertion a browser would post for `navigator.credentials.get`. */
export const softAuthenticationResponse = (input: {
  readonly credential: SoftCredential;
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
  readonly signCount?: number;
  readonly options?: SoftAuthenticatorOptions;
}) => {
  const options = input.options ?? {};
  const authenticatorData = concat(
    sha256(input.rpId),
    new Uint8Array([flagsOf(options, false)]),
    uint32(input.signCount ?? 0),
  );
  const clientDataJSON = clientData("webauthn.get", input.challenge, input.origin);
  const signature = sign(
    "sha256",
    concat(authenticatorData, sha256(clientDataJSON)),
    input.credential.privateKey,
  );
  return {
    id: input.credential.id,
    rawId: input.credential.id,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
      signature: isoBase64URL.fromBuffer(new Uint8Array(signature)),
    },
  };
};
