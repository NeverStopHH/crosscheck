/**
 * The team report's one descriptive outcomes line (1.0 spec 07 §13.9, D-O5).
 *
 * Per repo, per 100 interventions that reached someone: followed, overrode,
 * not relevant now, noise (the label), unmarked. No target, and no
 * per-person split — the block carries counts and nothing that names anybody.
 *
 * IT STARTS WHERE OUTCOMES COULD BE RECORDED (the H1 lesson, 07 §12.9): a
 * delivery from before the repo could record outcomes is not "unmarked", it
 * is outside the population, so `team_settings.pilot_outcomes_since` is stamped
 * when enrolment turns on and the figures start at the later of it and the
 * window's start.
 */
import { describe, expect, test } from "bun:test";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import {
  KEN_CLAIM,
  KEN_CONTEXT,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  deliveryRecord,
  recordOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { TEST_ADMIN_TOKEN, jsonRequest, postRecords } from "./helpers.ts";

const SECONDS_PER_HOUR = 3600;

const reportOf = async (world: OutcomeWorld): Promise<Record<string, unknown>> => {
  const response = await world.harness.app.request(
    `/api/pilot/report?repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", world.nick.apiKey),
  );
  return ((await response.json()) as { data: Record<string, unknown> }).data;
};

const labelNoise = async (world: OutcomeWorld, deliveryId: string): Promise<void> => {
  await world.harness.app.request(
    "/api/pilot-marks",
    jsonRequest("POST", world.nick.apiKey, {
      repo: REPO,
      refKind: "hint_delivery",
      refId: deliveryId,
      mark: "noise",
      presence: PIN_PRESENCE_TERMINAL,
    }),
  );
};

describe("the team report's outcomes block (D-O5)", () => {
  test("counts what every intervention that reached someone led to, over the repo", async () => {
    // Arrange — Nick: followed, overrode, noise label; Mike: followed
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" });
    await recordOutcome(world, world.nick, { ref: KEN_CLAIM, outcome: "overrode", reason: "kept my key" });
    await labelNoise(world, world.delivered.mikeContext);
    await recordOutcome(world, world.mike, { ref: KEN_CONTEXT, outcome: "followed" });

    // Act
    const report = await reportOf(world);

    // Assert
    expect(report["outcomes"]).toEqual({
      sinceIso: world.harness.clock.now().toISOString(),
      interventions: 4,
      followed: 2,
      overrode: 1,
      notRelevantNow: 0,
      noise: 1,
      unmarked: 0,
    });
  });

  test("nobody is named: the block is counts and one instant, nothing else", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CLAIM, outcome: "overrode", reason: "kept my own cache key" });

    // Act
    const said = JSON.stringify((await reportOf(world))["outcomes"]);

    // Assert
    for (const word of ["Nick", "Ken", "Mike", "kept my own cache key", world.nick.developerId]) {
      expect(said).not.toContain(word);
    }
  });

  test("a delivery from before the repo could record outcomes is outside the figures, not unmarked", async () => {
    // Arrange — one more pointer, delivered an hour before enrolment stamped the instant
    const world = await createOutcomeWorld();
    const earlier = new Date(world.harness.clock.now().getTime() - SECONDS_PER_HOUR * 1000).toISOString();
    await postRecords(world.harness, world.nick, {
      records: [deliveryRecord(NICK_SESSION, "work_context", "wc_old_pointer", "prompt_hint", earlier)],
    });

    // Act
    const outcomes = (await reportOf(world))["outcomes"] as Record<string, number>;

    // Assert
    expect(outcomes["interventions"]).toBe(4);
    expect(outcomes["unmarked"]).toBe(4);
  });

  test("a repo nobody enrolled reports no outcome figures and no instant", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: false });

    // Act
    const report = await reportOf(world);

    // Assert
    expect(report["outcomes"]).toEqual({
      sinceIso: null,
      interventions: 0,
      followed: 0,
      overrode: 0,
      notRelevantNow: 0,
      noise: 0,
      unmarked: 0,
    });
  });

  test("enrolment stamps when outcomes became recordable, and a re-enrolment restamps it", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    const first = world.harness.clock.now().toISOString();
    const put = (pilotEnrolled: boolean) =>
      world.harness.app.request(
        "/api/team-settings",
        jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled }),
      );
    const read = async (): Promise<unknown> =>
      ((await (await world.harness.app.request(
        `/api/team-settings?repo=${encodeURIComponent(REPO)}`,
        jsonRequest("GET", world.nick.apiKey),
      )).json()) as { data: Record<string, unknown> }).data["pilotOutcomesSince"];

    // Act
    const atEnrolment = await read();
    world.harness.clock.advanceSeconds(SECONDS_PER_HOUR);
    await put(false);
    const afterLeaving = await read();
    world.harness.clock.advanceSeconds(SECONDS_PER_HOUR);
    await put(true);
    const afterReturning = await read();

    // Assert
    expect(atEnrolment).toBe(first);
    expect(afterLeaving).toBe(first);
    expect(afterReturning).toBe(world.harness.clock.now().toISOString());
  });
});
