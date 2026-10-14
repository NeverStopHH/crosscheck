/**
 * THE DISCLOSURE MINIMUMS HOLD FOR EACH PRINTED FIGURE ON ITS OWN (round-2
 * review R2-H2, the owner's decision). A month's own figure and its late
 * figure print apart, so each must pass apart: late words from four people
 * never lift a month whose own figure is one person's verdict over the
 * minimums (N3, N12), and a month's own figure from four people never carries
 * one person's late words beside it (the reverse). A figure that does not pass
 * prints the generic sentence — here, no count.
 *
 * Against the hub as it runs: a five-person team, drafts pending, every word
 * confirmed with the person's own passkey past its cool-off.
 */
import { describe, expect, test } from "bun:test";

import { confirmPending, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import {
  ANNA_CONTEXT,
  ANNA_SESSION,
  LENA_CONTEXT,
  LENA_SESSION,
  NICK_CONTEXT,
  SECONDS_TO_AUGUST,
  addTeammate,
  recordCrowdWords,
} from "./fixtures/hint-outcome-crowd.ts";
import type { Crowd } from "./fixtures/hint-outcome-crowd.ts";
import {
  KEN_CLAIM,
  KEN_CONTEXT,
  KEN_SESSION,
  MIKE_CONTEXT,
  MIKE_SESSION,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  deliveryRecord,
  recordOutcome,
} from "./fixtures/hint-outcome-world.ts";
import { jsonRequest, postRecords, registerTestSession } from "./helpers.ts";
import type { TestDeveloper } from "./helpers.ts";

const DAY_S = 86_400;

type Ref = readonly ["work_context" | "claim", string];

const pendingCrowd = async (): Promise<Crowd> => {
  const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
  const anna = await addTeammate(world, "Anna", ANNA_SESSION);
  const lena = await addTeammate(world, "Lena", LENA_SESSION);
  const ctx = (ref: string): Ref => ["work_context", ref];
  const kenClaim: Ref = ["claim", KEN_CLAIM];
  const deliver = (developer: TestDeveloper, session: string, refs: readonly Ref[]) =>
    postRecords(world.harness, developer, { records: refs.map(([kind, ref]) => deliveryRecord(session, kind, ref, "prompt_hint")) });
  await deliver(world.nick, NICK_SESSION, [ctx(ANNA_CONTEXT), ctx(LENA_CONTEXT)]);
  await deliver(world.ken, KEN_SESSION, [ctx(NICK_CONTEXT), ctx(MIKE_CONTEXT), ctx(ANNA_CONTEXT), ctx(LENA_CONTEXT)]);
  await deliver(world.mike, MIKE_SESSION, [kenClaim, ctx(NICK_CONTEXT), ctx(ANNA_CONTEXT), ctx(LENA_CONTEXT)]);
  await deliver(anna, ANNA_SESSION, [ctx(KEN_CONTEXT), kenClaim, ctx(NICK_CONTEXT), ctx(MIKE_CONTEXT), ctx(LENA_CONTEXT)]);
  await deliver(lena, LENA_SESSION, [ctx(KEN_CONTEXT), kenClaim, ctx(NICK_CONTEXT), ctx(MIKE_CONTEXT), ctx(ANNA_CONTEXT)]);
  return { ...world, anna, lena };
};

const everyoneConfirms = async (crowd: Crowd, people: readonly TestDeveloper[]): Promise<void> => {
  for (const person of people) {
    const confirmer = await prepareConfirmer(crowd.harness, person, { pastCoolOff: true });
    expect((await confirmPending(crowd.harness, person, confirmer)).status).toBe(200);
  }
};

/** A fresh session for `developer` in August, and one hint in it pointing at `ref`. */
const augustHint = async (crowd: Crowd, developer: TestDeveloper, session: string, ref: string): Promise<void> => {
  await registerTestSession(crowd.harness, developer.apiKey, { id: session, repo: REPO });
  await postRecords(crowd.harness, developer, {
    records: [deliveryRecord(session, "work_context", ref, "prompt_hint", crowd.harness.clock.now().toISOString())],
  });
};

const teamLine = async (crowd: Crowd): Promise<Record<string, unknown>> => {
  const response = await crowd.harness.app.request(`/api/pilot/report?repo=${encodeURIComponent(REPO)}`, jsonRequest("GET", crowd.nick.apiKey));
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { outcomes: Record<string, unknown> } }).data.outcomes;
};

const mine = async (crowd: Crowd, developer: TestDeveloper): Promise<Record<string, unknown>> =>
  ((await (
    await crowd.harness.app.request(`/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO)}`, jsonRequest("GET", developer.apiKey))
  ).json()) as { data: Record<string, unknown> }).data;

