/**
 * A WEB SESSION IS NEVER SOMEBODY ELSE'S (review L1, probe P7). A session
 * token used to be the developer, the expiry and a signature — so two logins
 * in the same millisecond were ONE session, and an agent logging in with the
 * person's key at that instant shared the person's batches: four of its own
 * evicted the person's, whose tap then failed. Each login now carries a
 * random nonce from the CSPRNG, never the clock. Against the hub as it runs:
 * a frozen clock, a real login, a real passkey assertion.
 */
import { describe, expect, test } from "bun:test";

import { formBatch, pendingOf, prepareConfirmer, signBatch } from "./fixtures/confirm-driver.ts";
import type { FormedBatch } from "./fixtures/confirm-driver.ts";
import { dataOf, viewerOf } from "./fixtures/ceremony-driver.ts";
import { KEN_CONTEXT, NICK_SESSION, createOutcomeWorld, recordOutcome } from "./fixtures/hint-outcome-world.ts";
import { hintOutcomes } from "../src/db/schema.ts";
import { loginUi } from "./ui-helpers.ts";

const AGENT_BATCHES = 4;

describe("a web session per login", () => {
  test("two logins with one key in the same instant are two sessions", async () => {
    // Arrange — the test clock does not move between the two
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });

    // Act
    const first = await loginUi(world.harness, world.nick.apiKey);
    const second = await loginUi(world.harness, world.nick.apiKey);

    // Assert
    expect(second).not.toBe(first);
  });

  test("P7: an agent's login in the person's millisecond forms batches of its own, and the person's still signs", async () => {
    // Arrange — the person's session, a draft, and their batch
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const person = await prepareConfirmer(world.harness, world.nick);
    expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);
    const agent = await viewerOf(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const items = pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "confirm" as const }));
    const batch = await dataOf<FormedBatch>(await formBatch(world.harness, person.viewer, { fingerprint: pending.fingerprint, items }));

    // Act — the agent fills its own session's room, then the person taps
    for (let index = 0; index < AGENT_BATCHES; index += 1) {
      expect((await formBatch(world.harness, agent, { fingerprint: pending.fingerprint, items })).status).toBe(200);
    }
    const signed = await signBatch(world.harness, person, batch.batchId);

    // Assert
    expect(agent.cookie).not.toBe(person.viewer.cookie);
    expect(signed.status).toBe(200);
    expect(await world.harness.db.select().from(hintOutcomes)).toHaveLength(1);
  });
});
