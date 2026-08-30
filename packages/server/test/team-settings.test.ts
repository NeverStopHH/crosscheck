/**
 * Team-level settings for the regression guard (regression-guard Stage 1).
 *
 * Two decisions were taken in a three-person frame, and crosscheck is a
 * product for many teams, so both ship as SETTINGS with the three-person
 * answer as the default:
 *
 *   - who may pin ("anyone" by default, "touched_files" for teams where
 *     pins on unread code and unfindable owners are a real failure);
 *   - whether `suspect` names sessions at all ("sessions" by default;
 *     "counts_only" for teams under a works-council agreement or a data
 *     protection posture that forbids per-person attribution).
 *
 * The row is ABSENT until somebody configures the repo, and an absent row
 * must behave exactly like the defaults — otherwise "what is this team set
 * to" depends on knowing whether anybody ever pressed the switch.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const PINNED_A = "src/workbench/PlaybackControls.tsx";
const PINNED_B = "src/workbench/usePlayback.ts";

interface SettingsView {
  readonly repo: string;
  readonly pinPolicy: string;
  readonly suspectAttribution: string;
  readonly updatedAt: string | null;
}

const readSettings = async (
  harness: TestHarness,
  apiKey: string,
): Promise<SettingsView> => {
  const response = await harness.app.request(
    `/api/team-settings?repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: SettingsView };
  return body.data;
};

const writeSettings = async (
  harness: TestHarness,
  token: string | null,
  body: Record<string, unknown>,
): Promise<Response> =>
  harness.app.request(
    "/api/team-settings",
    jsonRequest("PUT", token, { repo: REPO, ...body }),
  );

const pinBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `pin_${crypto.randomUUID()}`,
  repo: REPO,
  surface: "Play button plays/pauses",
  files: [PINNED_A, PINNED_B],
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

const seedTouches = async (
  harness: TestHarness,
  developer: TestDeveloper,
  sessionId: string,
  contextId: string,
  files: readonly string[],
): Promise<void> => {
  const records = [
    recordEnvelope(
      "work_context",
      validWorkContextBody({
        id: contextId,
        sessionId,
        title: "Playback stutter on Safari",
        description: undefined,
        createdAt: TEST_START_ISO,
      }),
      { sessionId },
    ),
    ...files.map((value) =>
      recordEnvelope(
        "target",
        { workContextId: contextId, kind: "file", value },
        { sessionId },
      ),
    ),
  ];
  const result = await postRecords(harness, developer, { records });
  expect(result.status).toBe(200);
  expect(result.data?.rejected ?? 0).toBe(0);
};

describe("GET /api/team-settings", () => {
  test("an unconfigured repo reports the defaults, and says they are unset", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-ts@example.com");

    // Act
    const settings = await readSettings(harness, nick.apiKey);

    // Assert: the effective values print either way — a reader must never
    // have to know whether a row exists to know what this team is set to.
    expect(settings.pinPolicy).toBe("anyone");
    expect(settings.suspectAttribution).toBe("sessions");
    expect(settings.updatedAt).toBeNull();
  });
});

describe("PUT /api/team-settings", () => {
  test("needs the admin token — a team setting is not a personal preference", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-auth@example.com");

    // Act
    const asDeveloper = await writeSettings(harness, nick.apiKey, {
      suspectAttribution: "counts_only",
    });

    // Assert
    expect(asDeveloper.status).toBe(401);
    expect((await readSettings(harness, nick.apiKey)).suspectAttribution).toBe(
      "sessions",
    );
  });

  test("changes one setting without resetting the other", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-partial@example.com");
    expect(
      (await writeSettings(harness, TEST_ADMIN_TOKEN, { pinPolicy: "touched_files" }))
        .status,
    ).toBe(200);

    // Act
    const response = await writeSettings(harness, TEST_ADMIN_TOKEN, {
      suspectAttribution: "counts_only",
    });

    // Assert
    expect(response.status).toBe(200);
    const settings = await readSettings(harness, nick.apiKey);
    expect(settings.pinPolicy).toBe("touched_files");
    expect(settings.suspectAttribution).toBe("counts_only");
    expect(settings.updatedAt).not.toBeNull();
  });

  test("refuses a value that is not one of the two", async () => {
    // Arrange
    const harness = await createTestHarness();

    // Act
    const response = await writeSettings(harness, TEST_ADMIN_TOKEN, {
      suspectAttribution: "name_everyone",
    });

    // Assert
    expect(response.status).toBe(400);
  });
});

describe("the pin policy", () => {
  test("by default anyone pins anything", async () => {
    // Arrange: the shipped default, and Nick's decision for the trial.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-open@example.com");

    // Act: files this developer has never touched.
    const response = await createPin(harness, nick.apiKey);

    // Assert
    expect(response.status).toBe(200);
  });

  test("touched_files refuses a pin on code the pinner has never opened, and names the files", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-touch@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await writeSettings(harness, TEST_ADMIN_TOKEN, { pinPolicy: "touched_files" });
    await seedTouches(harness, nick, "ses_nick", "wc_nick", [PINNED_A]);

    // Act
    const response = await createPin(harness, nick.apiKey);

    // Assert: the refusal names WHICH file, because "you may not pin that"
    // with no path is a refusal nobody can act on.
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain(PINNED_B);
    expect(body.error.message).not.toContain(PINNED_A);
  });

  test("touched_files accepts a pin on files the pinner has actually touched", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-ok@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await writeSettings(harness, TEST_ADMIN_TOKEN, { pinPolicy: "touched_files" });
    await seedTouches(harness, nick, "ses_nick", "wc_nick", [PINNED_A, PINNED_B]);

    // Act
    const response = await createPin(harness, nick.apiKey);

    // Assert
    expect(response.status).toBe(200);
  });

  test("another person's touches are not yours", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-other@example.com");
    const ken = await addTestDeveloperWithSession(
      harness,
      "Ken",
      "ken-other@example.com",
      { id: "ses_ken" },
    );
    await writeSettings(harness, TEST_ADMIN_TOKEN, { pinPolicy: "touched_files" });
    await seedTouches(harness, ken, "ses_ken", "wc_ken", [PINNED_A, PINNED_B]);

    // Act
    const response = await createPin(harness, nick.apiKey);

    // Assert
    expect(response.status).toBe(403);
  });
});

describe("the attribution setting", () => {
  test("counts_only answers with counts and no sessions at all", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-counts@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    const pin = pinBody({ id: "pin_counts" });
    expect((await createPin(harness, nick.apiKey, pin)).status).toBe(200);
    await seedTouches(harness, nick, "ses_nick", "wc_nick", [PINNED_A, PINNED_B]);
    expect(
      (
        await harness.app.request(
          "/api/pins/pin_counts/broke",
          jsonRequest("POST", nick.apiKey, {}),
        )
      ).status,
    ).toBe(200);
    await writeSettings(harness, TEST_ADMIN_TOKEN, {
      suspectAttribution: "counts_only",
    });

    // Act
    const response = await harness.app.request(
      `/api/suspect?repo=${encodeURIComponent(REPO)}&pin=pin_counts`,
      jsonRequest("GET", nick.apiKey),
    );
    const body = (await response.json()) as {
      data: {
        outcome: string;
        attribution: string;
        candidates: readonly unknown[];
        totals: { sessionsTouching: number };
      };
    };

    // Assert: the count is still the truth — silence about WHETHER anything
    // touched the surface would be a different (and worse) answer.
    expect(body.data.outcome).toBe("withheld");
    expect(body.data.attribution).toBe("counts_only");
    expect(body.data.candidates).toHaveLength(0);
    expect(body.data.totals.sessionsTouching).toBe(1);
  });
});
