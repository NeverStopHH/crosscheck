/**
 * THE ORDER THE HUB ALREADY HOLDS, IN A REGISTER'S ANSWER (seeds 31214, 4286).
 *
 * A connector that resumes a session after every trace of it on its machine
 * aged out has no epoch of its own, and minting one split the session's order
 * on the hub for good. This hub answers every register with `held`: for a
 * session its reaper had ended, which the register revives, the epoch
 * `session.started` was filed under and the highest position in it; for a new
 * one, or a live one another machine may be writing, null. An older hub
 * leaves the field out. Only ever about the caller's own session.
 */
import { describe, expect, test } from "bun:test";

import { reapStaleSessions } from "../src/services/sessions.ts";
import {
  PLACEHOLDER_DEVELOPER_ID,
  createTestDeveloper,
  createTestHarness,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const MINTED = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SESSION = "cc_held";
const HIGHEST = 7;
const REAPED_AFTER_SECONDS = 48 * 60 * 60;

interface Held {
  readonly epoch: string;
  readonly n: number;
}

const heldOf = async (response: Response): Promise<Held | null | undefined> =>
  ((await response.json()) as { data?: { held?: Held | null } }).data?.held;

describe("a register's answer carries the order the hub holds", () => {
  test("a new session is answered held: null", async () => {
    // Arrange
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "held-new@example.com");

    // Act
    const response = await registerTestSession(harness, dev.apiKey, { id: SESSION, seq: { epoch: EPOCH, n: 0 } });

    // Assert
    expect(response.status).toBe(200);
    expect(await heldOf(response)).toBeNull();
  });

  test("a session the reaper ended, revived by the register, is answered with the epoch it started under and the highest position in it", async () => {
    // Arrange: a session started under EPOCH, a claim of it at position 7, then a silence the reaper ended it for
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "held-reaped@example.com");
    await registerTestSession(harness, dev.apiKey, { id: SESSION, seq: { epoch: EPOCH, n: 0 } });
    const producer = { sessionId: SESSION, developerId: PLACEHOLDER_DEVELOPER_ID };
    await postRecords(harness, dev, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ sessionId: SESSION }), producer),
        { ...recordEnvelope("claim", validClaimBody({ id: "clm_held", authorSessionId: SESSION }), producer), seq: { epoch: EPOCH, n: HIGHEST } },
      ],
    });
    harness.clock.advanceSeconds(REAPED_AFTER_SECONDS);
    await reapStaleSessions({ db: harness.db, now: harness.clock.now }, { developerId: dev.developerId });

    // Act: the session registers again with a fresh mint, as a connector with no trace of it would
    const response = await registerTestSession(harness, dev.apiKey, { id: SESSION, seq: { epoch: MINTED, n: 0 } });

    // Assert
    expect(response.status).toBe(200);
    expect(await heldOf(response)).toEqual({ epoch: EPOCH, n: HIGHEST });
  });

  test("a LIVE session is answered held: null — another machine may be writing it (M6)", async () => {
    // Arrange: a live session with a positioned claim
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "held-live@example.com");
    await registerTestSession(harness, dev.apiKey, { id: SESSION, seq: { epoch: EPOCH, n: 0 } });
    const producer = { sessionId: SESSION, developerId: PLACEHOLDER_DEVELOPER_ID };
    await postRecords(harness, dev, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ sessionId: SESSION }), producer),
        { ...recordEnvelope("claim", validClaimBody({ id: "clm_live", authorSessionId: SESSION }), producer), seq: { epoch: EPOCH, n: HIGHEST } },
      ],
    });

    // Act: a second register of the same life, as a second machine's would be
    const response = await registerTestSession(harness, dev.apiKey, { id: SESSION, seq: { epoch: MINTED, n: 0 } });

    // Assert
    expect(response.status).toBe(200);
    expect(await heldOf(response)).toBeNull();
  });

  test("a reaped session whose start carried no position is answered held: null", async () => {
    // Arrange: a register from a connector too old for the field, then the reaper
    const harness = await createTestHarness();
    const dev = await createTestDeveloper(harness, "Nick", "held-unpositioned@example.com");
    await registerTestSession(harness, dev.apiKey, { id: SESSION });
    harness.clock.advanceSeconds(REAPED_AFTER_SECONDS);
    await reapStaleSessions({ db: harness.db, now: harness.clock.now }, { developerId: dev.developerId });

    // Act
    const response = await registerTestSession(harness, dev.apiKey, { id: SESSION, seq: { epoch: MINTED, n: 0 } });

    // Assert
    expect(response.status).toBe(200);
    expect(await heldOf(response)).toBeNull();
  });

  test("another developer's session id is refused, and nothing of it is told", async () => {
    // Arrange
    const harness = await createTestHarness();
    const owner = await createTestDeveloper(harness, "Nick", "held-owner@example.com");
    const intruder = await createTestDeveloper(harness, "Robin", "held-intruder@example.com");
    await registerTestSession(harness, owner.apiKey, { id: SESSION, seq: { epoch: EPOCH, n: 0 } });

    // Act
    const response = await registerTestSession(harness, intruder.apiKey, { id: SESSION, seq: { epoch: MINTED, n: 0 } });

    // Assert
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain(EPOCH);
    expect(text).not.toContain("held");
  });
});
