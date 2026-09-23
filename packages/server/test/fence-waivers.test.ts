/**
 * /api/fence-waivers — the HTTP surface of the one human override (04 §3.6).
 *
 * WHAT THESE PIN is the gate and the record, not the arithmetic —
 * `waivers.test.ts` owns the liveness rules. Here:
 *
 *   - the presence literal fails at the BOUNDARY, before the database;
 *   - `capture_mode` is stamped by the hub and never by the body;
 *   - a refusal reaches the person's terminal synchronously, with a sentence
 *     somebody wrote on purpose rather than an enum name;
 *   - the listing shows the HISTORY, not only what is live — which is the
 *     whole reason the table is append-only.
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

/**
 * THE HARNESS CLOCK, not the wall clock. Every expiry below is relative to
 * TEST_START_ISO because the ceiling is measured against `deps.now()` — a
 * fixture built on `Date.now()` asks for an expiry two months past a fourteen
 * day ceiling and is refused, which is the route doing its job and the test
 * being wrong.
 */
const NOW = new Date(TEST_START_ISO);

const REPO = "github.com/acme/api";
const PIN = "pin_fence";
const HOUR = 3_600_000;

const setup = async (): Promise<{
  harness: TestHarness;
  nick: TestDeveloper;
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
  return { harness, nick };
};

const grantBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  repo: REPO,
  pinId: PIN,
  pinVersion: 1,
  reason: "Rollout is blocked; the fix lands Monday",
  expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
  presence: "controlling_terminal",
  ...overrides,
});

const post = async (
  harness: TestHarness,
  nick: TestDeveloper,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  harness.app.request(path, jsonRequest("POST", nick.apiKey, body));

describe("POST /api/fence-waivers", () => {
  test("a person at a terminal may open a fence", async () => {
    // Arrange & Act
    const { harness, nick } = await setup();
    const response = await post(
      harness,
      nick,
      "/api/fence-waivers",
      grantBody(),
    );

    // Assert
    expect(response.status).toBe(201);
    const rows = await harness.db
      .select({
        captureMode: fenceWaivers.captureMode,
        kind: fenceWaivers.kind,
      })
      .from(fenceWaivers);
    // STAMPED BY THE HUB. The body said what it OBSERVED; only the hub says
    // what that observation is worth.
    expect(rows[0]?.captureMode).toBe("human");
    expect(rows[0]?.kind).toBe("grant");
  });

  test("a body with no presence is refused at the boundary", async () => {
    // Arrange — the literal makes the gate fail CLOSED: absent is a parse
    // failure, never a default. Nothing reaches the database.
    const { harness, nick } = await setup();
    const { presence: _omitted, ...withoutPresence } = grantBody();

    // Act
    const response = await post(
      harness,
      nick,
      "/api/fence-waivers",
      withoutPresence,
    );

    // Assert
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(0);
  });

  test("a body claiming some OTHER presence is refused too", async () => {
    // Arrange — the gate is on one observed value, not on "something truthy".
    const { harness, nick } = await setup();

    // Act
    const response = await post(
      harness,
      nick,
      "/api/fence-waivers",
      grantBody({ presence: "definitely_a_human" }),
    );

    // Assert
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(0);
  });

  test("an expiry past the ceiling is refused WITH a usable sentence", async () => {
    // Arrange — the person typed this; they need to know what to do next, in
    // their terminal, not an enum name.
    const { harness, nick } = await setup();

    // Act
    const response = await post(
      harness,
      nick,
      "/api/fence-waivers",
      grantBody({
        expiresAt: new Date(NOW.getTime() + 90 * 24 * HOUR).toISOString(),
      }),
    );
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    // Assert
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("expiry_beyond_ceiling");
    expect(body.error.message).toContain("grant a shorter one");
  });

  test("a reason longer than the cap is refused", async () => {
    // Arrange — the reason is author-written text on a surface other people
    // read, so its bound is the wire's, not a renderer's afterthought.
    const { harness, nick } = await setup();

    // Act
    const response = await post(
      harness,
      nick,
      "/api/fence-waivers",
      grantBody({ reason: "x".repeat(201) }),
    );

    // Assert
    expect(response.status).toBe(400);
  });
});

describe("POST /api/fence-waivers/:id/revoke", () => {
  test("closes the fence and keeps both rows", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const granted = await post(
      harness,
      nick,
      "/api/fence-waivers",
      grantBody(),
    );
    const { data } = (await granted.json()) as { data: { id: string } };

    // Act
    const response = await post(
      harness,
      nick,
      `/api/fence-waivers/${data.id}/revoke`,
      {
        repo: REPO,
        reason: "The fix landed early",
        presence: "controlling_terminal",
      },
    );

    // Assert — append-only: the grant survives, so a team can still see that
    // the fence was open and for how long.
    expect(response.status).toBe(201);
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(2);
  });

  test("a revoke with no reason is refused", async () => {
    // Arrange — the unusual half of the rule. Taking a permission back without
    // saying why is what makes a revocation read as an accusation.
    const { harness, nick } = await setup();
    const granted = await post(
      harness,
      nick,
      "/api/fence-waivers",
      grantBody(),
    );
    const { data } = (await granted.json()) as { data: { id: string } };

    // Act
    const response = await post(
      harness,
      nick,
      `/api/fence-waivers/${data.id}/revoke`,
      { repo: REPO, presence: "controlling_terminal" },
    );

    // Assert
    expect(response.status).toBe(400);
  });

  test("an unknown waiver answers 'unknown', never 'forbidden'", async () => {
    // Arrange — telling a caller that a waiver EXISTS somewhere they cannot
    // see is itself a disclosure, so both cases answer the same way.
    const { harness, nick } = await setup();

    // Act
    const response = await post(
      harness,
      nick,
      "/api/fence-waivers/fw_nothing/revoke",
      { repo: REPO, reason: "Reaching", presence: "controlling_terminal" },
    );
    const body = (await response.json()) as { error: { code: string } };

    // Assert
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("unknown_waiver");
  });
});

