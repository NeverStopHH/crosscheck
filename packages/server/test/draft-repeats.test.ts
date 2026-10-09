/**
 * A REPEAT NEVER EATS THE PERSON'S WORD (human provenance §4; review H2, H3).
 *
 * A draft that says what its subject's newest version says is a repeat only
 * while that version still WAITS on the page. Once it was decided — confirmed
 * or discarded — saying it again is a new draft: the person says noise again
 * (07 §13.11 H-B), says their word again after their own noise label, says a
 * word they discarded when the agent said it, asks for a mute they once
 * discarded, switches presence back on as often as they switch it off. The one
 * exception: the agent re-offering its own word the person discarded is not
 * put back on the page.
 *
 * Against the hub as it runs: drafts left pending, every decision made with a
 * real passkey assertion over a frozen batch. A door answering "drafted" is
 * checked against the page: something waits there.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { developerMutes, hintOutcomes, noiseReassertions, pilotMarks } from "../src/db/schema.ts";
import { confirmPending, pendingOf, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import type { Confirmer } from "./fixtures/confirm-driver.ts";
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
const PRESENCE_CYCLES = 3;

const bodyOf = async (response: Response): Promise<Record<string, unknown>> =>
  ((await response.json()) as { data: Record<string, unknown> }).data;

const markNoise = (world: OutcomeWorld, refId: string): Promise<Response> =>
  Promise.resolve(
    world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId,
        mark: "noise",
        presence: PIN_PRESENCE_TERMINAL,
      }),
    ),
  );

const mine = async (world: OutcomeWorld): Promise<Record<string, unknown>> =>
  bodyOf(
    await world.harness.app.request(`/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO)}`, jsonRequest("GET", world.nick.apiKey)),
  );

const presence = (world: OutcomeWorld, optOut: boolean): Promise<Response> =>
  Promise.resolve(world.harness.app.request("/api/settings/presence", jsonRequest("PUT", world.nick.apiKey, { optOut })));

const optedOut = async (world: OutcomeWorld): Promise<boolean> => {
  const rows = await world.harness.db.execute<{ o: boolean }>(
    sql`SELECT presence_opt_out AS o FROM developers WHERE id = ${world.nick.developerId}`,
  );
  return rows.rows[0]?.o === true;
};

const mute = (world: OutcomeWorld): Promise<Response> =>
  Promise.resolve(
    world.harness.app.request("/api/settings/mutes", jsonRequest("POST", world.nick.apiKey, { developer: world.ken.developerId })),
  );

const waiting = async (world: OutcomeWorld): Promise<number> => (await pendingOf(world.harness, world.nick)).drafts.length;

const confirmAll = async (world: OutcomeWorld, confirmer: Confirmer): Promise<void> => {
  world.harness.clock.advanceSeconds(MINUTE_S);
  expect((await confirmPending(world.harness, world.nick, confirmer)).status).toBe(200);
  world.harness.clock.advanceSeconds(MINUTE_S);
};

const discardAll = async (world: OutcomeWorld, confirmer: Confirmer): Promise<void> => {
  world.harness.clock.advanceSeconds(MINUTE_S);
  expect((await confirmPending(world.harness, world.nick, confirmer, () => ({ decision: "discard" }))).status).toBe(200);
  world.harness.clock.advanceSeconds(MINUTE_S);
};

describe("saying a word again after it was decided", () => {
  test("H-B: the person says noise again over their own later word — a new draft, and once confirmed it stands", async () => {
    // Arrange — noise (confirmed), then their own overrode (confirmed)
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await markNoise(world, world.delivered.kenContext)).status).toBe(201);
    await confirmAll(world, confirmer);
    expect((await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept mine" })).status).toBe(201);
    await confirmAll(world, confirmer);
    expect(await mine(world)).toMatchObject({ overrode: 1, noise: 0 });

    // Act — noise again
    const again = await markNoise(world, world.delivered.kenContext);

    // Assert — drafted, waiting, and the person's once they confirm it
    expect(again.status).toBe(201);
    expect(await bodyOf(again)).toMatchObject({ repeated: false, draft: true });
    expect(await waiting(world)).toBe(1);
    await confirmAll(world, confirmer);
    expect(await world.harness.db.select().from(noiseReassertions)).toHaveLength(1);
    expect(await mine(world)).toMatchObject({ overrode: 0, noise: 1 });
  });

  test("the person's same word again after their own noise label is drafted, and once confirmed it stands", async () => {
    // Arrange — their followed (confirmed), then their noise label (confirmed)
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" })).status).toBe(201);
    await confirmAll(world, confirmer);
    expect((await markNoise(world, world.delivered.kenContext)).status).toBe(201);
    await confirmAll(world, confirmer);
    expect(await mine(world)).toMatchObject({ followed: 0, noise: 1 });

    // Act — followed again
    const again = await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert
    expect(again.status).toBe(201);
    expect(await bodyOf(again)).toMatchObject({ repeated: false, draft: true });
    expect(await waiting(world)).toBe(1);
    await confirmAll(world, confirmer);
    expect(await mine(world)).toMatchObject({ followed: 1, noise: 0 });
  });

  test("a word the person discarded when the agent said it, said by the person, is theirs to confirm", async () => {
    // Arrange — the agent's followed, discarded
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);
    await discardAll(world, confirmer);

    // Act — the person types it
    const person = await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert — drafted in the terminal's class, waiting; confirmed, it counts
    expect(person.status).toBe(201);
    expect(await bodyOf(person)).toMatchObject({ repeated: false, provenance: "interactive_terminal_asserted" });
    expect((await pendingOf(world.harness, world.nick)).drafts.map((draft) => draft.provenance)).toEqual(["interactive_terminal_asserted"]);
    await confirmAll(world, confirmer);
    expect(await world.harness.db.select({ outcome: hintOutcomes.outcome }).from(hintOutcomes)).toEqual([{ outcome: "followed" }]);
  });

  test("the person's word repeating the agent's draft still waiting takes the person's class, not the agent's", async () => {
    // Arrange — the agent's followed, waiting
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);

    // Act
    const person = await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });

    // Assert — one waiting draft, now the terminal's
    expect(await bodyOf(person)).toMatchObject({ repeated: false });
    expect((await pendingOf(world.harness, world.nick)).drafts.map((draft) => draft.provenance)).toEqual(["interactive_terminal_asserted"]);
  });

  test("the agent re-offering its own word the person discarded is not put back on the page, and is told why", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);
    await discardAll(world, confirmer);

    // Act
    const again = await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION });

    // Assert — a repeat, nothing waits, and the answer says the person discarded it
    expect(again.status).toBe(200);
    expect(await bodyOf(again)).toMatchObject({ repeated: true, waiting: false, discardedByPerson: true });
    expect(await waiting(world)).toBe(0);
  });

  test("a word repeated while its draft still waits writes nothing, and the answer says it waits", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    expect((await markNoise(world, world.delivered.kenContext)).status).toBe(201);

    // Act
    const again = await markNoise(world, world.delivered.kenContext);

    // Assert
    expect(again.status).toBe(200);
    expect(await bodyOf(again)).toMatchObject({ repeated: true, waiting: true });
    expect(await waiting(world)).toBe(1);
  });

  test("helpful said again after it was confirmed is one label: the second confirmation writes no second row", async () => {
    // Arrange — the person's helpful, confirmed
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    const helpful = (): Promise<Response> =>
      Promise.resolve(
        world.harness.app.request(
          "/api/pilot-marks",
          jsonRequest("POST", world.nick.apiKey, {
            repo: REPO,
            refKind: "hint_delivery",
            refId: world.delivered.kenContext,
            mark: "helpful",
            presence: PIN_PRESENCE_TERMINAL,
          }),
        ),
      );
    expect((await helpful()).status).toBe(201);
    await confirmAll(world, confirmer);

    // Act — said again: a new draft (the first was decided), confirmed too
    expect((await helpful()).status).toBe(201);
    await confirmAll(world, confirmer);

    // Assert — one person, one label: the noise figure counts people, not keystrokes
    const labels = await world.harness.db.select({ mark: pilotMarks.mark }).from(pilotMarks);
    expect(labels).toEqual([{ mark: "helpful" }]);
  });
});

describe("settings asked for again after a decision", () => {
  test("presence back on can be drafted and confirmed any number of times; every 202 has a draft waiting", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick);

    for (let cycle = 0; cycle < PRESENCE_CYCLES; cycle += 1) {
      // Act — off by key (immediate), then on (a draft)
      expect((await presence(world, true)).status).toBe(200);
      world.harness.clock.advanceSeconds(MINUTE_S);
      const on = await presence(world, false);

      // Assert — the 202 is true: it waits on the page; confirmed, presence is on
      expect(on.status).toBe(202);
      expect(await waiting(world)).toBe(1);
      await confirmAll(world, confirmer);
      expect(await optedOut(world)).toBe(false);
    }
  });

  test("presence back on after a DISCARDED request is drafted again", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    expect((await presence(world, true)).status).toBe(200);
    expect((await presence(world, false)).status).toBe(202);
    await discardAll(world, confirmer);
    expect(await optedOut(world)).toBe(true);

    // Act
    const on = await presence(world, false);

    // Assert
    expect(on.status).toBe(202);
    expect(await waiting(world)).toBe(1);
    await confirmAll(world, confirmer);
    expect(await optedOut(world)).toBe(false);
  });

  test("a mute the person once discarded can be asked for again, and confirmed", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    expect((await mute(world)).status).toBe(202);
    await discardAll(world, confirmer);

    // Act
    const again = await mute(world);

    // Assert
    expect(again.status).toBe(202);
    expect(await waiting(world)).toBe(1);
    await confirmAll(world, confirmer);
    expect(await world.harness.db.select({ muted: developerMutes.mutedDeveloperId }).from(developerMutes)).toEqual([
      { muted: world.ken.developerId },
    ]);
  });
});

describe("the label walk after a decision", () => {
  test("a pointer whose label draft was discarded is offered again; one still waiting is not", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const offered = async (): Promise<readonly string[]> => {
      const response = await world.harness.app.request(
        `/api/pilot-marks/unlabeled?repo=${encodeURIComponent(REPO)}&withinMinutes=600`,
        jsonRequest("GET", world.nick.apiKey),
      );
      const data = (await bodyOf(response)) as { candidates: readonly { id: string }[] };
      return data.candidates.map((candidate) => candidate.id);
    };
    expect((await markNoise(world, world.delivered.kenContext)).status).toBe(201);
    const whileWaiting = await offered();

    // Act
    await discardAll(world, confirmer);
    const afterDiscard = await offered();

    // Assert
    expect(whileWaiting).not.toContain(world.delivered.kenContext);
    expect(afterDiscard).toContain(world.delivered.kenContext);
  });
});
