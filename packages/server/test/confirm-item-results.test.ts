/**
 * THE CONFIRMATION SAYS WHAT EACH ITEM DID (round-2 review R2-M2). A writer
 * may write nothing for a confirmed item — one label per person per hint, a
 * word that already stands, a teammate already muted — and the person is told
 * so, item by item, never a blanket "Confirmed N as yours". This is the one
 * thing the confirm-at-once emulation (J16) kept to the pre-0.11 suites; here
 * it is asserted against the hub as it runs: drafts pending, real assertions.
 */
import { describe, expect, test } from "bun:test";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { viewerOf } from "./fixtures/ceremony-driver.ts";
import { confirmPending, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import type { Confirmer } from "./fixtures/confirm-driver.ts";
import { KEN_CONTEXT, NICK_SESSION, REPO, createOutcomeWorld, recordOutcome } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest } from "./helpers.ts";

const MINUTE_S = 60;

interface Answer {
  readonly message: string;
  readonly items: readonly { readonly kind: string; readonly wrote: boolean; readonly why: string | null }[];
}

const label = (world: OutcomeWorld, mark: "helpful" | "noise"): Promise<Response> =>
  Promise.resolve(
    world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: world.delivered.kenContext,
        mark,
        presence: PIN_PRESENCE_TERMINAL,
      }),
    ),
  );

const confirmAll = async (world: OutcomeWorld, confirmer: Confirmer): Promise<Answer> => {
  world.harness.clock.advanceSeconds(MINUTE_S);
  const signed = await confirmPending(world.harness, world.nick, { ...confirmer, viewer: await viewerOf(world.harness, world.nick) });
  expect(signed.status).toBe(200);
  return ((await signed.json()) as { data: Answer }).data;
};

describe("R2-M2: each confirmed item's result, as the writer answered it", () => {
  test("a word that writes says so", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await label(world, "helpful")).status).toBe(201);

    // Act
    const answer = await confirmAll(world, confirmer);

    // Assert
    expect(answer.message).toBe("Confirmed 1 of 1 as yours, discarded 0.");
    expect(answer.items).toEqual([{ kind: "label", wrote: true, why: null }]);
  });

  test("N8: helpful, noise, helpful again — the third writes nothing, and the page says why", async () => {
    // Arrange — the first two confirmed in turn
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    for (const mark of ["helpful", "noise"] as const) {
      expect((await label(world, mark)).status).toBe(201);
      await confirmAll(world, confirmer);
    }
    expect((await label(world, "helpful")).status).toBe(201);

    // Act
    const answer = await confirmAll(world, confirmer);

    // Assert
    expect(answer.message).toBe(
      "Confirmed 0 of 1 as yours — 1 had nothing to write: you had already labelled that hint (one label per hint is yours); discarded 0.",
    );
    expect(answer.items).toEqual([{ kind: "label", wrote: false, why: "you had already labelled that hint (one label per hint is yours)" }]);
  });

  test("a batch where one item writes and one does not says both", async () => {
    // Arrange — helpful already confirmed; then helpful again and a new outcome, in one batch
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await label(world, "helpful")).status).toBe(201);
    await confirmAll(world, confirmer);
    expect((await label(world, "helpful")).status).toBe(201);
    expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);

    // Act
    const answer = await confirmAll(world, confirmer);

    // Assert
    expect(answer.message).toBe(
      "Confirmed 1 of 2 as yours — 1 had nothing to write: you had already labelled that hint (one label per hint is yours); discarded 0.",
    );
    expect([...answer.items].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "label", wrote: false, why: "you had already labelled that hint (one label per hint is yours)" },
      { kind: "outcome", wrote: true, why: null },
    ]);
  });
});
