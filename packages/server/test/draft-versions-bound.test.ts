/**
 * DRAFT VERSIONS ARE BOUNDED (review M8, probe P12). Two sayings alternated
 * on one subject used to append a version per call, kept forever. A newer
 * version now prunes the superseded ones nothing signed: what stays is the
 * newest, plus any version a confirmed batch named (kept for later, confirmed
 * or discarded) — each of those took the person's own tap. Against the hub as
 * it runs: drafts pending, decisions made with a real passkey assertion.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { confirmPending, pendingOf, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import { KEN_CONTEXT, NICK_SESSION, REPO, createOutcomeWorld, recordOutcome } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest } from "./helpers.ts";

const MINUTE_S = 60;
const ALTERNATIONS = 40;
const WORDS = ["followed", "overrode"] as const;

const say = (world: OutcomeWorld, outcome: "followed" | "overrode"): Promise<Response> =>
  recordOutcome(world, world.nick, {
    ref: KEN_CONTEXT,
    outcome,
    session: NICK_SESSION,
    ...(outcome === "overrode" ? { reason: "kept the existing cache key" } : {}),
  });

/** The stored versions of the outcome subject, oldest first. */
const outcomeVersions = async (world: OutcomeWorld): Promise<readonly number[]> => {
  const rows = await world.harness.db.execute<{ v: number }>(
    sql`SELECT version::int AS v FROM human_drafts WHERE kind = 'outcome' ORDER BY version`,
  );
  return rows.rows.map((row) => row.v);
};

describe("draft versions under churn", () => {
  test("P12: an agent alternating two words on one subject leaves one version, the newest", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });

    // Act
    for (let call = 0; call < ALTERNATIONS; call += 1) {
      expect((await say(world, WORDS[call % WORDS.length] ?? "followed")).status).toBe(201);
    }
    const pending = await pendingOf(world.harness, world.nick);

    // Assert — the newest version is the one that waits, and nothing else is stored
    expect(await outcomeVersions(world)).toEqual([ALTERNATIONS]);
    expect(pending.drafts.map((draft) => [draft.version, draft.payload["word"]])).toEqual([[ALTERNATIONS, "overrode"]]);
  });

  test("a version a signed batch kept for later survives, and the newest still confirms and stands", async () => {
    // Arrange — the outcome kept for later in a batch that confirmed a label
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    expect((await say(world, "followed")).status).toBe(201);
    const label = await world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: world.delivered.kenClaim,
        mark: "noise",
        presence: "controlling_terminal",
      }),
    );
    expect(label.status).toBe(201);
    world.harness.clock.advanceSeconds(MINUTE_S);
    const kept = await confirmPending(world.harness, world.nick, confirmer, (draft) => ({
      decision: draft.kind === "outcome" ? "keep" : "confirm",
    }));
    expect(kept.status).toBe(200);
    world.harness.clock.advanceSeconds(MINUTE_S);

    // Act — two more versions, then confirm what waits
    expect((await say(world, "overrode")).status).toBe(201);
    expect((await say(world, "followed")).status).toBe(201);
    const versions = await outcomeVersions(world);
    world.harness.clock.advanceSeconds(MINUTE_S);
    expect((await confirmPending(world.harness, world.nick, confirmer)).status).toBe(200);
    world.harness.clock.advanceSeconds(MINUTE_S);
    const mine = ((await (
      await world.harness.app.request(`/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO)}`, jsonRequest("GET", world.nick.apiKey))
    ).json()) as { data: Record<string, unknown> }).data;

    // Assert — v1 (signed as kept) stays, v2 (superseded, never signed) is gone, v3 stood
    expect(versions).toEqual([1, 3]);
    expect(mine).toMatchObject({ followed: 1, overrode: 0 });
  });
});
