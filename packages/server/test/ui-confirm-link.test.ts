/**
 * THE PERSON CAN FIND THE CONFIRM PAGE (review M7). Every signed-in page links
 * to /ui/confirm, and the feed says when drafts wait — and, spec §8, that a
 * request to show their presence again is among them. Against the hub as it
 * runs: the drafts are left pending.
 */
import { describe, expect, test } from "bun:test";

import { KEN_CONTEXT, REPO, createOutcomeWorld, recordPersonOutcome } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest } from "./helpers.ts";
import { loginUi, uiGet } from "./ui-helpers.ts";

const CONFIRM_LINK = 'href="/ui/confirm"';
const PRESENCE_WAITING = "a request to show your presence again is waiting for your passkey";

const pageOf = async (world: OutcomeWorld, path: string): Promise<string> =>
  await (await uiGet(world.harness, path, await loginUi(world.harness, world.nick.apiKey))).text();

const presence = (world: OutcomeWorld, optOut: boolean): Promise<Response> =>
  Promise.resolve(world.harness.app.request("/api/settings/presence", jsonRequest("PUT", world.nick.apiKey, { optOut })));

describe("the way to the confirm page", () => {
  test("every signed-in page's navigation links to it", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });

    // Act
    const pages = await Promise.all(["/ui/feed", "/ui/members", "/ui/passkeys", "/ui/confirm"].map((path) => pageOf(world, path)));

    // Assert
    expect(pages.map((html) => html.includes(CONFIRM_LINK))).toEqual([true, true, true, true]);
  });

  test("the feed says how many drafts wait for the passkey, and links to them", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    expect((await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" })).status).toBe(201);
    expect(
      (
        await world.harness.app.request(
          "/api/pilot-marks",
          jsonRequest("POST", world.nick.apiKey, {
            repo: REPO,
            refKind: "hint_delivery",
            refId: world.delivered.kenClaim,
            mark: "noise",
            presence: "controlling_terminal",
          }),
        )
      ).status,
    ).toBe(201);

    // Act
    const html = await pageOf(world, "/ui/feed");

    // Assert
    expect(html).toContain("2 of your drafts wait for your passkey");
    expect(html).not.toContain(PRESENCE_WAITING);
  });

  test("with nothing waiting, the feed says nothing about drafts", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });

    // Act
    const html = await pageOf(world, "/ui/feed");

    // Assert
    expect(html).not.toContain("wait for your passkey");
    expect(html).not.toContain("waits for your passkey");
  });

  test("§8: a request to show presence again is named on the feed while it waits", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    expect((await presence(world, true)).status).toBe(200);
    expect((await presence(world, false)).status).toBe(202);

    // Act
    const html = await pageOf(world, "/ui/feed");

    // Assert
    expect(html).toContain("1 of your drafts waits for your passkey");
    expect(html).toContain(PRESENCE_WAITING);
  });
});
