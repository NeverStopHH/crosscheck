/**
 * A WORD CONFIRMED AFTER ITS MONTH CLOSED (human provenance; review M6, P14).
 *
 * Drafts make a lag between saying a word and confirming it structural: a
 * person confirms in batches. A word drafted in July about a July hint and
 * confirmed on 2 August arrived after July's figures were frozen, and its
 * hint is not August's. The honest place for it is the month it was
 * CONFIRMED, marked LATE and kept apart from that month's own interventions —
 * never re-opening a closed month (reading a closed month before and after a
 * change shows whose word it was) and never lost between the two.
 *
 * Against the hub as it runs: the agent drafts in July, the person confirms
 * in August with a passkey past its cool-off.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { readPeriodAggregate } from "../src/services/outcome-population.ts";
import { confirmPending, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import { viewerOf } from "./fixtures/ceremony-driver.ts";
import {
  KEN_CONTEXT,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  recordOutcome,
  recordPersonOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";

const DAY_S = 86_400;
const JULY = { from: new Date("2026-07-01T00:00:00.000Z"), until: new Date("2026-08-01T00:00:00.000Z") };
const AUGUST = { from: new Date("2026-08-01T00:00:00.000Z"), until: new Date("2026-09-01T00:00:00.000Z") };

const aggregate = (world: OutcomeWorld, period: { readonly from: Date; readonly until: Date }) =>
  readPeriodAggregate(world.harness.db, { repo: REPO, ...period, who: sql`true`, sourceIs: null, at: world.harness.clock.now() });

/** The agent's followed on a July hint, confirmed by the person `wait` seconds later. */
const confirmedAfter = async (wait: number): Promise<OutcomeWorld> => {
  const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
  const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
  expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);
  world.harness.clock.advanceSeconds(wait);
  const fresh = { ...confirmer, viewer: await viewerOf(world.harness, world.nick) };
  expect((await confirmPending(world.harness, world.nick, fresh)).status).toBe(200);
  return world;
};

describe("a word confirmed after its hint's month closed", () => {
  test("counts in the month it was confirmed, marked late, apart from that month's own interventions", async () => {
    // Arrange — a July hint, confirmed on 2 August
    const world = await confirmedAfter(9 * DAY_S);

    // Act
    const july = await aggregate(world, JULY);
    const august = await aggregate(world, AUGUST);

    // Assert — July stays as it closed; August carries it as late, not as an August intervention
    expect(july).toMatchObject({ followed: 0 });
    expect(august).toMatchObject({ followed: 0, interventions: 0, late: { followed: 1, overrode: 0, notRelevantNow: 0, noise: 0 } });
    expect(august.recorders).toBe(1);
  });

  test("confirmed inside its own month, it is that month's word and nobody's late one", async () => {
    // Arrange — the control: confirmed the next day, still July
    const world = await confirmedAfter(DAY_S);

    // Act
    const july = await aggregate(world, JULY);
    const august = await aggregate(world, AUGUST);

    // Assert
    expect(july).toMatchObject({ followed: 1, late: { followed: 0 } });
    expect(august).toMatchObject({ followed: 0, late: { followed: 0 } });
  });

  test("a word confirmed in August that counts nowhere yet drags July's word into August by nothing", async () => {
    // Arrange — July's word confirmed in July; in August a fresh passkey, still cooling, confirms overrode
    const world = await confirmedAfter(DAY_S);
    world.harness.clock.advanceSeconds(9 * DAY_S);
    const cooling = await prepareConfirmer(world.harness, world.nick);
    expect(
      (await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "kept the old key" })).status,
    ).toBe(201);
    expect((await confirmPending(world.harness, world.nick, cooling)).status).toBe(200);

    // Act
    const august = await aggregate(world, AUGUST);

    // Assert — the word standing in figures is July's, said before August: not August's, late or not
    expect(august).toMatchObject({ followed: 0, interventions: 0, late: { followed: 0, overrode: 0, notRelevantNow: 0, noise: 0 } });
  });
});
