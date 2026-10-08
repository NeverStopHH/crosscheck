/**
 * /ui/confirm (human provenance §6, step 2): the pending drafts with their
 * context and who drafted them, the fingerprint of exactly that set, and the
 * one script WebAuthn needs — honest about a hub where nothing can be signed.
 */
import { describe, expect, test } from "bun:test";

import { pendingOf } from "./fixtures/confirm-driver.ts";
import { KEN_CONTEXT, NICK_SESSION, createOutcomeWorld, recordOutcome } from "./fixtures/hint-outcome-world.ts";
import { loginUi, uiGet } from "./ui-helpers.ts";

describe("GET /ui/confirm", () => {
  test("lists each pending draft with who drafted it, what it points at, and the set's fingerprint", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION });
    const cookie = await loginUi(world.harness, world.nick.apiKey);

    // Act
    const response = await uiGet(world.harness, "/ui/confirm", cookie);
    const html = await response.text();
    const pending = await pendingOf(world.harness, world.nick);

    // Assert
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(html).toContain("drafted by your agent");
    expect(html).toContain("what a hint led to");
    expect(html).toContain("«Widen the filter row»");
    expect(html).toContain("by Ken");
    expect(html).toContain(`value="${pending.fingerprint}"`);
    expect(html).toContain(`data-draft-id="${pending.drafts[0]?.id ?? "missing"}"`);
    expect(html).toContain('src="/ui/passkey.js"');
  });

  test("with nothing pending, it says so and offers nothing to sign", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    const cookie = await loginUi(world.harness, world.nick.apiKey);

    // Act
    const html = await (await uiGet(world.harness, "/ui/confirm", cookie)).text();

    // Assert
    expect(html).toContain("Nothing waits for you.");
    expect(html).not.toContain("data-confirm-batch");
  });

  test("another person's drafts never reach the page", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION });
    const cookie = await loginUi(world.harness, world.ken.apiKey);

    // Act
    const html = await (await uiGet(world.harness, "/ui/confirm", cookie)).text();

    // Assert
    expect(html).toContain("Nothing waits for you.");
  });

  test("without a session it is the login, never the drafts", async () => {
    // Arrange
    const world = await createOutcomeWorld();

    // Act
    const response = await uiGet(world.harness, "/ui/confirm", null);

    // Assert
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/ui/login");
  });
});
