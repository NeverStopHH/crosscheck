/**
 * The pin registry's HTTP surface (regression-guard Stage 1).
 *
 * Four properties are pinned here because each one is a hole somebody could
 * otherwise walk through:
 *
 *   1. an agent cannot mint a pin — `captureMode` must be "human", and the
 *      refusal says so rather than silently downgrading;
 *   2. pins are REPO-scoped, so every worktree of the same remote sees the
 *      same registry and no other repo's;
 *   3. a pin can be RETRACTED (`--broke`), with who and when recorded — a
 *      claim you cannot retract is a monument;
 *   4. the list carries its own DENOMINATOR, so "4 pins, 12 files" can never
 *      be read as protection of the other 8,400 files.
 */
import { describe, expect, test } from "bun:test";

import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const OTHER_REPO = "github.com/acme/web";

interface PinFileView {
  readonly path: string;
  readonly status: string;
}

interface PinView {
  readonly id: string;
  readonly surface: string;
  readonly files: readonly PinFileView[];
  readonly check: string | null;
  readonly captureMode: string;
  readonly verifiedById: string;
  readonly verifiedByName: string;
  readonly verifiedAtCommit: string;
  readonly verifiedAt: string;
  readonly brokeAt: string | null;
  readonly brokeByName: string | null;
  readonly speaking: boolean;
}

interface CoverageView {
  readonly pins: number;
  readonly files: number;
  readonly speaking: number;
  readonly broken: number;
  readonly missingPaths: number;
  readonly oldestVerifiedAt: string | null;
}

const pinBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `pin_${crypto.randomUUID()}`,
  repo: REPO,
  surface: "Play button plays/pauses",
  files: ["src/workbench/PlaybackControls.tsx", "src/workbench/usePlayback.ts"],
  check: "open /workbench, press Play",
  captureMode: "human",
  verifiedAtCommit: "abc1234",
  ...overrides,
});

const createPin = async (
  harness: TestHarness,
  apiKey: string,
  body: Record<string, unknown> = pinBody(),
): Promise<Response> =>
  harness.app.request("/api/pins", jsonRequest("POST", apiKey, body));

const listPins = async (
  harness: TestHarness,
  apiKey: string,
  repo: string = REPO,
): Promise<{
  readonly status: number;
  readonly pins: readonly PinView[];
  readonly coverage: CoverageView;
}> => {
  const response = await harness.app.request(
    `/api/pins?repo=${encodeURIComponent(repo)}`,
    jsonRequest("GET", apiKey),
  );
  const parsed = (await response.json()) as {
    data?: { pins: PinView[]; coverage: CoverageView };
  };
  return {
    status: response.status,
    pins: parsed.data?.pins ?? [],
    coverage:
      parsed.data?.coverage ??
      {
        pins: -1,
        files: -1,
        speaking: -1,
        broken: -1,
        missingPaths: -1,
        oldestVerifiedAt: null,
      },
  };
};

describe("POST /api/pins", () => {
  test("stores a human-verified pin with its files, author and commit", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-pin@example.com");

    // Act
    const response = await createPin(harness, nick.apiKey);

    // Assert
    expect(response.status).toBe(200);
    const listed = await listPins(harness, nick.apiKey);
    expect(listed.pins).toHaveLength(1);
    const pin = listed.pins[0] as PinView;
    expect(pin.surface).toBe("Play button plays/pauses");
    expect(pin.files.map((file) => file.path)).toEqual([
      "src/workbench/PlaybackControls.tsx",
      "src/workbench/usePlayback.ts",
    ]);
    expect(pin.check).toBe("open /workbench, press Play");
    // The AUTHOR is on the row: over-pinning has to be socially visible on
    // day one, which needs a name beside every pin.
    expect(pin.verifiedByName).toBe("Nick");
    expect(pin.verifiedById).toBe(nick.developerId);
    expect(pin.verifiedAtCommit).toBe("abc1234");
    // Capture mode is CARRIED, not only checked: the trust label prints it,
    // because provenance alone never distinguished "Nick said" from "an
    // agent said Nick said".
    expect(pin.captureMode).toBe("human");
    expect(pin.speaking).toBe(true);
    expect(pin.brokeAt).toBeNull();
  });

  test("refuses a pin an agent captured — the gate fails CLOSED", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-agent@example.com");

    // Act
    const response = await createPin(
      harness,
      nick.apiKey,
      pinBody({ captureMode: "agent" }),
    );

    // Assert
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("captureMode");
    // And nothing was stored on the way to the refusal.
    const listed = await listPins(harness, nick.apiKey);
    expect(listed.pins).toHaveLength(0);
  });

  test("refuses a speaking-sized pin with no check recipe", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-check@example.com");
    const noCheck = pinBody();
    delete noCheck["check"];

    // Act
    const response = await createPin(harness, nick.apiKey, noCheck);

    // Assert
    expect(response.status).toBe(400);
  });

  test("refuses a second pin under an id the hub already holds", async () => {
    // Arrange: ids are minted by the caller so a retry is idempotent; a
    // SILENT overwrite would let one person rewrite another's pin.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-dup@example.com");
    const body = pinBody();
    await createPin(harness, nick.apiKey, body);

    // Act
    const again = await createPin(harness, nick.apiKey, {
      ...body,
      surface: "Something else entirely",
    });

    // Assert
    expect(again.status).toBe(409);
    const listed = await listPins(harness, nick.apiKey);
    expect(listed.pins).toHaveLength(1);
    expect((listed.pins[0] as PinView).surface).toBe("Play button plays/pauses");
  });
});

