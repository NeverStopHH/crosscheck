/**
 * /api/fence-waivers — the HTTP surface of the one human override (04 §3.6),
 * after 04a took the WRITE half away from the api key.
 *
 * WHAT THESE PIN:
 *
 *   - PK-1: an api key cannot open a fence, and cannot close one — whatever
 *     the body says about a terminal. The refusal names where a request goes
 *     and where a person approves it, so an old curl recipe fails loudly and
 *     usefully rather than silently;
 *   - the listing shows the HISTORY, not only what is live, and says which
 *     AUTHORITY wrote each row — a pre-04a `terminal` grant reads as the weaker
 *     one it is (PK-11).
 *
 * The liveness arithmetic belongs to `waivers.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import { fenceWaivers, pins } from "../src/db/schema.ts";
import { grantWaiver, revokeWaiver } from "../src/services/waivers.ts";
import { seedPasskey } from "./fixtures/passkeys.ts";
import {
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

/**
 * THE HARNESS CLOCK, not the wall clock: the ceiling is measured against
 * `deps.now()`, so every expiry below is relative to TEST_START_ISO.
 */
const NOW = new Date(TEST_START_ISO);

const REPO = "github.com/acme/api";
const PIN = "pin_fence";
const HOUR = 3_600_000;

const setup = async (): Promise<{
  harness: TestHarness;
  nick: TestDeveloper;
  credentialId: string;
}> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await harness.db.insert(pins).values({
    id: PIN,
    repo: REPO,
    surface: "the refresh path keeps working",
    verifiedBy: nick.developerId,
    verifiedAtCommit: "a1b2c3d",
    verifiedAt: new Date(NOW.getTime() - HOUR),
    checkRecipe: "bun test packages/server/test/auth.test.ts",
    captureMode: "human",
    createdAt: new Date(NOW.getTime() - HOUR),
  });
  const { credentialId } = await seedPasskey(harness.db, nick.developerId);
  return { harness, nick, credentialId };
};

/** The body every pre-04a client sent, presence literal and all. */
const legacyGrantBody = (): Record<string, unknown> => ({
  repo: REPO,
  pinId: PIN,
  pinVersion: 1,
  reason: "Rollout is blocked; the fix lands Monday",
  expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
  presence: "controlling_terminal",
});

const grant = async (
  harness: TestHarness,
  nick: TestDeveloper,
  credentialId: string,
): Promise<string> => {
  const outcome = await grantWaiver({
    db: harness.db,
    repo: REPO,
    pinId: PIN,
    pinVersion: 1,
    grantedBy: nick.developerId,
    reason: "Rollout is blocked; the fix lands Monday",
    expiresAt: new Date(NOW.getTime() + 24 * HOUR),
    now: NOW,
    credentialId,
    requestId: null,
  });
  if (!("id" in outcome)) {
    throw new Error(outcome.refusal);
  }
  return outcome.id;
};

describe("PK-1: an api key cannot open or close a fence", () => {
  test("a grant with the key and the presence literal is refused, and writes nothing", async () => {
    // Arrange — exactly what any agent holding ~/.crosscheck/config.json could send.
    const { harness, nick } = await setup();

    // Act
    const response = await harness.app.request(
      "/api/fence-waivers",
      jsonRequest("POST", nick.apiKey, legacyGrantBody()),
    );
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    // Assert
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("passkey_required");
    expect(body.error.message).toContain("/api/waiver-requests");
    expect(body.error.message).toContain("/ui/waivers");
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(0);
  });

  test("a revoke with the key is refused too, and the fence stays as it was", async () => {
    // Arrange
    const { harness, nick, credentialId } = await setup();
    const grantId = await grant(harness, nick, credentialId);

    // Act
    const response = await harness.app.request(
      `/api/fence-waivers/${grantId}/revoke`,
      jsonRequest("POST", nick.apiKey, {
        repo: REPO,
        reason: "The fix landed early",
        presence: "controlling_terminal",
      }),
    );

    // Assert
    expect(response.status).toBe(403);
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(1);
  });
});

describe("GET /api/fence-waivers", () => {
  test("shows the HISTORY, not only what is live", async () => {
    // Arrange — grant, then revoke. A listing that showed only live waivers
    // would answer "is this fence open" and silently drop the question a team
    // actually asks later: who opened it, and who closed it again.
    const { harness, nick, credentialId } = await setup();
    const grantId = await grant(harness, nick, credentialId);
    await revokeWaiver({
      db: harness.db,
      repo: REPO,
      waiverId: grantId,
      grantedBy: nick.developerId,
      reason: "The fix landed early",
      now: NOW,
      credentialId,
    });

    // Act
    const response = await harness.app.request(
      `/api/fence-waivers?repo=${encodeURIComponent(REPO)}`,
      jsonRequest("GET", nick.apiKey),
    );
    const body = (await response.json()) as {
      data: {
        waivers: {
          kind: string;
          live: boolean;
          grantedByName: string;
          authority: string;
        }[];
      };
    };

    // Assert — both rows, nothing live, the granter NAMED, and the authority said.
    expect(response.status).toBe(200);
    expect(body.data.waivers).toHaveLength(2);
    expect(body.data.waivers.map((row) => row.kind).sort()).toEqual([
      "grant",
      "revoke",
    ]);
    expect(body.data.waivers.every((row) => !row.live)).toBe(true);
    expect(body.data.waivers[0]?.grantedByName).toBe("Nick");
    expect(body.data.waivers.every((row) => row.authority === "passkey")).toBe(true);
  });

  test("PK-11: a grant written before 04a lists as the weaker `terminal` authority", async () => {
    // Arrange — a row as an upgraded hub holds it: the bootstrap DEFAULT
    // labelled it, nothing about it was signed.
    const { harness, nick } = await setup();
    await harness.db.insert(fenceWaivers).values({
      id: "fw_legacy",
      repo: REPO,
      pinId: PIN,
      pinVersion: 1,
      kind: "grant",
      grantedBy: nick.developerId,
      captureMode: "human",
      reason: "Opened from a terminal before passkeys",
      expiresAt: new Date(NOW.getTime() + 24 * HOUR),
      supersedes: null,
      createdAt: NOW,
      authority: "terminal",
    });

    // Act
    const response = await harness.app.request(
      `/api/fence-waivers?repo=${encodeURIComponent(REPO)}&pin=${PIN}`,
      jsonRequest("GET", nick.apiKey),
    );
    const body = (await response.json()) as {
      data: { waivers: { live: boolean; authority: string }[] };
    };

    // Assert — still live until its own expiry, and labelled for what it is.
    expect(body.data.waivers).toHaveLength(1);
    expect(body.data.waivers[0]?.live).toBe(true);
    expect(body.data.waivers[0]?.authority).toBe("terminal");
  });
});