describe("R2-H2: each printed figure meets the minimums on its own", () => {
  test("N3: August's own figure is Ken's single verdict — withheld, while the late words of four people print", async () => {
    // Arrange — four people's July words confirmed on 2 August (late); Ken's one August word
    const crowd = await pendingCrowd();
    await recordCrowdWords(crowd);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    const session = "cc_ffffffff-1111-4111-8111-111111111111";
    await augustHint(crowd, crowd.ken, session, NICK_CONTEXT);
    expect((await recordOutcome(crowd, crowd.ken, { ref: NICK_CONTEXT, outcome: "overrode", reason: "did it my way", session })).status).toBe(201);
    await everyoneConfirms(crowd, [crowd.nick, crowd.mike, crowd.anna, crowd.lena, crowd.ken]);

    // Act — August, read in September
    crowd.harness.clock.advanceSeconds(31 * DAY_S);
    const august = await teamLine(crowd);

    // Assert
    expect(august["periodStartIso"]).toBe("2026-08-01T00:00:00.000Z");
    expect(august["withheld"]).toBe("below_minimums");
    expect(august["figures"]).toBeNull();
    expect(august["late"]).toEqual({ withheld: null, figures: { followed: 9, overrode: 3, notRelevantNow: 2, noise: 1 } });
  }, 120_000);

  test("the reverse: August's own figure from four people prints, while Ken's one late word is withheld", async () => {
    // Arrange — Ken's July word, confirmed in August; four people's August words on August hints
    const crowd = await pendingCrowd();
    expect((await recordOutcome(crowd, crowd.ken, { ref: NICK_CONTEXT, outcome: "followed" })).status).toBe(201);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    const people = [
      [crowd.nick, "cc_f1f1f1f1-1111-4111-8111-111111111111"],
      [crowd.mike, "cc_f2f2f2f2-1111-4111-8111-111111111111"],
      [crowd.anna, "cc_f3f3f3f3-1111-4111-8111-111111111111"],
      [crowd.lena, "cc_f4f4f4f4-1111-4111-8111-111111111111"],
    ] as const;
    const refs = [KEN_CONTEXT, MIKE_CONTEXT, ANNA_CONTEXT, LENA_CONTEXT, NICK_CONTEXT];
    for (const [person, session] of people) {
      await registerTestSession(crowd.harness, person.apiKey, { id: session, repo: REPO });
      await postRecords(crowd.harness, person, {
        records: refs.map((ref) => deliveryRecord(session, "work_context", ref, "prompt_hint", crowd.harness.clock.now().toISOString())),
      });
      for (const ref of refs) {
        expect((await recordOutcome(crowd, person, { ref, outcome: "followed", session })).status).toBe(201);
      }
    }
    await everyoneConfirms(crowd, [crowd.nick, crowd.mike, crowd.anna, crowd.lena, crowd.ken]);

    // Act
    crowd.harness.clock.advanceSeconds(31 * DAY_S);
    const august = await teamLine(crowd);

    // Assert — own figure printed; the late line is one person's: no count
    expect(august["withheld"]).toBeNull();
    expect(august["figures"]).toMatchObject({ followed: 20 });
    expect(august["late"]).toEqual({ withheld: "below_minimums", figures: null });
  }, 120_000);

  test("N12: Nick's August credit — one teammate's follow and three late ones — prints neither number", async () => {
    // Arrange — Mike, Anna and Lena follow Nick's July work, confirmed in August; Ken follows it once in August
    const crowd = await pendingCrowd();
    for (const follower of [crowd.mike, crowd.anna, crowd.lena]) {
      expect((await recordOutcome(crowd, follower, { ref: NICK_CONTEXT, outcome: "followed" })).status).toBe(201);
    }
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    const session = "cc_ffffffff-2222-4222-8222-222222222222";
    await augustHint(crowd, crowd.ken, session, NICK_CONTEXT);
    expect((await recordOutcome(crowd, crowd.ken, { ref: NICK_CONTEXT, outcome: "followed", session })).status).toBe(201);
    await everyoneConfirms(crowd, [crowd.mike, crowd.anna, crowd.lena, crowd.ken]);

    // Act
    crowd.harness.clock.advanceSeconds(31 * DAY_S);
    const credit = (await mine(crowd, crowd.nick))["yourWork"];

    // Assert
    expect(credit).toMatchObject({
      periodStartIso: "2026-08-01T00:00:00.000Z",
      withheld: "below_minimums",
      followed: null,
      late: { withheld: "below_minimums", followed: null },
    });
  }, 120_000);

  test("the credit's reverse: four teammates' August follows print, while Ken's one late follow is withheld", async () => {
    // Arrange — Ken follows Nick's July work, confirmed in August (late); four teammates follow it on August hints
    const crowd = await pendingCrowd();
    expect((await recordOutcome(crowd, crowd.ken, { ref: NICK_CONTEXT, outcome: "followed" })).status).toBe(201);
    crowd.harness.clock.advanceSeconds(SECONDS_TO_AUGUST);
    const followers = [
      [crowd.ken, "cc_f5f5f5f5-1111-4111-8111-111111111111"],
      [crowd.mike, "cc_f6f6f6f6-1111-4111-8111-111111111111"],
      [crowd.anna, "cc_f7f7f7f7-1111-4111-8111-111111111111"],
      [crowd.lena, "cc_f8f8f8f8-1111-4111-8111-111111111111"],
    ] as const;
    for (const [follower, session] of followers) {
      await augustHint(crowd, follower, session, NICK_CONTEXT);
      expect((await recordOutcome(crowd, follower, { ref: NICK_CONTEXT, outcome: "followed", session })).status).toBe(201);
    }
    await everyoneConfirms(crowd, [crowd.ken, crowd.mike, crowd.anna, crowd.lena]);

    // Act
    crowd.harness.clock.advanceSeconds(31 * DAY_S);
    const credit = (await mine(crowd, crowd.nick))["yourWork"];

    // Assert — the month's own follows print; the late one is one person's: no count
    expect(credit).toMatchObject({
      periodStartIso: "2026-08-01T00:00:00.000Z",
      withheld: null,
      followed: 4,
      late: { withheld: "below_minimums", followed: null },
    });
  }, 120_000);
});
