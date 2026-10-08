/**
 * EVERY DRAFTED ANSWER SAYS WHAT HAPPENED IN WORDS (review, "old clients told
 * recorded"). A client that prints the hub's words reads a `notice`: nothing
 * changed yet, and where the passkey makes it count. A 0.10 CLI prints only
 * fixed lines built from `id` and `repeated` and sends no version, so the
 * notice cannot reach its user — spec §10 states that residual; this pins what
 * the hub CAN say, door by door, against the hub as it runs (drafts pending).
 */
import { describe, expect, test } from "bun:test";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { addMute } from "../src/services/developer-settings.ts";
import { createPin } from "../src/services/pins.ts";
import { DRAFT_NOTICE } from "../src/services/draft-doors.ts";
import { confirmPending, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import { seedHumanStamp } from "./fixtures/human-confirmation.ts";
import {
  KEN_CONTEXT,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  recordOutcome,
  recordPersonOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest } from "./helpers.ts";

const MINUTE_S = 60;

const noticeOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { data: Record<string, unknown> }).data["notice"];

const send = (world: OutcomeWorld, method: string, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(world.harness.app.request(path, jsonRequest(method, world.nick.apiKey, body)));

const PIN = {
  id: "pin_notice_1",
  repo: REPO,
  surface: "Play button plays/pauses",
  files: ["src/workbench/PlaybackControls.tsx"],
  check: "open /workbench, press Play",
  presence: PIN_PRESENCE_TERMINAL,
  verifiedAtCommit: "abc1234",
} as const;

/** A confirmed pin, so a break has something to draft against. */
const seedConfirmedPin = async (world: OutcomeWorld, id: string): Promise<void> => {
  const stamp = await seedHumanStamp(world.harness.db, world.nick.developerId);
  await createPin({ db: world.harness.db, now: world.harness.clock.now }, world.nick.developerId, { ...PIN, files: [...PIN.files], id }, stamp);
};

describe("the notice on every drafted answer", () => {
  test("its words name what is true: nothing changed yet, the passkey, and the page", () => {
    // Assert
    expect(DRAFT_NOTICE.waiting).toContain("nothing changed yet");
    expect(DRAFT_NOTICE.waiting).toContain("passkey");
    expect(DRAFT_NOTICE.waiting).toContain("/ui/confirm");
    expect(DRAFT_NOTICE.waiting).not.toContain("recorded");
  });

  test("each door that drafts says so in its notice", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    await seedConfirmedPin(world, "pin_notice_confirmed");
    await addMute({ db: world.harness.db, now: world.harness.clock.now }, world.nick.developerId, world.mike.developerId, await seedHumanStamp(world.harness.db, world.nick.developerId));
    await send(world, "PUT", "/api/settings/presence", { optOut: true });

    // Act
    const answers = {
      label: await send(world, "POST", "/api/pilot-marks", {
        repo: REPO,
        refKind: "hint_delivery",
        refId: world.delivered.kenContext,
        mark: "helpful",
        presence: PIN_PRESENCE_TERMINAL,
      }),
      agentOutcome: await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION }),
      pin: await send(world, "POST", "/api/pins", PIN),
      pinBreak: await send(world, "POST", "/api/pins/pin_notice_confirmed/broke", { repo: REPO, presence: PIN_PRESENCE_TERMINAL }),
      mute: await send(world, "POST", "/api/settings/mutes", { developer: world.ken.developerId }),
      unmute: await send(world, "DELETE", `/api/settings/mutes/${world.mike.developerId}`),
      presenceOn: await send(world, "PUT", "/api/settings/presence", { optOut: false }),
    };
    const notices = Object.fromEntries(
      await Promise.all(Object.entries(answers).map(async ([door, response]) => [door, await noticeOf(response)] as const)),
    );

    // Assert
    expect(notices).toEqual({
      label: DRAFT_NOTICE.waiting,
      agentOutcome: DRAFT_NOTICE.waiting,
      pin: DRAFT_NOTICE.waiting,
      pinBreak: DRAFT_NOTICE.waiting,
      mute: DRAFT_NOTICE.waiting,
      unmute: DRAFT_NOTICE.waiting,
      presenceOn: DRAFT_NOTICE.waiting,
    });
  });

  test("the person's outcome door, and a repeat while the draft waits, say the same", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });

    // Act
    const first = await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });
    const again = await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" });

    // Assert
    expect([await noticeOf(first), await noticeOf(again)]).toEqual([DRAFT_NOTICE.waiting, DRAFT_NOTICE.waiting]);
  });

  test("the agent re-offering a word the person discarded is told nothing was drafted", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);
    world.harness.clock.advanceSeconds(MINUTE_S);
    expect((await confirmPending(world.harness, world.nick, confirmer, () => ({ decision: "discard" }))).status).toBe(200);
    world.harness.clock.advanceSeconds(MINUTE_S);

    // Act
    const again = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION });

    // Assert
    expect(await noticeOf(again)).toBe(DRAFT_NOTICE.discardedByPerson);
  });
});