describe("GET /api/pins", () => {
  test("is repo-scoped, so a worktree sees its own registry and no other", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-scope@example.com");
    await createPin(harness, nick.apiKey, pinBody());
    await createPin(
      harness,
      nick.apiKey,
      pinBody({ repo: OTHER_REPO, surface: "Marketing hero renders" }),
    );

    // Act
    const here = await listPins(harness, nick.apiKey, REPO);
    const there = await listPins(harness, nick.apiKey, OTHER_REPO);

    // Assert
    expect(here.pins.map((pin) => pin.surface)).toEqual([
      "Play button plays/pauses",
    ]);
    expect(there.pins.map((pin) => pin.surface)).toEqual([
      "Marketing hero renders",
    ]);
  });

  test("shows a teammate's pins, not only the caller's", async () => {
    // Arrange: the register is the TEAM's — a pin Ken made is the one Nick's
    // agent is most likely to break.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-team@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken-team@example.com");
    await createPin(harness, ken.apiKey, pinBody());

    // Act
    const listed = await listPins(harness, nick.apiKey);

    // Assert
    expect(listed.pins).toHaveLength(1);
    expect((listed.pins[0] as PinView).verifiedByName).toBe("Ken");
  });

  test("carries the coverage denominator, including zero", async () => {
    // Arrange: the EMPTY case first — a silent week must never masquerade as
    // protection of the other 8,400 files.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-cov@example.com");
    const empty = await listPins(harness, nick.apiKey);
    expect(empty.coverage).toMatchObject({
      pins: 0,
      files: 0,
      speaking: 0,
      broken: 0,
    });
    expect(empty.coverage.oldestVerifiedAt).toBeNull();

    // Act: one speaking pin (2 files) and one briefing-only pin (6 files).
    await createPin(harness, nick.apiKey, pinBody());
    const briefingOnly = pinBody({
      surface: "Tracking field renders smoothly",
      files: Array.from(
        { length: 6 },
        (_unused, index) => `src/workbench/tracking-${String(index)}.ts`,
      ),
    });
    delete briefingOnly["check"];
    await createPin(harness, nick.apiKey, briefingOnly);
    const listed = await listPins(harness, nick.apiKey);

    // Assert
    expect(listed.coverage.pins).toBe(2);
    expect(listed.coverage.files).toBe(8);
    expect(listed.coverage.speaking).toBe(1);
    expect(listed.coverage.oldestVerifiedAt).not.toBeNull();
  });
});

describe("POST /api/pins/:id/broke", () => {
  test("retracts a pin, recording who broke it and when", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-broke@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken-broke@example.com");
    const body = pinBody();
    await createPin(harness, nick.apiKey, body);

    // Act: Ken ran Nick's check recipe and it failed.
    const response = await harness.app.request(
      `/api/pins/${String(body["id"])}/broke`,
      jsonRequest("POST", ken.apiKey, {}),
    );

    // Assert
    expect(response.status).toBe(200);
    const listed = await listPins(harness, nick.apiKey);
    const pin = listed.pins[0] as PinView;
    expect(pin.brokeAt).not.toBeNull();
    expect(pin.brokeByName).toBe("Ken");
    // A broken pin is no longer watching anything, and the denominator says so.
    expect(listed.coverage.broken).toBe(1);
    expect(listed.coverage.pins).toBe(0);
  });

  test("answers 404 for a pin the hub has never held", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-404@example.com");

    // Act
    const response = await harness.app.request(
      "/api/pins/pin_nothing/broke",
      jsonRequest("POST", nick.apiKey, {}),
    );

    // Assert
    expect(response.status).toBe(404);
  });
});
