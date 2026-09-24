/**
 * WHICH DELIVERY `crosscheck noise` MEANS (1.0 spec 07 §3.2).
 *
 * The gesture is one word typed beside the session that got a bad
 * intervention, so the hub has to answer "which one was that" without being
 * told much: the caller's own deliveries, on this repo, to the sessions live
 * on the caller's machine, recently. What these pin, in order of how quietly
 * each would go wrong:
 *
 *   · only the CALLER's deliveries — a teammate's would be marked as noise
 *     by somebody who never received it, which the mark route refuses anyway,
 *     and listing it would make the refusal the first thing a person meets;
 *   · never a `suspect` answer — somebody asked for it, and proof 4 is about
 *     what arrived unasked;
 *   · the window and the bound are the hub's to hold, and the cut is said.
 */
import { describe, expect, test } from "bun:test";

import { hintDeliveries } from "../src/db/schema.ts";
import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  registerTestSession,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const MINE = "cc_11111111-2222-4333-8444-555555555555";
const MINE_OTHER = "cc_22222222-2222-4333-8444-555555555555";
const THEIRS = "cc_33333333-2222-4333-8444-555555555555";
const MS_PER_MINUTE = 60_000;

interface Candidate {
  readonly id: string;
  readonly sessionId: string;
  readonly channel: string;
  readonly refKind: string;
  readonly refId: string;
  readonly deliveredAt: string;
}

const setup = async (
  options: { readonly enrolled: boolean } = { enrolled: true },
): Promise<{
  harness: TestHarness;
  nick: TestDeveloper;
  ken: TestDeveloper;
}> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick-cand@example.com");
  const ken = await createTestDeveloper(harness, "Ken", "ken-cand@example.com");
  await registerTestSession(harness, nick.apiKey, { id: MINE, repo: REPO });
  await registerTestSession(harness, nick.apiKey, { id: MINE_OTHER, repo: REPO });
  await registerTestSession(harness, ken.apiKey, { id: THEIRS, repo: REPO });
  if (options.enrolled) {
    await harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: true }),
    );
  }
  return { harness, nick, ken };
};

/** A delivery `minutesAgo` before the harness clock. */
const deliver = async (
  harness: TestHarness,
  row: {
    readonly id: string;
    readonly sessionId: string;
    readonly refId: string;
    readonly channel?: "briefing" | "prompt_hint" | "tripwire" | "suspect" | "unknown";
    readonly minutesAgo: number;
  },
): Promise<void> => {
  await harness.db.insert(hintDeliveries).values({
    id: row.id,
    sessionId: row.sessionId,
    refKind: "work_context",
    refId: row.refId,
    channel: row.channel ?? "prompt_hint",
    deliveredAt: new Date(
      new Date(TEST_START_ISO).getTime() - row.minutesAgo * MS_PER_MINUTE,
    ),
  });
};

