/**
 * THE BANNERS REUSE WHAT LIVENESS SAID (round-1 review M8, round-2 R2-L4).
 * The settings read and the feed both say how many drafts wait, and the feed
 * refreshes itself; running every pending draft's liveness check on each of
 * them, under PGlite's one connection, made every render pay for the whole
 * page. A banner now reuses the last liveness answer for 30 seconds while the
 * person's undecided drafts are unchanged; any new, edited or decided draft
 * is seen at once. The confirm page and the confirmation itself always check
 * liveness afresh.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { REPO, createOutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest } from "./helpers.ts";

const REUSE_S = 30;

interface Waiting {
  readonly presenceOnPending: boolean;
  readonly pendingDrafts: number;
}

const settingsOf = async (world: OutcomeWorld): Promise<Waiting> => {
  const response = await world.harness.app.request("/api/settings", jsonRequest("GET", world.nick.apiKey));
  const data = ((await response.json()) as { data: Waiting }).data;
  return { presenceOnPending: data.presenceOnPending, pendingDrafts: data.pendingDrafts };
};

const put = (world: OutcomeWorld, optOut: boolean): Promise<Response> =>
  Promise.resolve(world.harness.app.request("/api/settings/presence", jsonRequest("PUT", world.nick.apiKey, { optOut })));

describe("the waiting-drafts banners", () => {
  test("an unchanged pending set reuses its liveness for 30 seconds, then is checked again", async () => {
    // Arrange — presence off, a request to show it again waiting, the banner read once
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    expect((await put(world, true)).status).toBe(200);
    expect((await put(world, false)).status).toBe(202);
    expect(await settingsOf(world)).toEqual({ presenceOnPending: true, pendingDrafts: 1 });
    // The draft dies without the pending set changing: presence is on again by another way
    await world.harness.db.execute(sql`UPDATE developers SET presence_opt_out = false WHERE id = ${world.nick.developerId}`);

    // Act
    const within = await settingsOf(world);
    world.harness.clock.advanceSeconds(REUSE_S);
    const after = await settingsOf(world);

    // Assert
    expect(within).toEqual({ presenceOnPending: true, pendingDrafts: 1 });
    expect(after).toEqual({ presenceOnPending: false, pendingDrafts: 0 });
  });

  test("a new draft is counted at once, whatever was reused", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    expect(await settingsOf(world)).toEqual({ presenceOnPending: false, pendingDrafts: 0 });

    // Act
    const drafted = await world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: world.delivered.kenContext,
        mark: "noise",
        presence: PIN_PRESENCE_TERMINAL,
      }),
    );

    // Assert
    expect(drafted.status).toBe(201);
    expect(await settingsOf(world)).toEqual({ presenceOnPending: false, pendingDrafts: 1 });
  });
});
