/**
 * What an api key may still do about a fence — ask — and what a passkey
 * approval turns that into (1.0 spec 04a §6).
 *
 * The assertion is verified upstream (services/webauthn.ts); here the
 * credential id arrives as the proof that it happened, and the questions are
 * the record's: does a request open nothing, does an approval write exactly
 * the signed terms against exactly the requested version, and can a request
 * be answered twice.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { MAX_WAIVER_DAYS } from "../src/constants.ts";
import { fenceWaivers, pins } from "../src/db/schema.ts";
import {
  amendWaiver,
  approveRequest,
  listRequests,
  requestWaiver,
  withdrawRequest,
} from "../src/services/waiver-requests.ts";
import { readLiveWaiver } from "../src/services/waivers.ts";
import { seedPasskey } from "./fixtures/passkeys.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const PIN = "pin_fence";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-09-30T12:00:00.000Z");
const ASKED_UNTIL = new Date(NOW.getTime() + 2 * DAY);

const setup = async (): Promise<{
  harness: TestHarness;
  nick: string;
  ken: string;
  kensCredential: string;
}> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
  await harness.db.insert(pins).values({
    id: PIN,
    repo: REPO,
    surface: "the refresh path keeps working",
    verifiedBy: nick.developerId,
    verifiedAtCommit: "a1b2c3d",
    verifiedAt: new Date(NOW.getTime() - HOUR),
    checkRecipe: null,
    captureMode: "human",
    createdAt: new Date(NOW.getTime() - HOUR),
  });
  const { credentialId } = await seedPasskey(harness.db, ken.developerId);
  return {
    harness,
    nick: nick.developerId,
    ken: ken.developerId,
    kensCredential: credentialId,
  };
};

const ask = (
  harness: TestHarness,
  requestedBy: string,
  overrides: { pinVersion?: number; expiresAt?: Date; pinId?: string; repo?: string } = {},
) =>
  requestWaiver({
    db: harness.db,
    repo: overrides.repo ?? REPO,
    pinId: overrides.pinId ?? PIN,
    pinVersion: overrides.pinVersion ?? 1,
    requestedBy,
    reason: "Rollout is blocked; the fix lands Monday",
    expiresAt: overrides.expiresAt ?? ASKED_UNTIL,
    now: NOW,
  });

const requestId = async (harness: TestHarness, requestedBy: string): Promise<string> => {
  const outcome = await ask(harness, requestedBy);
  if (!("id" in outcome)) {
    throw new Error(outcome.refusal);
  }
  return outcome.id;
};

const live = (harness: TestHarness, at: Date = NOW) =>
  readLiveWaiver({ db: harness.db, repo: REPO, pinId: PIN, pinVersion: 1, now: at });

describe("PK-2: a request opens nothing", () => {
  test("the fence stays closed and the request is listed pending", async () => {
    // Arrange
    const { harness, nick } = await setup();

    // Act
    await requestId(harness, nick);
    const listed = await listRequests({ db: harness.db, repo: REPO, now: NOW });

    // Assert
    expect(await live(harness)).toBeNull();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("pending");
    expect(listed[0]?.requestedByName).toBe("Nick");
  });

  test("a second request for the same fence while one is pending is refused", async () => {
    // Arrange — two pending requests would be two prompts for one decision.
    const { harness, nick, ken } = await setup();
    await requestId(harness, nick);

    // Act
    const second = await ask(harness, ken);

    // Assert
    expect(second).toEqual({ refusal: "already_requested" });
  });

  test("the same rules a grant would meet are checked at the request", async () => {
    // Arrange
    const { harness, nick } = await setup();

    // Act
    const unknownPin = await ask(harness, nick, { pinId: "pin_nothing" });
    const wrongRepo = await ask(harness, nick, { repo: "github.com/acme/other" });
    const past = await ask(harness, nick, { expiresAt: new Date(NOW.getTime() - HOUR) });
    const beyond = await ask(harness, nick, {
      expiresAt: new Date(NOW.getTime() + (MAX_WAIVER_DAYS + 1) * DAY),
    });

    // Assert
    expect(unknownPin).toEqual({ refusal: "unknown_pin" });
    expect(wrongRepo).toEqual({ refusal: "wrong_repo" });
    expect(past).toEqual({ refusal: "expiry_in_the_past" });
    expect(beyond).toEqual({ refusal: "expiry_beyond_ceiling" });
  });

  test("a request against a version the pin has moved past is refused", async () => {
    // Arrange
    const { harness, nick } = await setup();

    // Act
    const stale = await ask(harness, nick, { pinVersion: 2 });

    // Assert
    expect(stale).toEqual({ refusal: "stale_version" });
  });
});

describe("withdrawing a request", () => {
  test("its requester may withdraw it, once", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const id = await requestId(harness, nick);

    // Act
    const first = await withdrawRequest({ db: harness.db, requestId: id, developerId: nick, now: NOW });
    const second = await withdrawRequest({ db: harness.db, requestId: id, developerId: nick, now: NOW });
    const listed = await listRequests({ db: harness.db, repo: REPO, now: NOW });

    // Assert
    expect(first).toEqual({ withdrawn: true });
    expect(second).toEqual({ refusal: "not_pending" });
    expect(listed[0]?.status).toBe("withdrawn");
  });

  test("nobody else may withdraw it", async () => {
    // Arrange
    const { harness, nick, ken } = await setup();
    const id = await requestId(harness, nick);

    // Act
    const outcome = await withdrawRequest({ db: harness.db, requestId: id, developerId: ken, now: NOW });

    // Assert
    expect(outcome).toEqual({ refusal: "not_requester" });
  });
});

describe("approving a request with a passkey", () => {
  test("PK-3: an approval writes a passkey grant naming the credential and the request", async () => {
    // Arrange
    const { harness, nick, ken, kensCredential } = await setup();
    const id = await requestId(harness, nick);

    // Act
    const outcome = await approveRequest({
      db: harness.db,
      requestId: id,
      approverId: ken,
      credentialId: kensCredential,
      expiresAt: ASKED_UNTIL,
      reason: "Rollout is blocked; the fix lands Monday",
      now: NOW,
    });

    // Assert
    expect("waiverId" in outcome).toBe(true);
    const waiver = await live(harness);
    expect(waiver?.authority).toBe("passkey");
    expect(waiver?.grantedByName).toBe("Ken");
    const rows = await harness.db.select().from(fenceWaivers);
    expect(rows[0]?.credentialId).toBe(kensCredential);
    expect(rows[0]?.requestId).toBe(id);
    const listed = await listRequests({ db: harness.db, repo: REPO, now: NOW });
    expect(listed[0]?.status).toBe("approved");
  });

  test("the approver may shorten the expiry, never lengthen it", async () => {
    // Arrange
    const { harness, nick, ken, kensCredential } = await setup();
    const id = await requestId(harness, nick);
    const approve = (expiresAt: Date) =>
      approveRequest({
        db: harness.db,
        requestId: id,
        approverId: ken,
        credentialId: kensCredential,
        expiresAt,
        reason: "Shorter is fine",
        now: NOW,
      });

    // Act
    const longer = await approve(new Date(ASKED_UNTIL.getTime() + HOUR));
    const shorter = await approve(new Date(NOW.getTime() + 6 * HOUR));

    // Assert
    expect(longer).toEqual({ refusal: "expiry_beyond_request" });
    expect("waiverId" in shorter).toBe(true);
    expect((await live(harness))?.expiresAt).toBe(new Date(NOW.getTime() + 6 * HOUR).toISOString());
  });

  test("a request is answered once: approved twice is refused", async () => {
    // Arrange
    const { harness, nick, ken, kensCredential } = await setup();
    const approvedId = await requestId(harness, nick);
    const approve = (requestIdToApprove: string) =>
      approveRequest({
        db: harness.db,
        requestId: requestIdToApprove,
        approverId: ken,
        credentialId: kensCredential,
        expiresAt: ASKED_UNTIL,
        reason: "ok",
        now: NOW,
      });
    await approve(approvedId);

    // Act
    const twice = await approve(approvedId);

    // Assert
    expect(twice).toEqual({ refusal: "not_pending" });
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(1);
  });

  test("PK-12: a request whose pin moved to a new version cannot be approved", async () => {
    // Arrange — a sweep moved the watched paths after the request was made.
    const { harness, nick, ken, kensCredential } = await setup();
    const id = await requestId(harness, nick);
    await harness.db.update(pins).set({ version: 2 }).where(eq(pins.id, PIN));

    // Act
    const outcome = await approveRequest({
      db: harness.db,
      requestId: id,
      approverId: ken,
      credentialId: kensCredential,
      expiresAt: ASKED_UNTIL,
      reason: "ok",
      now: NOW,
    });

    // Assert
    expect(outcome).toEqual({ refusal: "stale_version" });
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(0);
  });

  test("a request whose asked-for expiry has passed has lapsed", async () => {
    // Arrange
    const { harness, nick, ken, kensCredential } = await setup();
    const id = await requestId(harness, nick);
    const later = new Date(ASKED_UNTIL.getTime() + HOUR);

    // Act
    const outcome = await approveRequest({
      db: harness.db,
      requestId: id,
      approverId: ken,
      credentialId: kensCredential,
      expiresAt: new Date(later.getTime() + HOUR),
      reason: "ok",
      now: later,
    });
    const listed = await listRequests({ db: harness.db, repo: REPO, now: later });

    // Assert
    expect(outcome).toEqual({ refusal: "not_pending" });
    expect(listed[0]?.status).toBe("lapsed");
  });
});

describe("amending a live waiver", () => {
  test("one amendment closes the old grant and opens the new terms", async () => {
    // Arrange
    const { harness, nick, ken, kensCredential } = await setup();
    const id = await requestId(harness, nick);
    const approved = await approveRequest({
      db: harness.db,
      requestId: id,
      approverId: ken,
      credentialId: kensCredential,
      expiresAt: ASKED_UNTIL,
      reason: "first",
      now: NOW,
    });
    if (!("waiverId" in approved)) throw new Error(approved.refusal);
    const amendedUntil = new Date(NOW.getTime() + 3 * HOUR);

    // Act
    const outcome = await amendWaiver({
      db: harness.db,
      repo: REPO,
      waiverId: approved.waiverId,
      approverId: ken,
      credentialId: kensCredential,
      expiresAt: amendedUntil,
      reason: "the fix landed early; closing sooner",
      now: NOW,
    });

    // Assert — two new rows, one decision: the old grant revoked, the new live.
    expect("waiverId" in outcome).toBe(true);
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(3);
    const waiver = await live(harness);
    expect(waiver?.expiresAt).toBe(amendedUntil.toISOString());
    expect(waiver?.reason).toBe("the fix landed early; closing sooner");
  });

  test("amending a waiver that does not exist is refused and writes nothing", async () => {
    // Arrange
    const { harness, ken, kensCredential } = await setup();

    // Act
    const outcome = await amendWaiver({
      db: harness.db,
      repo: REPO,
      waiverId: "fw_nothing",
      approverId: ken,
      credentialId: kensCredential,
      expiresAt: ASKED_UNTIL,
      reason: "reaching",
      now: NOW,
    });

    // Assert
    expect(outcome).toEqual({ refusal: "unknown_waiver" });
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(0);
  });
});