const ask = async (
  harness: TestHarness,
  developer: TestDeveloper,
  query: string,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await harness.app.request(
    `/api/pilot-marks/candidates?repo=${encodeURIComponent(REPO)}${query}`,
    jsonRequest("GET", developer.apiKey),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

const candidatesOf = (body: Record<string, unknown>): readonly Candidate[] =>
  ((body.data as { candidates: Candidate[] }).candidates);

describe("GET /api/pilot-marks/candidates", () => {
  test("lists the caller's own recent deliveries, newest first", async () => {
    // Arrange
    const { harness, nick } = await setup();
    await deliver(harness, { id: "hd_old", sessionId: MINE, refId: "wc_one", minutesAgo: 30 });
    await deliver(harness, { id: "hd_new", sessionId: MINE, refId: "wc_two", minutesAgo: 5 });

    // Act
    const { status, body } = await ask(harness, nick, `&session=${MINE}&withinMinutes=60`);

    // Assert
    expect(status).toBe(200);
    expect(candidatesOf(body).map((row) => row.id)).toEqual(["hd_new", "hd_old"]);
    expect(candidatesOf(body)[0]).toMatchObject({
      sessionId: MINE,
      channel: "prompt_hint",
      refKind: "work_context",
      refId: "wc_two",
    });
  });

  test("a teammate's delivery is never offered", async () => {
    // Arrange — even when the caller names that session.
    const { harness, nick } = await setup();
    await deliver(harness, { id: "hd_theirs", sessionId: THEIRS, refId: "wc_one", minutesAgo: 1 });

    // Act
    const { body } = await ask(harness, nick, `&session=${THEIRS}&withinMinutes=60`);

    // Assert
    expect(candidatesOf(body)).toEqual([]);
  });

  test("an answer somebody asked for is not an intervention", async () => {
    // Arrange
    const { harness, nick } = await setup();
    await deliver(harness, {
      id: "hd_pulled",
      sessionId: MINE,
      refId: "wc_one",
      channel: "suspect",
      minutesAgo: 1,
    });

    // Act
    const { body } = await ask(harness, nick, `&session=${MINE}&withinMinutes=60`);

    // Assert
    expect(candidatesOf(body)).toEqual([]);
  });

  test("only the sessions named, when any are named", async () => {
    // Arrange — the sessions live on THIS machine; another laptop's are not
    // the one the person is sitting beside.
    const { harness, nick } = await setup();
    await deliver(harness, { id: "hd_here", sessionId: MINE, refId: "wc_one", minutesAgo: 1 });
    await deliver(harness, { id: "hd_there", sessionId: MINE_OTHER, refId: "wc_one", minutesAgo: 1 });

    // Act
    const { body } = await ask(harness, nick, `&session=${MINE}&withinMinutes=60`);

    // Assert
    expect(candidatesOf(body).map((row) => row.id)).toEqual(["hd_here"]);
  });

  test("a ref the person saw narrows to the deliveries of that ref", async () => {
    // Arrange — hints print the work-context id, never the delivery id.
    const { harness, nick } = await setup();
    await deliver(harness, { id: "hd_a", sessionId: MINE, refId: "wc_one", minutesAgo: 3 });
    await deliver(harness, { id: "hd_b", sessionId: MINE_OTHER, refId: "wc_two", minutesAgo: 2 });

    // Act
    const { body } = await ask(harness, nick, "&ref=wc_one");

    // Assert
    expect(candidatesOf(body).map((row) => row.id)).toEqual(["hd_a"]);
  });

  test("older than the window is not a candidate", async () => {
    // Arrange
    const { harness, nick } = await setup();
    await deliver(harness, { id: "hd_stale", sessionId: MINE, refId: "wc_one", minutesAgo: 61 });

    // Act
    const { body } = await ask(harness, nick, `&session=${MINE}&withinMinutes=60`);

    // Assert
    expect(candidatesOf(body)).toEqual([]);
  });

  test("the list is bounded, and the cut is said", async () => {
    // Arrange — more than any person should be asked to choose between.
    const { harness, nick } = await setup();
    for (let index = 0; index < 8; index += 1) {
      await deliver(harness, {
        id: `hd_${String(index)}`,
        sessionId: MINE,
        refId: `wc_${String(index)}`,
        minutesAgo: index + 1,
      });
    }

    // Act
    const { body } = await ask(harness, nick, `&session=${MINE}&withinMinutes=60`);

    // Assert
    const data = body.data as { candidates: Candidate[]; more: boolean };
    expect(data.candidates).toHaveLength(5);
    expect(data.more).toBe(true);
  });

  test("a repo nobody enrolled is told, not listed", async () => {
    // Arrange
    const { harness, nick } = await setup({ enrolled: false });
    await deliver(harness, { id: "hd_x", sessionId: MINE, refId: "wc_one", minutesAgo: 1 });

    // Act
    const { status, body } = await ask(harness, nick, `&session=${MINE}`);

    // Assert
    expect(status).toBe(422);
    expect((body.error as { code: string }).code).toBe("not_enrolled");
  });

  test("a window that is not a positive whole number is refused", async () => {
    // Arrange
    const { harness, nick } = await setup();

    // Act
    const { status } = await ask(harness, nick, "&withinMinutes=0");

    // Assert
    expect(status).toBe(400);
  });
});
