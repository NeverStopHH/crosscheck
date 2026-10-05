/**
 * /api/waiver-requests — the one thing an api key may still do about a fence
 * (1.0 spec 04a §6): ask, take its own question back, and read.
 *
 * The rules themselves are `waiver-requests.test.ts`'s; here the HTTP
 * contract: the body is the wire schema, a refusal is a sentence a person can
 * act on, and the answer tells the asker where the approval happens.
 */
import { describe, expect, test } from "bun:test";

import { fenceWaivers, pins } from "../src/db/schema.ts";
import {
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const NOW = new Date(TEST_START_ISO);
const REPO = "github.com/acme/api";
const PIN = "pin_fence";
const HOUR = 3_600_000;

const setup = async (): Promise<{
  harness: TestHarness;
  nick: TestDeveloper;
  ken: TestDeveloper;
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
  return { harness, nick, ken };
};

const requestBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  repo: REPO,
  pinId: PIN,
  pinVersion: 1,
  reason: "Rollout is blocked; the fix lands Monday",
  expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
  ...overrides,
});

const post = (harness: TestHarness, apiKey: string, path: string, body: Record<string, unknown>) =>
  harness.app.request(path, jsonRequest("POST", apiKey, body));

describe("POST /api/waiver-requests", () => {
  test("a request is stored, opens nothing, and says where a person approves it", async () => {
    // Arrange
    const { harness, nick } = await setup();

    // Act
    const response = await post(harness, nick.apiKey, "/api/waiver-requests", requestBody());
    const body = (await response.json()) as { data: { id: string; approvePath: string } };

    // Assert
    expect(response.status).toBe(201);
    expect(body.data.id).toStartWith("wr_");
    expect(body.data.approvePath).toBe("/ui/waivers");
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(0);
  });

  test("a refusal is a sentence the asker can act on", async () => {
    // Arrange
    const { harness, nick } = await setup();

    // Act
    const response = await post(
      harness,
      nick.apiKey,
      "/api/waiver-requests",
      requestBody({ expiresAt: new Date(NOW.getTime() + 90 * 24 * HOUR).toISOString() }),
    );
    const body = (await response.json()) as { error: { code: string; message: string } };

    // Assert
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("expiry_beyond_ceiling");
    expect(body.error.message).toContain("ask for a shorter one");
  });

  test("a body that is not the wire schema is refused at the boundary", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const { reason: _omitted, ...withoutReason } = requestBody();

    // Act
    const response = await post(harness, nick.apiKey, "/api/waiver-requests", withoutReason);

    // Assert
    expect(response.status).toBe(400);
  });

  test("a stranger without a key gets the 401 every route gives", async () => {
    // Arrange
    const { harness } = await setup();

    // Act
    const response = await harness.app.request("/api/waiver-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody()),
    });

    // Assert
    expect(response.status).toBe(401);
  });
});

describe("withdrawing and reading", () => {
  test("the requester withdraws; the listing shows it withdrawn", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const created = await post(harness, nick.apiKey, "/api/waiver-requests", requestBody());
    const { data } = (await created.json()) as { data: { id: string } };

    // Act
    const withdrawn = await post(harness, nick.apiKey, `/api/waiver-requests/${data.id}/withdraw`, {});
    const listing = await harness.app.request(
      `/api/waiver-requests?repo=${encodeURIComponent(REPO)}`,
      jsonRequest("GET", nick.apiKey),
    );
    const body = (await listing.json()) as { data: { requests: { id: string; status: string }[] } };

    // Assert
    expect(withdrawn.status).toBe(200);
    expect(body.data.requests).toEqual([expect.objectContaining({ id: data.id, status: "withdrawn" })]);
  });

  test("somebody else's request cannot be withdrawn", async () => {
    // Arrange
    const { harness, nick, ken } = await setup();
    const created = await post(harness, nick.apiKey, "/api/waiver-requests", requestBody());
    const { data } = (await created.json()) as { data: { id: string } };

    // Act
    const response = await post(harness, ken.apiKey, `/api/waiver-requests/${data.id}/withdraw`, {});
    const body = (await response.json()) as { error: { code: string } };

    // Assert
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("not_requester");
  });
});
