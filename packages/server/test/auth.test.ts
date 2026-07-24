import { describe, expect, test } from "bun:test";

import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  TEST_ADMIN_TOKEN,
} from "./helpers.ts";

const HEX_API_KEY_PATTERN = /^[0-9a-f]{64}$/;

describe("developer api key auth", () => {
  test("rejects a request without an api key with 401", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const response = await harness.app.request(
      "/api/presence?repo=github.com/acme/api",
    );

    // Assert
    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unauthorized");
  });

  test("rejects a request with an unknown api key with 401", async () => {
    const harness = await createTestHarness();

    const response = await harness.app.request(
      "/api/presence?repo=github.com/acme/api",
      jsonRequest("GET", "not-a-real-key"),
    );

    expect(response.status).toBe(401);
  });

  test("a freshly created developer key authenticates requests", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(
      harness,
      "Nick",
      "nick@example.com",
    );

    // Act
    const response = await harness.app.request(
      "/api/presence?repo=github.com/acme/api",
      jsonRequest("GET", developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(200);
  });
});

describe("admin developer bootstrap", () => {
  test("returns 503 when ADMIN_TOKEN is not configured", async () => {
    // Arrange
    const harness = await createTestHarness({ adminToken: null });

    // Act
    const response = await harness.app.request(
      "/api/developers",
      jsonRequest("POST", "any-token", {
        name: "Nick",
        email: "nick@example.com",
      }),
    );

    // Assert
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
  });

  test("rejects a wrong admin token with 401", async () => {
    const harness = await createTestHarness();

    const response = await harness.app.request(
      "/api/developers",
      jsonRequest("POST", "wrong-admin-token", {
        name: "Nick",
        email: "nick@example.com",
      }),
    );

    expect(response.status).toBe(401);
  });

  test("returns the api key exactly once and never a hash", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const response = await harness.app.request(
      "/api/developers",
      jsonRequest("POST", TEST_ADMIN_TOKEN, {
        name: "Nick",
        email: "nick@example.com",
      }),
    );

    // Assert
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      ok: boolean;
      data: {
        developer: { id: string; name: string; email: string };
        apiKey: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.developer.name).toBe("Nick");
    expect(body.data.apiKey).toMatch(HEX_API_KEY_PATTERN);
    expect(raw).not.toContain("api_key_hash");
    expect(raw).not.toContain("apiKeyHash");
  });

  test("rejects a duplicate developer email with 409", async () => {
    const harness = await createTestHarness();
    await createTestDeveloper(harness, "Nick", "nick@example.com");

    const response = await harness.app.request(
      "/api/developers",
      jsonRequest("POST", TEST_ADMIN_TOKEN, {
        name: "Nick Again",
        email: "nick@example.com",
      }),
    );

    expect(response.status).toBe(409);
  });

  test("rejects an invalid developer payload with 400", async () => {
    const harness = await createTestHarness();

    const response = await harness.app.request(
      "/api/developers",
      jsonRequest("POST", TEST_ADMIN_TOKEN, { name: "", email: "not-an-email" }),
    );

    expect(response.status).toBe(400);
  });
});