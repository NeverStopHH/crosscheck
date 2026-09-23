/**
 * THE ONLY HUMAN INPUT THE PILOT TAKES (1.0 spec 07 §3.2).
 *
 * Two gestures, no survey, no free text. §8.3 refuses to add one, because a
 * measurement that interrupts somebody to ask how the measurement is going
 * has changed the thing it measures.
 *
 * WHAT THESE PIN, in order of how easily each could be lost:
 *
 *   · a SECOND mark from the same person is not a second complaint — the
 *     noise figure has to count people, not keystrokes;
 *   · `capture_mode` is stamped by the hub and never carried by the body,
 *     because a mark IS the measurement of whether this product is useful
 *     and a body that could assert "human" would let an agent grade its own
 *     homework;
 *   · every refusal reaches the terminal as a sentence somebody wrote, since
 *     a gesture that appears to do nothing is one a team stops making.
 */
import { describe, expect, test } from "bun:test";

import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { pilotMarks } from "../src/db/schema.ts";
import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const OTHER_REPO = "github.com/acme/web";
const SESSION = "cc_11111111-2222-4333-8444-555555555555";
const DELIVERY = "hd_0123456789abcdef0123456789abcdef";

const setup = async (
  options: { readonly enrolled: boolean } = { enrolled: true },
): Promise<{ harness: TestHarness; developer: TestDeveloper }> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick-marks@example.com",
  );
  await registerTestSession(harness, developer.apiKey, {
    id: SESSION,
    repo: REPO,
  });
  const contextId = `wc_${SESSION}`;
  await postRecords(harness, developer, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: contextId,
          sessionId: SESSION,
          title: "a context to hang a delivery off",
          description: undefined,
          createdAt: TEST_START_ISO,
        }),
        { sessionId: SESSION },
      ),
      recordEnvelope(
        "hint_delivery",
        {
          id: DELIVERY,
          sessionId: SESSION,
          refKind: "work_context",
          refId: contextId,
          channel: "prompt_hint",
          deliveredAt: TEST_START_ISO,
        },
        { sessionId: SESSION },
      ),
    ],
  });
  if (options.enrolled) {
    await harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: true }),
    );
  }
  return { harness, developer };
};

const mark = async (
  harness: TestHarness,
  developer: TestDeveloper,
  overrides: Record<string, unknown> = {},
): Promise<Response> =>
  harness.app.request(
    "/api/pilot-marks",
    jsonRequest("POST", developer.apiKey, {
      repo: REPO,
      refKind: "hint_delivery",
      refId: DELIVERY,
      mark: "off_target",
      presence: PIN_PRESENCE_TERMINAL,
      ...overrides,
    }),
  );

const rows = (harness: TestHarness) => harness.db.select().from(pilotMarks);

describe("POST /api/pilot-marks", () => {
  test("a person at a terminal may mark an intervention off-target", async () => {
    // Arrange & Act
    const { harness, developer } = await setup();
    const response = await mark(harness, developer);

    // Assert
    expect(response.status).toBe(201);
    const stored = await rows(harness);
    expect(stored).toHaveLength(1);
    // STAMPED BY THE HUB. The body said what it OBSERVED; only the hub says
    // what that observation is worth.
    expect(stored[0]?.captureMode).toBe("human");
    expect(stored[0]?.mark).toBe("off_target");
  });

  test("marking the same thing twice is one mark, and SAYS so", async () => {
    // Arrange — the assertion the noise figure rests on: it counts people,
    // not keystrokes. And the caller is told which it was, because a second
    // attempt that answered identically would look like it did nothing.
    const { harness, developer } = await setup();
    await mark(harness, developer);

    // Act
    const again = await mark(harness, developer);
    const body = (await again.json()) as { data: { repeated: boolean } };

    // Assert
    expect(again.status).toBe(200);
    expect(body.data.repeated).toBe(true);
    expect(await rows(harness)).toHaveLength(1);
  });

  test("a body with no presence is refused at the boundary", async () => {
    // Arrange — the literal makes the gate fail CLOSED: absent is a parse
    // failure, never a default. Nothing reaches the database.
    const { harness, developer } = await setup();

    // Act
    const response = await harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", developer.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: DELIVERY,
        mark: "off_target",
      }),
    );

    // Assert
    expect(response.status).toBe(400);
    expect(await rows(harness)).toHaveLength(0);
  });

  test("a body that tries to stamp its own capture_mode does not get to", async () => {
    // Arrange — the field is the hub's. A body naming it is ignored rather
    // than honoured, because the assertion would be the measurement.
    const { harness, developer } = await setup();

    // Act
    await mark(harness, developer, { captureMode: "auto" });

    // Assert
    expect((await rows(harness))[0]?.captureMode).toBe("human");
  });

  test("a repo that never enrolled is TOLD, not silently ignored", async () => {
    // Arrange — a person typed this, and "nothing happened" is the one
    // answer a gesture must never get.
    const { harness, developer } = await setup({ enrolled: false });

    // Act
    const response = await mark(harness, developer);
    const body = (await response.json()) as { error: { code: string } };

    // Assert
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("not_enrolled");
    expect(await rows(harness)).toHaveLength(0);
  });

  test("an unknown id is refused with something to do about it", async () => {
    // Arrange — a mark on an id that does not exist is a row that can never
    // join to anything, and proof 4's denominator would grow with marks
    // about nothing.
    const { harness, developer } = await setup();

    // Act
    const response = await mark(harness, developer, { refId: "hd_nothing" });
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    // Assert
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("unknown_ref");
    expect(body.error.message).toContain("with no argument");
  });

  test("a mark on ANOTHER repo's delivery is refused", async () => {
    // Arrange — one team's noise is not another's, and a cross-repo mark
    // would count it against the wrong one.
    const { harness, developer } = await setup();
    await harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, {
        repo: OTHER_REPO,
        pilotEnrolled: true,
      }),
    );

    // Act
    const response = await mark(harness, developer, { repo: OTHER_REPO });
    const body = (await response.json()) as { error: { code: string } };

    // Assert
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("wrong_repo");
  });
});
