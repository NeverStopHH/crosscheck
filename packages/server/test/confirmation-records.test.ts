/**
 * A CONFIRMATION CAN BE CHECKED WITHOUT THE HUB (human provenance §6). The
 * person's own confirmations are served with the assertion that made them;
 * the verifier below re-derives, from that answer alone and the documented
 * algorithm (services/confirmation-records.ts), the draft digests, the batch
 * digest, the challenge the batch was bound to, and the signature — and a
 * tampered item no longer verifies. It never imports the hub's own digests.
 */
import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

import { confirmPending, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import { KEN_CLAIM, KEN_CONTEXT, NICK_SESSION, createOutcomeWorld, recordOutcome } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest } from "./helpers.ts";
import type { TestDeveloper } from "./helpers.ts";

interface Item {
  readonly position: number;
  readonly decision: string;
  readonly content: Record<string, unknown>;
  readonly draftDigest: string;
  readonly draft: {
    readonly id: string;
    readonly kind: string;
    readonly subjectKey: string;
    readonly version: number;
    readonly provenance: string;
    readonly payload: Record<string, unknown>;
  };
}

interface ConfirmationRecord {
  readonly id: string;
  readonly digest: string;
  readonly pendingFingerprint: string;
  readonly rpId: string;
  readonly credential: { readonly id: string; readonly publicKey: string };
  readonly assertion: {
    readonly authenticatorData: string;
    readonly clientDataJSON: string;
    readonly signature: string;
    readonly userHandle: string | null;
  };
  readonly challenge: { readonly purpose: string; readonly subject: string; readonly terms: Record<string, string> };
  readonly items: readonly Item[];
}

/** The documented canonical JSON: object keys sorted, nothing else — written here, never imported. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Everything a client checks, from the route's answer alone. Throws on the first thing that does not hold. */
const verifyLocally = async (record: ConfirmationRecord): Promise<void> => {
  for (const item of record.items) {
    const { draft } = item;
    if (sha256Hex(canonical([draft.id, draft.kind, draft.subjectKey, draft.version, draft.provenance, draft.payload])) !== item.draftDigest) {
      throw new Error(`draft digest of ${draft.id} does not match`);
    }
  }
  const digest = sha256Hex(
    canonical([
      record.pendingFingerprint,
      record.items.map((item) => [item.draft.id, item.draft.version, item.draftDigest, item.decision, item.content]),
    ]),
  );
  if (digest !== record.digest || record.challenge.terms["batchDigest"] !== digest) {
    throw new Error("the batch digest does not match its items");
  }
  const clientData = JSON.parse(new TextDecoder().decode(isoBase64URL.toBuffer(record.assertion.clientDataJSON))) as {
    readonly challenge: string;
    readonly origin: string;
  };
  const challenge = isoBase64URL.toBuffer(clientData.challenge);
  const terms = Object.keys(record.challenge.terms)
    .sort()
    .map((key) => [key, record.challenge.terms[key]]);
  const bound = createHash("sha256")
    .update(JSON.stringify([record.challenge.purpose, record.challenge.subject, JSON.stringify(terms)]))
    .digest();
  if (Buffer.compare(Buffer.from(challenge.slice(challenge.length - bound.length)), bound) !== 0) {
    throw new Error("the challenge was not bound to this batch");
  }
  const verified = await verifyAuthenticationResponse({
    response: {
      id: record.credential.id,
      rawId: record.credential.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        authenticatorData: record.assertion.authenticatorData,
        clientDataJSON: record.assertion.clientDataJSON,
        signature: record.assertion.signature,
        ...(record.assertion.userHandle === null ? {} : { userHandle: record.assertion.userHandle }),
      },
    },
    expectedChallenge: clientData.challenge,
    expectedOrigin: clientData.origin,
    expectedRPID: record.rpId,
    credential: { id: record.credential.id, publicKey: isoBase64URL.toBuffer(record.credential.publicKey), counter: 0 },
    requireUserVerification: true,
  });
  if (!verified.verified) {
    throw new Error("the signature does not verify");
  }
};

const confirmationsOf = async (world: OutcomeWorld, developer: TestDeveloper): Promise<readonly ConfirmationRecord[]> => {
  const response = await world.harness.app.request("/api/confirm/confirmations", jsonRequest("GET", developer.apiKey));
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { confirmations: ConfirmationRecord[] } }).data.confirmations;
};

const confirmedWorld = async (): Promise<OutcomeWorld> => {
  const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
  await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION });
  await recordOutcome(world, world.nick, { ref: KEN_CLAIM, outcome: "not_relevant_now", session: NICK_SESSION });
  const confirmer = await prepareConfirmer(world.harness, world.nick);
  const verified = await confirmPending(world.harness, world.nick, confirmer, (draft) =>
    draft.payload["refId"] === KEN_CONTEXT
      ? { decision: "confirm", word: "overrode", reason: "kept the retry on the hub" }
      : { decision: "discard" },
  );
  expect(verified.status).toBe(200);
  return world;
};

describe("GET /api/confirm/confirmations", () => {
  test("serves the caller's confirmation with its full assertion, and a client verifies it alone", async () => {
    // Arrange
    const world = await confirmedWorld();

    // Act
    const [record, ...rest] = await confirmationsOf(world, world.nick);
    if (record === undefined) {
      throw new Error("no confirmation listed");
    }

    // Assert
    expect(rest).toEqual([]);
    expect(record.assertion.signature.length).toBeGreaterThan(0);
    expect(record.items.map((item) => [item.decision, item.content["word"]])).toEqual(
      expect.arrayContaining([
        ["confirm", "overrode"],
        ["discard", "not_relevant_now"],
      ]),
    );
    await verifyLocally(record);
  });

  test("an item changed after the fact no longer verifies: the client sees it was not what was signed", async () => {
    // Arrange
    const world = await confirmedWorld();
    const [record] = await confirmationsOf(world, world.nick);
    if (record === undefined) {
      throw new Error("no confirmation listed");
    }
    const tampered: ConfirmationRecord = {
      ...record,
      items: record.items.map((item) =>
        item.decision === "confirm" ? { ...item, content: { ...item.content, word: "followed" } } : item,
      ),
    };

    // Act & Assert
    await expect(verifyLocally(tampered)).rejects.toThrow("the batch digest does not match its items");
  });

  test("another person reads none of it", async () => {
    // Arrange
    const world = await confirmedWorld();

    // Act & Assert
    expect(await confirmationsOf(world, world.ken)).toEqual([]);
  });
});