describe("GET /api/fence-waivers", () => {
  test("shows the HISTORY, not only what is live", async () => {
    // Arrange — grant, then revoke. A listing that showed only live waivers
    // would answer "is this fence open" and silently drop the question a team
    // actually asks later: who opened it, and who closed it again.
    const { harness, nick } = await setup();
    const granted = await post(
      harness,
      nick,
      "/api/fence-waivers",
      grantBody(),
    );
    const { data } = (await granted.json()) as { data: { id: string } };
    await post(harness, nick, `/api/fence-waivers/${data.id}/revoke`, {
      repo: REPO,
      reason: "The fix landed early",
      presence: "controlling_terminal",
    });

    // Act
    const response = await harness.app.request(
      `/api/fence-waivers?repo=${encodeURIComponent(REPO)}`,
      jsonRequest("GET", nick.apiKey),
    );
    const body = (await response.json()) as {
      data: {
        waivers: { kind: string; live: boolean; grantedByName: string }[];
      };
    };

    // Assert — both rows, nothing live, and the granter NAMED rather than an
    // opaque id a reader could not turn into a person.
    expect(response.status).toBe(200);
    expect(body.data.waivers).toHaveLength(2);
    expect(body.data.waivers.map((row) => row.kind).sort()).toEqual([
      "grant",
      "revoke",
    ]);
    expect(body.data.waivers.every((row) => !row.live)).toBe(true);
    expect(body.data.waivers[0]?.grantedByName).toBe("Nick");
  });

  test("marks the one row that is holding a fence open", async () => {
    // Arrange
    const { harness, nick } = await setup();
    await post(harness, nick, "/api/fence-waivers", grantBody());

    // Act
    const response = await harness.app.request(
      `/api/fence-waivers?repo=${encodeURIComponent(REPO)}&pin=${PIN}`,
      jsonRequest("GET", nick.apiKey),
    );
    const body = (await response.json()) as {
      data: { waivers: { live: boolean }[] };
    };

    // Assert
    expect(body.data.waivers).toHaveLength(1);
    expect(body.data.waivers[0]?.live).toBe(true);
  });
});
